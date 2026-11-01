/** The game's workstation shell: kubectl, builtins, pipes, redirects, background jobs, history, completion. */
import type { Engine } from './engine.ts';
import { Vfs } from './vfs.ts';
import type { OutputChunk, ShellHost } from './kubectl/context.ts';
import { out, err } from './kubectl/context.ts';
import { tokenize } from './kubectl/args.ts';
import { runKubectl, COMMANDS } from './kubectl/index.ts';
import { clusterHttp } from './container-shell.ts';
import type { PortForward } from './kubectl/commands/logs.ts';
import { requestPod } from './appsim.ts';
import { allResources } from './registry.ts';
import { resolveTargetPort } from './controllers/service.ts';
import type { Pod, Service, Node } from './types.ts';

export interface ExecRecord {
  /** The line as typed. */
  line: string;
  /** The line after $(...) substitution (what actually ran). */
  expanded: string;
  code: number;
  at: number;
  stdout: string;
  stderr: string;
}

export type OutputSink = (chunk: OutputChunk) => void;

interface Stage { argv: string[]; redirect?: { path: string; append: boolean } }

const HELP = `Kubequest workstation shell. Available commands:
  kubectl, k        the Kubernetes CLI (type "kubectl help" for the supported matrix)
  ls, cat, cd, pwd  browse the manifests in your workstation
  vim|nano|edit F   open F in the editor (Ctrl+S to save, Esc to cancel)
  grep, head, tail, wc, sort, uniq    text filters (use with pipes: kubectl get pods | grep web)
  curl URL          HTTP from your workstation (works with port-forward or NodePort/LoadBalancer IPs)
  watch CMD         re-run CMD every 2s (Ctrl+C to stop)
  CMD &             run a long-running command in the background (e.g. port-forward)
  jobs, kill %N     list / stop background jobs
  clear, history, help, alias
`;

export class Shell {
  engine: Engine;
  vfs: Vfs;
  host: ShellHost;
  history: ExecRecord[] = [];
  aliases: Record<string, string> = { k: 'kubectl' };
  env: Record<string, string> = { HOME: '/home/oncall', USER: 'oncall', KUBECONFIG: '/home/oncall/.kube/config' };
  jobs: { id: number; line: string; abort: () => void; done: boolean }[] = [];
  private jobCounter = 0;
  private currentRecord: ExecRecord | undefined;
  /** Called by the UI when a background job prints. */
  onBackgroundOutput: OutputSink | undefined;

  constructor(engine: Engine, vfs: Vfs, host: ShellHost) {
    this.engine = engine;
    this.vfs = vfs;
    this.host = host;
  }

  /** Execute a line; yields output chunks, returns exit code. Records history. */
  async *exec(line: string): AsyncGenerator<OutputChunk, number> {
    const trimmed = line.trim();
    if (!trimmed) return 0;
    const rec: ExecRecord = { line: trimmed, expanded: trimmed, code: 0, at: this.engine.clock.nowMs, stdout: '', stderr: '' };
    this.history.push(rec);
    this.currentRecord = rec;
    let code = 0;
    try {
      const chained = splitChain(trimmed);
      for (const { cmd, op } of chained) {
        if (op === '&&' && code !== 0) continue;
        if (op === '||' && code === 0) continue;
        const gen = this.runPipeline(cmd);
        let r = await gen.next();
        while (!r.done) {
          const chunk = r.value;
          if (chunk.stream === 'stderr') rec.stderr += chunk.text; else rec.stdout += chunk.text;
          yield chunk;
          r = await gen.next();
        }
        code = r.value;
      }
    } catch (e) {
      const msg = `${(e as Error).message}\n`;
      rec.stderr += msg;
      yield err(msg);
      code = 1;
    }
    rec.code = code;
    return code;
  }

