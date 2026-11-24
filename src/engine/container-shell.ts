/** The shell "inside" a container: a tiny busybox-like environment for `kubectl exec` and `kubectl run -it`. */
import type { Engine } from './engine.ts';
import type { Pod, Container } from './types.ts';
import type { OutputChunk, ShellHost } from './kubectl/context.ts';
import { out, err } from './kubectl/context.ts';
import { resolveDns } from './controllers/service.ts';
import { runCurl } from './http.ts';
import { dnsAllowed } from './netpol.ts';
import { containerFiles, writeContainerFile } from './containerfs.ts';
import { tokenize } from './kubectl/args.ts';

export interface ExecResult { chunks: OutputChunk[]; code: number }

function containerRuntime(engine: Engine, pod: Pod, container: string) {
  return engine.podRuntime(pod).containers.find((c) => c.name === container);
}

function containerSpec(pod: Pod, container: string): Container | undefined {
  return [...pod.spec.containers, ...(pod.spec.initContainers ?? []), ...(pod.spec.ephemeralContainers ?? [])].find((c) => c.name === container);
}

/** The uid the container's process runs as: securityContext wins over the image's USER. */
export function containerUid(pod: Pod, container: string, imageUser: number | undefined): number {
  return containerSpec(pod, container)?.securityContext?.runAsUser ?? pod.spec.securityContext?.runAsUser ?? imageUser ?? 0;
}