  private async *runPipeline(cmdline: string): AsyncGenerator<OutputChunk, number> {
    let background = false;
    let text = cmdline.trim();
    // $(...) command substitution (one level, innermost first)
    for (let guard = 0; guard < 10; guard++) {
      const m = /\$\(([^()]*)\)/.exec(text);
      if (!m) break;
      const sub = this.execStages(parsePipeline(m[1] as string, this.env, this.vfs), this.host, undefined);
      let captured = '';
      let r = await sub.next();
      while (!r.done) { if (r.value.stream === 'stderr') yield r.value; else captured += r.value.text; r = await sub.next(); }
      text = text.slice(0, m.index) + captured.trim().replace(/\s+/g, ' ') + text.slice(m.index + m[0].length);
      if (this.currentRecord) this.currentRecord.expanded = this.currentRecord.expanded.replace(m[0], captured.trim().replace(/\s+/g, ' '));
    }
    if (text.endsWith('&') && !text.endsWith('&&')) { background = true; text = text.slice(0, -1).trim(); }
    const stages = parsePipeline(text, this.env, this.vfs);
    if (background) {
      const id = ++this.jobCounter;
      let aborted = false;
      const parent = this.host;
      const host: ShellHost = {
        sleep: (ms) => parent.backgroundSleep(ms),
        backgroundSleep: (ms) => parent.backgroundSleep(ms),
        editor: (i, f) => parent.editor(i, f),
        readLine: (p) => parent.readLine(p),
        aborted: () => aborted,
      };
      const job = { id, line: text, abort: () => { aborted = true; }, done: false };
      this.jobs.push(job);
      const run = async () => {
        try {
          const gen = this.execStages(stages, host, undefined);
          let r = await gen.next();
          while (!r.done) { this.onBackgroundOutput?.(r.value); r = await gen.next(); }
        } catch (e) { this.onBackgroundOutput?.(err(`${(e as Error).message}\n`)); }
        job.done = true;
        this.onBackgroundOutput?.(out(`[${id}]+  Done                    ${text}\n`));
      };
      void run();
      yield out(`[${id}] ${1000 + id}\n`);
      return 0;
    }
    return yield* this.execStages(stages, this.host, undefined);
  }

  private async *execStages(stages: Stage[], host: ShellHost, stdin: string | undefined): AsyncGenerator<OutputChunk, number> {
    let input = stdin;
    let code = 0;
    for (let i = 0; i < stages.length; i++) {
      const st = stages[i] as Stage;
      const last = i === stages.length - 1;
      const gen = this.runOne(st.argv, host, input);
      if (last && !st.redirect) {
        code = yield* gen;
        continue;
      }
      let collected = '';
      let r = await gen.next();
      while (!r.done) {
        if (r.value.stream === 'stderr') yield r.value; else collected += r.value.text;
        r = await gen.next();
      }
      code = r.value;
      if (st.redirect) {
        if (st.redirect.append) this.vfs.append(st.redirect.path, collected); else this.vfs.write(st.redirect.path, collected);
        collected = '';
      }
      input = collected;
    }
    return code;
  }