function baseFiles(engine: Engine, pod: Pod, container: string): Map<string, string> {
  const spec = containerSpec(pod, container);
  const rt = containerRuntime(engine, pod, container);
  const files = new Map<string, string>();
  files.set('/etc/hostname', pod.metadata.name + '\n');
  files.set('/etc/hosts', `# Kubernetes-managed hosts file.\n127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n${pod.status.podIP ?? ''}\t${pod.metadata.name}\n`);
  files.set('/etc/resolv.conf', `search ${pod.metadata.namespace}.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.96.0.10\noptions ndots:5\n`);
  if (pod.spec.automountServiceAccountToken !== false) {
    files.set('/var/run/secrets/kubernetes.io/serviceaccount/namespace', pod.metadata.namespace ?? 'default');
    files.set('/var/run/secrets/kubernetes.io/serviceaccount/token', 'eyJhbGciOiJSUzI1NiIsImtpZCI6Ik...(redacted)');
  }
  for (const [k, v] of containerFiles(engine, pod, spec, rt)) files.set(k, v);
  // an ephemeral debug container that targets another container shares its process namespace:
  // the target's root filesystem is reachable through /proc/1/root, its environment through /proc/1/environ
  const target = spec?.targetContainerName;
  if (target) {
    const tSpec = containerSpec(pod, target), tRt = containerRuntime(engine, pod, target);
    for (const [k, v] of containerFiles(engine, pod, tSpec, tRt)) files.set(`/proc/1/root${k}`, v);
    files.set('/proc/1/environ', Object.entries(tRt?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    files.set('/proc/1/cmdline', `${tSpec?.command?.join(' ') ?? '/app/server'}\n`);
  }
  return files;
}

/** Split a shell script into steps on `;`, `&&` and newlines (outside quotes); loops stay whole. `&&` steps keep the prefix. */
export function splitScript(text: string): string[] {
  const steps: string[] = [];
  let cur = '', q: string | null = null, depth = 0, prefix = '';
  const push = (): void => { const t = cur.trim(); if (t) steps.push(prefix + t); cur = ''; prefix = ''; };
  const src = text.replace(/\\\n/g, ' ');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    const word = /^(until|while|for)\b/.exec(src.slice(i));
    if (word && cur.trim() === '') depth++;
    if (depth > 0) {
      cur += ch;
      if (/(^|[\s;])done$/.test(cur)) { depth--; if (depth === 0) push(); }
      continue;
    }
    if (ch === ';' || ch === '\n') { push(); continue; }
    if (src.startsWith('&&', i)) { push(); prefix = '&&'; i++; continue; }
    cur += ch;
  }
  push();
  return steps;
}

/** Run one shell line inside the container, honouring `> file` / `>> file` redirection and `a; b` / `a && b`. */
export function execLine(engine: Engine, pod: Pod, container: string, line: string): ExecResult {
  const steps = splitScript(line);
  if (steps.length > 1) {
    const chunks: OutputChunk[] = [];
    let code = 0;
    for (const raw of steps) {
      const and = raw.startsWith('&&');
      if (and && code !== 0) continue;
      const r = execLine(engine, pod, container, and ? raw.slice(2) : raw);
      chunks.push(...r.chunks);
      code = r.code;
    }
    return { chunks, code };
  }
  const one = (steps[0] ?? '').trim();
  const m = /^([\s\S]*?)\s*(>>|>)\s*(\S+)\s*$/.exec(one);
  const quotes = (one.match(/["']/g) ?? []).length;
  if (m && (quotes === 0 || !/["'][^"']*>[^"']*["']\s*$/.test(one))) {
    const r = execInContainer(engine, pod, container, tokenize(m[1] as string) ?? []);
    const text = r.chunks.filter((c) => c.stream !== 'stderr').map((c) => c.text).join('');
    const rt = containerRuntime(engine, pod, container), spec = containerSpec(pod, container);
    const path = (m[3] as string).startsWith('/') ? (m[3] as string) : `/${m[3]}`;
    if (path !== '/dev/null' && rt && spec) {
      const e = writeContainerFile(engine, pod, spec, rt, path, text, m[2] === '>>');
      if (e) return { chunks: [err(`sh: can't create ${m[3]}: ${e}\n`)], code: 1 };
    }
    return { chunks: r.chunks.filter((c) => c.stream === 'stderr'), code: r.code };
  }
  return execInContainer(engine, pod, container, tokenize(one) ?? []);
}

/** Run one command inside the container (non-interactive). */
export function execInContainer(engine: Engine, pod: Pod, container: string, argv: string[]): ExecResult {
  const rt = containerRuntime(engine, pod, container);
  const b = rt?.behaviour;
  const files = baseFiles(engine, pod, container);
  const env = rt?.env ?? {};
  const [cmd, ...args] = argv;
  if (!cmd) return { chunks: [], code: 0 };
  const notFound = (c: string): ExecResult => ({ chunks: [err(`OCI runtime exec failed: exec failed: unable to start container process: exec: "${c}": executable file not found in $PATH: unknown\n`)], code: 126 });
  if (b && b.hasShell === false && !['env', 'printenv'].includes(cmd)) return notFound(cmd);
  switch (cmd) {
    case 'sh': case 'bash': case '/bin/sh': case '/bin/bash': {
      if (args[0] === '-c' && args[1] !== undefined) return execLine(engine, pod, container, args[1]);
      return { chunks: [], code: 0 };
    }
    case 'env': case 'printenv': {
      if (cmd === 'printenv' && args[0]) return env[args[0]] !== undefined ? { chunks: [out(env[args[0]] + '\n')], code: 0 } : { chunks: [], code: 1 };
      return { chunks: [out(Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')], code: 0 };
    }
    case 'echo': return { chunks: [out(args.map((a) => a.replace(/^\$(\w+)$/, (_m, k: string) => env[k] ?? '')).join(' ') + '\n')], code: 0 };
    case 'hostname': return { chunks: [out(pod.metadata.name + '\n')], code: 0 };
    case 'id': { const uid = containerUid(pod, container, b?.user); const gid = containerSpec(pod, container)?.securityContext?.runAsGroup ?? pod.spec.securityContext?.runAsGroup ?? (uid === 0 ? 0 : uid); return { chunks: [out(uid === 0 ? 'uid=0(root) gid=0(root) groups=0(root)\n' : `uid=${uid} gid=${gid} groups=${gid}\n`)], code: 0 }; }
    case 'whoami': { const uid = containerUid(pod, container, b?.user); return uid === 0 ? { chunks: [out('root\n')], code: 0 } : { chunks: [err(`whoami: unknown uid ${uid}\n`)], code: 1 }; }
    case 'touch': case 'mkdir': case 'rm': case 'cp': case 'tee': {
      const rt2 = containerRuntime(engine, pod, container), spec2 = containerSpec(pod, container);
      const paths = args.filter((x) => !x.startsWith('-')).map((x) => (x.startsWith('/') ? x : `/${x}`));
      if (!rt2 || !spec2 || !paths.length) return { chunks: [err(`${cmd}: missing operand\n`)], code: 1 };
      if (cmd === 'mkdir') return { chunks: [], code: 0 };
      if (cmd === 'cp') {
        const src = files.get(paths[0] as string);
        if (src === undefined || paths.length < 2) return { chunks: [err(`cp: can't stat '${args[0] ?? ''}': No such file or directory\n`)], code: 1 };
        const e = writeContainerFile(engine, pod, spec2, rt2, paths[1] as string, src);
        return e ? { chunks: [err(`cp: can't create '${paths[1]}': ${e}\n`)], code: 1 } : { chunks: [], code: 0 };
      }
      if (cmd === 'rm') return { chunks: [], code: 0 };
      for (const p of paths) {
        if (cmd === 'touch' && files.has(p)) continue;
        const e = writeContainerFile(engine, pod, spec2, rt2, p, '');
        if (e) return { chunks: [err(`${cmd}: ${p}: ${e}\n`)], code: 1 };
      }
      return { chunks: [], code: 0 };
    }
    case 'test': case '[': {
      const flag = args[0], target = args[1] ?? '';
      const p = target.startsWith('/') ? target : `/${target}`;
      const isDir = [...files.keys()].some((k) => k.startsWith(p.replace(/\/$/, '') + '/'));
      const ok = flag === '-f' ? files.has(p) : flag === '-d' ? isDir : flag === '-e' ? files.has(p) || isDir : flag === '-n' ? target !== '' && target !== ']' : flag === '-z' ? target === '' || target === ']' : false;
      return { chunks: [], code: ok ? 0 : 1 };
    }
    case 'nc': {
      // `nc -z host port`: is the port reachable?
      const rest = args.filter((x, i) => !x.startsWith('-') && !['-w', '-q', '-s', '-p'].includes(args[i - 1] ?? ''));
      const r = runCurl(engine, { pod }, 'curl', ['-s', `${rest[0] ?? ''}:${rest[1] ?? '80'}`]);
      // refused answers at once; a filtered port (NetworkPolicy) only fails when the -w timeout expires
      return { chunks: args.includes('-v') ? [err(r.code === 0 ? `${rest[0]} (${rest[1]}) open\n` : r.code === 28 ? 'nc: timed out\n' : `nc: ${rest[0]} (${rest[1]}): Connection refused\n`)] : r.code === 6 ? [err(`nc: bad address '${rest[0] ?? ''}'\n`)] : [], code: r.code === 0 ? 0 : 1 };
    }
    case 'pwd': return { chunks: [out('/\n')], code: 0 };
    case 'uname': return { chunks: [out(args.includes('-a') ? `Linux ${pod.metadata.name} 6.8.0-142-generic #1 SMP x86_64 GNU/Linux\n` : 'Linux\n')], code: 0 };
    case 'ps': {
      const target = containerSpec(pod, container)?.targetContainerName;
      const tSpec = target ? containerSpec(pod, target) : undefined;
      const uidOf = (name: string): string => { const u = containerUid(pod, name, containerRuntime(engine, pod, name)?.behaviour?.user); return u === 0 ? 'root' : String(u); };
      const main = target ? `    1 ${uidOf(target).padEnd(8)} 0:01 ${[...(tSpec?.command ?? ['/app/server']), ...(tSpec?.args ?? [])].join(' ')}\n` : `    1 ${uidOf(container).padEnd(8)} 0:00 ${[...(containerSpec(pod, container)?.command ?? [b && !b.interpreter ? '/app/server' : 'sh']), ...(containerSpec(pod, container)?.args ?? [])].join(' ')}\n`;
      return { chunks: [out(`PID   USER     TIME  COMMAND\n${main}${target ? `   14 ${uidOf(container).padEnd(8)} 0:00 sh\n` : ''}   21 ${uidOf(container).padEnd(8)} 0:00 ${argv.join(' ')}\n`)], code: 0 };
    }
    case 'cat': {
      if (!args.length) return { chunks: [], code: 0 };
      const chunks: OutputChunk[] = [];
      let code = 0;
      for (const f of args) {
        const p = f.startsWith('/') ? f : `/${f}`;
        const v = files.get(p);
        if (v === undefined) { chunks.push(err(`cat: can't open '${f}': No such file or directory\n`)); code = 1; }
        else chunks.push(out(v.endsWith('\n') ? v : v + '\n'));
      }
      return { chunks, code };
    }
    case 'ls': {
      const dirArg = args.find((a) => !a.startsWith('-')) ?? '/';
      const dir = dirArg.replace(/\/$/, '') || '/';
      const names = new Set<string>();
      const base = ['bin', 'dev', 'etc', 'home', 'lib', 'proc', 'root', 'sys', 'tmp', 'usr', 'var'];
      if (dir === '/') for (const b2 of base) names.add(b2);
      for (const k of files.keys()) {
        const prefix = dir === '/' ? '/' : dir + '/';
        if (k.startsWith(prefix)) { const rest = k.slice(prefix.length); names.add(rest.split('/')[0] as string); }
      }
      if (!names.size && !files.has(dir)) return { chunks: [err(`ls: ${dirArg}: No such file or directory\n`)], code: 1 };
      if (files.has(dir)) return { chunks: [out(dirArg + '\n')], code: 0 };
      return { chunks: [out([...names].sort().join('\n') + '\n')], code: 0 };
    }
    case 'nslookup': case 'dig': case 'host': {
      const name = args.find((a) => !a.startsWith('-'));
      if (!name) return { chunks: [err(`nslookup: missing host name\n`)], code: 1 };
      if (!dnsAllowed(engine, pod)) return { chunks: [err(';; connection timed out; no servers could be reached\n\n')], code: 1 };
      const r = resolveDns(engine, name, pod.metadata.namespace ?? 'default');
      if (!r || !r.svc) return { chunks: [out(`Server:\t\t10.96.0.10\nAddress:\t10.96.0.10:53\n\n`), err(`** server can't find ${name}: NXDOMAIN\n\n`)], code: 1 };
      const fq = `${r.svc.metadata.name}.${r.svc.metadata.namespace}.svc.cluster.local`;
      const isPodRecord = !!r.pod && !r.ips;
      const fqdn = isPodRecord ? `${name.split('.')[0]}.${fq}` : fq;
      return { chunks: [out(`Server:\t\t10.96.0.10\nAddress:\t10.96.0.10:53\n\n${(r.ips ?? [r.ip]).map((ip) => `Name:\t${fqdn}\nAddress: ${ip}\n`).join('')}\n`)], code: 0 };
    }
    case 'curl': case 'wget': {
      const r = runCurl(engine, { pod }, cmd, args);
      return { chunks: r.chunks, code: r.code };
    }
    case 'sleep': return { chunks: [], code: 0 };
    case 'true': return { chunks: [], code: 0 };
    case 'false': return { chunks: [], code: 1 };
    case 'exit': return { chunks: [], code: parseInt(args[0] ?? '0', 10) || 0 };
    case 'date': return { chunks: [out(new Date(engine.clock.nowMs).toUTCString().replace('GMT', 'UTC') + '\n')], code: 0 };
    case 'df': return { chunks: [out('Filesystem           1K-blocks      Used Available Use% Mounted on\noverlay               61202244  12345678  45678901  21% /\n')], code: 0 };
    case 'free': return { chunks: [out(`              total        used        free      shared  buff/cache   available\nMem:        8388608     ${(rt?.memoryMiB ?? 0) * 1024}     ${8388608 - (rt?.memoryMiB ?? 0) * 1024}           0           0     ${8388608 - (rt?.memoryMiB ?? 0) * 1024}\n`)], code: 0 };
    case 'kill': return { chunks: [], code: 0 };
    case 'which': return (args[0] && ['sh', 'ls', 'cat', 'env', 'curl', 'wget', 'nslookup'].includes(args[0])) ? { chunks: [out(`/bin/${args[0]}\n`)], code: 0 } : { chunks: [], code: 1 };
    default:
      return notFound(cmd);
  }
}

/** Interactive session: prompt loop until exit/EOF. */
export async function* interactiveShell(engine: Engine, host: ShellHost, pod: Pod, container: string, argv: string[]): AsyncGenerator<OutputChunk, number> {
  const cmd = argv[0] ?? 'sh';
  if (!['sh', 'bash', '/bin/sh', '/bin/bash', 'ash'].includes(cmd)) {
    const r = execInContainer(engine, pod, container, argv);
    for (const c of r.chunks) yield c;
    return r.code;
  }
  const rt = containerRuntime(engine, pod, container);
  if (rt?.behaviour && rt.behaviour.hasShell === false) {
    yield err(`OCI runtime exec failed: exec failed: unable to start container process: exec: "${cmd}": executable file not found in $PATH: unknown\n`);
    return 126;
  }
  let code = 0;
  while (!host.aborted()) {
    const line = await host.readLine('/ # ');
    if (line === null) break;
    const tokens = tokenize(line) ?? [];
    if (!tokens.length) continue;
    if (tokens[0] === 'exit') { code = parseInt(tokens[1] ?? '0', 10) || 0; break; }
    const live = engine.store.getByUid<Pod>(pod.metadata.uid as string);
    if (!live) { yield err('command terminated with exit code 137\n'); return 137; }
    const r = execLine(engine, live, container, line);
    for (const c of r.chunks) yield c;
    code = r.code;
  }
  return code;
}