  private async *runOne(argvIn: string[], host: ShellHost, stdin: string | undefined): AsyncGenerator<OutputChunk, number> {
    let argv = argvIn;
    if (!argv.length) return 0;
    const alias = this.aliases[argv[0] as string];
    if (alias) argv = [...(tokenize(alias) ?? []), ...argv.slice(1)];
    const [cmd, ...args] = argv as [string, ...string[]];
    switch (cmd) {
      case 'kubectl': return yield* runKubectl(this.engine, this.vfs, host, args, argv.join(' '), stdin);
      case 'ls': {
        const dirs = args.filter((a) => !a.startsWith('-'));
        const long = args.includes('-l') || args.includes('-la') || args.includes('-al');
        const targets = dirs.length ? dirs : ['.'];
        let code = 0;
        for (const t of targets) {
          if (!this.vfs.exists(t)) { yield err(`ls: cannot access '${t}': No such file or directory\n`); code = 2; continue; }
          if (!this.vfs.isDir(t)) { yield out(`${t}\n`); continue; }
          const entries = this.vfs.list(t);
          if (targets.length > 1) yield out(`${t}:\n`);
          if (long) yield out(entries.map((e) => `${e.endsWith('/') ? 'drwxr-xr-x' : '-rw-r--r--'} 1 oncall oncall ${String(this.vfs.read(`${t}/${e}`)?.length ?? 4096).padStart(6)} Oct  5 09:00 ${e.replace(/\/$/, '')}\n`).join(''));
          else if (entries.length) yield out(entries.join('  ') + '\n');
        }
        return code;
      }
      case 'cat': {
        if (!args.length) { if (stdin !== undefined) yield out(stdin); return 0; }
        let code = 0;
        for (const f of args) {
          if (f === '-') { yield out(stdin ?? ''); continue; }
          const c = this.vfs.read(f);
          if (c === undefined) { yield err(this.vfs.isDir(f) ? `cat: ${f}: Is a directory\n` : `cat: ${f}: No such file or directory\n`); code = 1; }
          else yield out(c.endsWith('\n') || c === '' ? c : c + '\n');
        }
        return code;
      }
      case 'cd': {
        const t = args[0] ?? '~';
        if (!this.vfs.isDir(t)) { yield err(`cd: ${t}: No such file or directory\n`); return 1; }
        this.vfs.cwd = this.vfs.resolve(t);
        return 0;
      }
      case 'pwd': yield out(this.vfs.cwd + '\n'); return 0;
      case 'echo': {
        const n = args[0] === '-n';
        const body = (n ? args.slice(1) : args).join(' ');
        yield out(body + (n ? '' : '\n'));
        return 0;
      }
      case 'printf': yield out(args.join(' ').replace(/\\n/g, '\n')); return 0;
      case 'clear': yield { text: '', stream: 'stdout' }; yield { text: '\x1bc', stream: 'stdout' }; return 0;
      case 'help': yield out(HELP); return 0;
      case 'history': yield out(this.history.map((h, i) => `  ${String(i + 1).padStart(3)}  ${h.line}\n`).join('')); return 0;
      case 'alias': {
        if (!args.length) { yield out(Object.entries(this.aliases).map(([k, v]) => `alias ${k}='${v}'\n`).join('')); return 0; }
        for (const a of args) { const i = a.indexOf('='); if (i > 0) this.aliases[a.slice(0, i)] = a.slice(i + 1).replace(/^['"]|['"]$/g, ''); }
        return 0;
      }
      case 'export': { for (const a of args) { const i = a.indexOf('='); if (i > 0) this.env[a.slice(0, i)] = a.slice(i + 1); } return 0; }
      case 'env': case 'printenv': yield out(Object.entries(this.env).map(([k, v]) => `${k}=${v}\n`).join('')); return 0;
      case 'vim': case 'vi': case 'nano': case 'edit': case 'code': {
        const f = args.find((a) => !a.startsWith('-'));
        if (!f) { yield err(`${cmd}: missing file name\n`); return 1; }
        const initial = this.vfs.read(f) ?? '';
        const result = await host.editor(initial, this.vfs.display(f));
        if (result === null) return 0;
        this.vfs.write(f, result);
        yield out(`"${this.vfs.display(f)}" ${result.split('\n').length}L written\n`);
        return 0;
      }
      case 'rm': { let code = 0; for (const f of args.filter((a) => !a.startsWith('-'))) if (!this.vfs.remove(f)) { yield err(`rm: cannot remove '${f}': No such file or directory\n`); code = 1; } return code; }
      case 'cp': case 'mv': {
        const [src, dst] = args.filter((a) => !a.startsWith('-'));
        if (!src || !dst) { yield err(`${cmd}: missing file operand\n`); return 1; }
        const c = this.vfs.read(src);
        if (c === undefined) { yield err(`${cmd}: cannot stat '${src}': No such file or directory\n`); return 1; }
        this.vfs.write(this.vfs.isDir(dst) ? `${dst}/${src.split('/').pop()}` : dst, c);
        if (cmd === 'mv') this.vfs.remove(src);
        return 0;
      }
      case 'mkdir': return 0;
      case 'touch': { for (const f of args) if (!this.vfs.exists(f)) this.vfs.write(f, ''); return 0; }
      case 'grep': return yield* grep(args, stdin, this.vfs);
      case 'head': case 'tail': {
        let n = 10;
        const files: string[] = [];
        for (let i = 0; i < args.length; i++) { const a = args[i] as string; if (a === '-n') n = parseInt(args[++i] ?? '10', 10); else if (/^-n?\d+$/.test(a)) n = parseInt(a.replace(/^-n?/, ''), 10); else if (a === '-f') { /* follow: no-op */ } else files.push(a); }
        const text = files.length ? files.map((f) => this.vfs.read(f) ?? '').join('') : (stdin ?? '');
        const lines = text.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        const sel = cmd === 'head' ? lines.slice(0, n) : lines.slice(-n);
        if (sel.length) yield out(sel.join('\n') + '\n');
        return 0;
      }
      case 'wc': {
        const text = args.filter((a) => !a.startsWith('-')).length ? args.filter((a) => !a.startsWith('-')).map((f) => this.vfs.read(f) ?? '').join('') : (stdin ?? '');
        const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        if (args.includes('-l')) { yield out(`${lines}\n`); return 0; }
        const words = text.split(/\s+/).filter((w) => w).length;
        yield out(`${String(lines).padStart(7)} ${String(words).padStart(7)} ${String(text.length).padStart(7)}\n`);
        return 0;
      }
      case 'sort': { const lines = (stdin ?? '').split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === '')); lines.sort(); if (args.includes('-r')) lines.reverse(); if (lines.length) yield out(lines.join('\n') + '\n'); return 0; }
      case 'uniq': { const lines = (stdin ?? '').split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === '')); const res: string[] = []; for (const l of lines) if (res[res.length - 1] !== l) res.push(l); if (res.length) yield out(res.join('\n') + '\n'); return 0; }
      case 'awk': {
        const prog = args.find((a) => a.includes('{')) ?? '';
        const m = /\{\s*print\s+(.*?)\s*\}/.exec(prog);
        if (!m) { yield err(`awk: kubequest supports only '{print $N}' programs\n`); return 1; }
        const cols = (m[1] as string).split(/[,\s]+/).map((c) => parseInt(c.replace('$', ''), 10));
        const lines = (stdin ?? '').split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
        yield out(lines.map((l) => { const f = l.trim().split(/\s+/); return cols.map((c) => (c === 0 ? l : (f[c - 1] ?? ''))).join(' '); }).join('\n') + (lines.length ? '\n' : ''));
        return 0;
      }
      case 'cut': {
        let delim = '\t';
        let field = 1;
        for (let i = 0; i < args.length; i++) {
          const a = args[i] as string;
          if (a === '-d') delim = args[++i] ?? ' ';
          else if (a.startsWith('-d')) delim = a.slice(2);
          else if (a === '-f') field = parseInt(args[++i] ?? '1', 10);
          else if (a.startsWith('-f')) field = parseInt(a.slice(2), 10);
        }
        const lines = (stdin ?? '').split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
        yield out(lines.map((l) => l.split(delim)[field - 1] ?? '').join('\n') + (lines.length ? '\n' : ''));
        return 0;
      }
      case 'tr': { const [from, to] = args; if (!from || to === undefined) return 1; yield out((stdin ?? '').split(from).join(to)); return 0; }
      case 'xargs': { const sub = args.length ? args : ['echo']; const extra = (stdin ?? '').split(/\s+/).filter((w) => w); return yield* this.runOne([...sub, ...extra], host, undefined); }
      case 'sleep': { const s = parseFloat(args[0] ?? '1'); await host.sleep(s * 1000); return 0; }
      case 'true': return 0;
      case 'false': return 1;
      case 'date': yield out(new Date(this.engine.clock.nowMs).toUTCString().replace('GMT', 'UTC') + '\n'); return 0;
      case 'whoami': yield out('oncall\n'); return 0;
      case 'hostname': yield out('oncall-workstation\n'); return 0;
      case 'which': { const known = ['kubectl', 'curl', 'grep', 'vim', 'nano']; if (args[0] && known.includes(args[0])) { yield out(`/usr/local/bin/${args[0]}\n`); return 0; } return 1; }
      case 'jobs': { yield out(this.jobs.filter((j) => !j.done).map((j) => `[${j.id}]+  Running                 ${j.line} &\n`).join('')); return 0; }
      case 'kill': {
        const target = args.find((a) => a.startsWith('%'));
        const id = target ? parseInt(target.slice(1), 10) : parseInt((args[0] ?? '').replace(/\D/g, ''), 10) - 1000;
        const job = this.jobs.find((j) => j.id === id && !j.done);
        if (!job) { yield err(`kill: ${args[0] ?? ''}: no such job\n`); return 1; }
        job.abort();
        return 0;
      }
      case 'fg': { const job = this.jobs.find((j) => !j.done); if (!job) { yield err('fg: no current job\n'); return 1; } yield out(`${job.line}\n(kubequest: use Ctrl+C to stop it, or "kill %${job.id}")\n`); while (!job.done && !host.aborted()) await host.sleep(200); if (!job.done) job.abort(); return 0; }
      case 'curl': case 'wget': return yield* this.curl(cmd, args);
      case 'watch': {
        const everyIdx = args.indexOf('-n');
        const every = everyIdx >= 0 ? parseFloat(args[everyIdx + 1] ?? '2') * 1000 : 2000;
        const inner = everyIdx >= 0 ? args.filter((_, i) => i !== everyIdx && i !== everyIdx + 1) : args;
        if (!inner.length) { yield err('watch: no command given\n'); return 1; }
        while (!host.aborted()) {
          yield { text: '\x1bc', stream: 'stdout' };
          yield out(`Every ${(every / 1000).toFixed(1)}s: ${inner.join(' ')}\n\n`);
          const stages = parsePipeline(inner.join(' '), this.env, this.vfs);
          yield* this.execStages(stages, host, undefined);
          await host.sleep(every);
        }
        return 0;
      }
      case 'man': yield out(`No manual entry for ${args[0] ?? ''}\n(kubequest: try "kubectl ${args[0] ?? '<cmd>'} --help" or "kubectl explain <resource>")\n`); return 0;
      case 'exit': case 'logout': yield out('(kubequest: this is your on-call workstation — there is nowhere to exit to. Finish the ticket!)\n'); return 0;
      case 'sudo': yield out(`oncall is not in the sudoers file.  This incident will be reported.\n`); return 1;
      case 'docker': case 'podman': yield err(`${cmd}: command not found\n(kubequest: images are built in CI at Orbital Logistics; the registry already has what you need)\n`); return 127;
      case 'helm': case 'kustomize': case 'kind': case 'minikube': case 'k9s': yield err(`${cmd}: command not found\n(kubequest: ${cmd} is covered in a later chapter)\n`); return 127;
      default:
        yield err(`${cmd}: command not found\n`);
        return 127;
    }
  }

  private async *curl(cmd: string, args: string[]): AsyncGenerator<OutputChunk, number> {
    // Flags that consume the next argument (-o FILE, -H HEADER, ...) — skip their values when looking for the URL.
    const valueFlags = new Set(['-o', '-H', '-X', '-d', '--data', '-m', '--max-time', '-u', '-A', '-w', '-e']);
    const url = args.find((a, i) => !a.startsWith('-') && !/^\d+$/.test(a) && !valueFlags.has(args[i - 1] ?? ''));
    if (!url) { yield err(cmd === 'curl' ? "curl: try 'curl --help' for more information\n" : 'wget: missing URL\n'); return 2; }
    const m = /^(?:(https?):\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
    if (!m) { yield err(`curl: (3) URL using bad/illegal format or missing URL\n`); return 3; }
    const host = m[2] as string;
    const port = m[3] ? parseInt(m[3], 10) : 80;
    const path = m[4] ?? '/';
    const headersOnly = args.includes('-I') || args.includes('-i') || args.includes('-v');
    const fail = (code: number, msg: string): OutputChunk => err(cmd === 'wget' ? `wget: unable to resolve host address '${host}'\n` : `curl: (${code}) ${msg}\n`);
    if (host === 'localhost' || host === '127.0.0.1') {
      const forwards = (this.engine.scratch.get('port-forwards') as PortForward[] | undefined) ?? [];
      const f = forwards.find((x) => x.local === port);
      if (!f) { yield fail(7, `Failed to connect to ${host} port ${port} after 0 ms: Couldn't connect to server`); return 7; }
      const pod = f.target.pod ? this.engine.store.getByUid<Pod>(f.target.pod.metadata.uid as string) : undefined;
      if (!pod) { yield fail(52, 'Empty reply from server'); return 52; }
      const r = requestPod(this.engine, pod, f.remote, path);
      if (!r.ok) { yield fail(r.error === 'refused' ? 56 : 28, r.error === 'refused' ? 'Recv failure: Connection reset by peer' : 'Operation timed out'); return r.error === 'refused' ? 56 : 28; }
      if (headersOnly) yield out(`HTTP/1.1 ${r.status} ${r.status === 200 ? 'OK' : r.status === 503 ? 'Service Unavailable' : r.status === 404 ? 'Not Found' : ''}\nContent-Type: text/plain; charset=utf-8\nContent-Length: ${r.body.length}\n\n`);
      yield out(r.body);
      return 0;
    }
    // node IPs with NodePort, LoadBalancer IPs
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      for (const svc of this.engine.store.list<Service>('Service')) {
        const lbIp = svc.status.loadBalancer?.ingress?.[0]?.ip;
        const isNode = this.engine.store.list('Node').some((n) => (n as unknown as Node).status.addresses.some((a) => a.address === host));
        const sp = (svc.spec.ports ?? []).find((p) => (lbIp === host && p.port === port) || (isNode && p.nodePort === port));
        if (!sp) continue;
        const r = clusterHttp(this.engine, svc.metadata.namespace as string, `${svc.spec.clusterIP}:${sp.port}${path}`);
        for (const c of r.chunks) yield c;
        return r.code;
      }
      if (this.engine.store.list('Node').some((n) => (n as unknown as Node).status.addresses.some((a) => a.address === host))) { yield fail(7, `Failed to connect to ${host} port ${port} after 3 ms: Couldn't connect to server`); return 7; }
      yield fail(28, `Failed to connect to ${host} port ${port} after 5000 ms: Connection timed out`); return 28;
    }
    // service DNS names do not resolve from the workstation (outside the cluster) — a classic lesson
    yield fail(6, `Could not resolve host: ${host}`);
    return 6;
  }

  /** Tab completion candidates for the current line. */
  complete(line: string): { candidates: string[]; prefix: string } {
    const tokens = line.split(/\s+/);
    const current = tokens[tokens.length - 1] ?? '';
    const before = tokens.slice(0, -1);
    let cands: string[] = [];
    const first = before[0] ? (this.aliases[before[0]] ?? before[0]) : undefined;
    if (before.length === 0) {
      cands = ['kubectl', 'k', 'ls', 'cat', 'cd', 'vim', 'nano', 'grep', 'curl', 'watch', 'clear', 'help', 'history', 'jobs'];
    } else if (first === 'kubectl') {
      const sub = before[1];
      const resourceWords = allResources().flatMap((r) => [r.plural, ...r.shortNames]);
      if (!sub) cands = COMMANDS.map((c) => c.name);
      else if (current.startsWith('-')) {
        const cmd = COMMANDS.find((c) => c.name === sub);
        cands = [...(cmd?.flags ?? []).map((f) => `--${f.name}`), '--namespace', '-n', '-A', '-o'];
      } else if (sub === 'rollout' && before.length === 2) cands = ['status', 'history', 'undo', 'restart', 'pause', 'resume'];
      else if (sub === 'config' && before.length === 2) cands = ['current-context', 'get-contexts', 'use-context', 'set-context', 'view'];
      else if (sub === 'set' && before.length === 2) cands = ['image', 'env', 'resources'];
      else if (sub === 'create' && before.length === 2) cands = ['namespace', 'deployment', 'configmap', 'secret', 'job', 'cronjob', 'service', '-f'];
      else if (['get', 'describe', 'delete', 'edit', 'scale', 'label', 'annotate', 'expose', 'top', 'wait', 'explain'].includes(sub) || (['rollout', 'set', 'logs', 'exec', 'port-forward'].includes(sub))) {
        const prevTok = before[before.length - 1] as string;
        const ns = (() => { const i = before.indexOf('-n'); if (i >= 0 && before[i + 1]) return before[i + 1]; const j = before.findIndex((t) => t.startsWith('--namespace=')); if (j >= 0) return (before[j] as string).split('=')[1]; return this.engine.currentNamespace; })();
        if (prevTok === '-n' || prevTok === '--namespace') cands = this.engine.store.list('Namespace').map((n) => n.metadata.name);
        else if (prevTok === '-f' || prevTok === '--filename') cands = this.vfs.list('.');
        else if (sub === 'logs' || sub === 'exec' || sub === 'port-forward') cands = this.engine.store.list('Pod', ns).map((p) => p.metadata.name);
        else if (current.includes('/')) {
          const [t] = current.split('/') as [string];
          const res = allResources().find((r) => r.plural === t || r.shortNames.includes(t) || r.singular === t);
          if (res) cands = this.engine.store.list(res.kind, res.namespaced ? ns : undefined).map((o) => `${t}/${o.metadata.name}`);
        } else {
          const lastType = [...before].reverse().find((t) => resourceWords.includes(t) || t === 'all');
          const res = lastType ? allResources().find((r) => r.plural === lastType || r.shortNames.includes(lastType) || r.singular === lastType) : undefined;
          if (res && before.indexOf(lastType as string) >= 2) cands = this.engine.store.list(res.kind, res.namespaced ? ns : undefined).map((o) => o.metadata.name);
          else cands = [...resourceWords, 'all'];
        }
      }
    } else if (['cat', 'vim', 'vi', 'nano', 'edit', 'ls', 'cd', 'rm', 'cp', 'mv'].includes(first ?? '')) {
      cands = this.vfs.list(current.includes('/') ? current.slice(0, current.lastIndexOf('/') + 1) : '.').map((e) => (current.includes('/') ? current.slice(0, current.lastIndexOf('/') + 1) + e : e));
    }
    const matching = [...new Set(cands)].filter((c) => c.startsWith(current)).sort();
    return { candidates: matching, prefix: current };
  }
}

function splitChain(line: string): { cmd: string; op: '' | '&&' | '||' | ';' }[] {
  const outArr: { cmd: string; op: '' | '&&' | '||' | ';' }[] = [];
  let cur = '';
  let op: '' | '&&' | '||' | ';' = '';
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (line.startsWith('&&', i)) { outArr.push({ cmd: cur, op }); cur = ''; op = '&&'; i++; continue; }
    if (line.startsWith('||', i)) { outArr.push({ cmd: cur, op }); cur = ''; op = '||'; i++; continue; }
    if (ch === ';') { outArr.push({ cmd: cur, op }); cur = ''; op = ';'; continue; }
    cur += ch;
  }
  outArr.push({ cmd: cur, op });
  return outArr.filter((c) => c.cmd.trim() !== '');
}

function parsePipeline(text: string, env: Record<string, string>, vfs: Vfs): Stage[] {
  const parts: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (const ch of text) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '|') { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  if (q) throw new Error('syntax error: unterminated quoted string');
  return parts.map((p) => {
    let redirect: Stage['redirect'];
    let body = p;
    const m = /(>>|>)\s*([^\s>]+)\s*$/.exec(p);
    if (m) { redirect = { path: m[2] as string, append: m[1] === '>>' }; body = p.slice(0, m.index); }
    const expanded = body.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (full, k: string) => (env[k] !== undefined ? env[k] : full));
    const tokens = tokenize(expanded);
    if (tokens === null) throw new Error('syntax error: unterminated quoted string');
    // glob expansion for VFS paths
    const argv = tokens.flatMap((t) => (/[*?]/.test(t) && !t.startsWith('-') ? (vfs.glob(t).length ? vfs.glob(t).map((g) => vfs.display(g)) : [t]) : [t]));
    return { argv, redirect };
  });
}

async function* grep(args: string[], stdin: string | undefined, vfs: Vfs): AsyncGenerator<OutputChunk, number> {
  let ignoreCase = false, invert = false, count = false, extended = false, lineNo = false, only = false;
  let after = 0, before = 0;
  let pattern: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '-e') { pattern = args[++i]; continue; }
    if (a.startsWith('-') && a.length > 1 && pattern === undefined || (a.startsWith('-') && !/^-\d/.test(a) && a.length > 1 && /^-[ivcEnoABC]+$/.test(a))) {
      if (a === '-A' || a === '-B' || a === '-C') { const n = parseInt(args[++i] ?? '0', 10); if (a !== '-B') after = n; if (a !== '-A') before = n; continue; }
      for (const f of a.slice(1)) {
        if (f === 'i') ignoreCase = true; else if (f === 'v') invert = true; else if (f === 'c') count = true; else if (f === 'E') extended = true; else if (f === 'n') lineNo = true; else if (f === 'o') only = true;
        else if (/\d/.test(f)) { after = before = parseInt(a.slice(1), 10); break; }
        else { yield err(`grep: invalid option -- '${f}'\n`); return 2; }
      }
      continue;
    }
    if (pattern === undefined) pattern = a; else files.push(a);
  }
  if (pattern === undefined) { yield err('Usage: grep [OPTION]... PATTERNS [FILE]...\n'); return 2; }
  let re: RegExp;
  try { re = new RegExp(extended ? pattern : pattern.replace(/[+?(){}|]/g, '\\$&'), ignoreCase ? 'i' : ''); } catch { yield err(`grep: Invalid regular expression\n`); return 2; }
  const text = files.length ? files.map((f) => vfs.read(f) ?? '').join('') : (stdin ?? '');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const matched: number[] = [];
  lines.forEach((l, i) => { if (re.test(l) !== invert) matched.push(i); });
  if (count) { yield out(`${matched.length}\n`); return matched.length ? 0 : 1; }
  const show = new Set<number>();
  for (const i of matched) for (let j = Math.max(0, i - before); j <= Math.min(lines.length - 1, i + after); j++) show.add(j);
  const result = [...show].sort((a, b) => a - b).map((i) => {
    const l = lines[i] as string;
    const body = only ? (re.exec(l)?.[0] ?? '') : l;
    return lineNo ? `${i + 1}:${body}` : body;
  });
  if (result.length) yield out(result.join('\n') + '\n');
  return matched.length ? 0 : 1;
}
