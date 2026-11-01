import type { KubectlCommand, CommandContext, OutputChunk } from '../context.ts';
import { out, err } from '../context.ts';
import { str, bool, KubectlError } from '../args.ts';
import { parseResourceArgs, fetch, getPath } from '../resources.ts';
import { allResources, apiVersionOf, qualifiedName } from '../../registry.ts';
import type { KubeObject, Pod, Node, Deployment } from '../../types.ts';
import { tabwrite } from '../tabwriter.ts';
import { parseGoDuration, formatCpuMillis, parseCpuMillis, parseMemoryBytes } from '../../duration.ts';
import { podUsage } from '../../controllers/kubelet.ts';
import { EXPLAIN_DOCS } from '../explain-docs.ts';
import { COMMAND_MATRIX } from '../help-text.ts';
import { stringify } from '../../yaml.ts';

function table(rows: string[][]): string {
  return tabwrite(rows.map((r) => r.join('\t')).join('\n') + '\n', { minwidth: 6, tabwidth: 4, padding: 3 });
}

export const configCommand: KubectlCommand = {
  name: 'config',
  summary: 'Modify kubeconfig files',
  usage: 'kubectl config SUBCOMMAND (current-context|get-contexts|use-context|set-context|view|get-clusters)',
  flags: [
    { name: 'current', type: 'bool' },
    { name: 'minify', type: 'bool' },
    { name: 'output', short: 'o', type: 'string' },
    { name: 'cluster', type: 'string' },
    { name: 'user', type: 'string' },
    { name: 'no-headers', type: 'bool' },
    { name: 'raw', type: 'bool' },
    { name: 'flatten', type: 'bool' },
  ],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    const e = ctx.engine;
    const sub = a.positional[0];
    const ctxName = 'kubequest';
    switch (sub) {
      case 'current-context': yield out(`${ctxName}\n`); return 0;
      case 'get-contexts': {
        if (a.positional[1] && a.positional[1] !== ctxName) throw new KubectlError(`context ${a.positional[1]} not found`);
        const rows = [['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'], ['*', ctxName, e.clusterName, `oncall@${e.clusterName}`, e.currentNamespace]];
        yield out(table(bool(a, 'no-headers') ? rows.slice(1) : rows));
        return 0;
      }
      case 'get-clusters': yield out(`NAME\n${e.clusterName}\n`); return 0;
      case 'use-context': {
        const n = a.positional[1];
        if (!n) throw new KubectlError('Unexpected args: []');
        if (n !== ctxName) throw new KubectlError(`no context exists with the name: "${n}"`);
        yield out(`Switched to context "${n}".\n`);
        return 0;
      }
      case 'set-context': {
        const target = bool(a, 'current') ? ctxName : a.positional[1];
        if (!target) throw new KubectlError('Unexpected args: []\nYou must specify a non-empty context name or --current');
        if (target !== ctxName) throw new KubectlError(`kubequest: only the "${ctxName}" context exists in this cluster`);
        const ns = str(a, 'namespace');
        if (ns !== undefined) e.currentNamespace = ns;
        yield out(`Context "${ctxName}" modified.\n`);
        return 0;
      }
      case 'view': {
        const cfg = {
          apiVersion: 'v1',
          clusters: [{ cluster: { 'certificate-authority-data': 'DATA+OMITTED', server: 'https://127.0.0.1:6443' }, name: e.clusterName }],
          contexts: [{ context: { cluster: e.clusterName, namespace: e.currentNamespace, user: `oncall@${e.clusterName}` }, name: ctxName }],
          'current-context': ctxName,
          kind: 'Config',
          preferences: {},
          users: [{ name: `oncall@${e.clusterName}`, user: { 'client-certificate-data': 'DATA+OMITTED', 'client-key-data': 'DATA+OMITTED' } }],
        };
        yield out(stringify(cfg as never));
        return 0;
      }
      case undefined: throw new KubectlError('kubectl config SUBCOMMAND: use current-context, get-contexts, use-context, set-context --current --namespace=NS, or view');
      default: throw new KubectlError(`kubequest: "config ${sub}" is not supported in the simulator yet`);
    }
  },
};

export const versionCommand: KubectlCommand = {
  name: 'version',
  summary: 'Print the client and server version information',
  usage: 'kubectl version [flags]',
  flags: [{ name: 'client', type: 'bool' }, { name: 'output', short: 'o', type: 'string' }, { name: 'short', type: 'bool' }],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const v = ctx.engine.version;
    if (str(ctx.args, 'output') === 'yaml' || str(ctx.args, 'output') === 'json') {
      const data = { clientVersion: { gitVersion: v, major: v.split('.')[0]!.slice(1), minor: v.split('.')[1], platform: 'linux/amd64' }, kustomizeVersion: 'v5.5.0', serverVersion: { gitVersion: v, major: v.split('.')[0]!.slice(1), minor: v.split('.')[1], platform: 'linux/amd64' } };
      yield out(str(ctx.args, 'output') === 'yaml' ? stringify(data as never) : JSON.stringify(data, null, 2) + '\n');
      return 0;
    }
    yield out(`Client Version: ${v}\nKustomize Version: v5.5.0\n${bool(ctx.args, 'client') ? '' : `Server Version: ${v}\n`}`);
    return 0;
  },
};

export const clusterInfoCommand: KubectlCommand = {
  name: 'cluster-info',
  summary: 'Display cluster information',
  usage: 'kubectl cluster-info [flags]',
  flags: [],
  run: async function* (): AsyncGenerator<OutputChunk, number> {
    yield out(`Kubernetes control plane is running at https://127.0.0.1:6443\nCoreDNS is running at https://127.0.0.1:6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy\n\nTo further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.\n`);
    return 0;
  },
};

export const apiResourcesCommand: KubectlCommand = {
  name: 'api-resources',
  summary: 'Print the supported API resources on the server',
  usage: 'kubectl api-resources [flags]',
  flags: [{ name: 'namespaced', type: 'string', noOptDefault: 'true' }, { name: 'api-group', type: 'string' }, { name: 'output', short: 'o', type: 'string' }, { name: 'no-headers', type: 'bool' }, { name: 'verbs', type: 'strings' }, { name: 'sort-by', type: 'string' }],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    let rs = allResources();
    const nsf = str(a, 'namespaced');
    if (nsf !== undefined) rs = rs.filter((r) => r.namespaced === (nsf === 'true'));
    const g = str(a, 'api-group');
    if (g !== undefined) rs = rs.filter((r) => r.group === g);
    const wide = str(a, 'output') === 'wide';
    const rows: string[][] = [['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND', ...(wide ? ['VERBS', 'CATEGORIES'] : [])]];
    const sorted = [...rs].sort((x, y) => (x.group < y.group ? -1 : x.group > y.group ? 1 : x.plural < y.plural ? -1 : 1));
    for (const r of sorted) rows.push([r.plural, r.shortNames.join(','), apiVersionOf(r), String(r.namespaced), r.kind, ...(wide ? [r.verbs.join(','), r.categories.join(',')] : [])]);
    yield out(table(bool(a, 'no-headers') ? rows.slice(1) : rows));
    return 0;
  },
};

export const explainCommand: KubectlCommand = {
  name: 'explain',
  summary: 'Get documentation for a resource',
  usage: 'kubectl explain TYPE[.FIELDPATH] [flags]',
  flags: [{ name: 'recursive', type: 'bool' }, { name: 'api-version', type: 'string' }, { name: 'output', type: 'string' }],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const path = ctx.args.positional[0];
    if (!path) throw new KubectlError('You must specify the type of resource to explain. Use "kubectl api-resources" for a complete list of supported resources.');
    const [typeName, ...fieldPath] = path.split('.');
    const ref = parseResourceArgs([typeName as string])[0]!;
    const docs = EXPLAIN_DOCS[ref.info.kind];
    if (!docs) throw new KubectlError(`kubequest: no documentation bundled for ${ref.info.kind} yet`);
    let node = docs;
    const walked: string[] = [];
    for (const f of fieldPath) {
      const next = node.fields?.[f];
      if (!next) throw new KubectlError(`field "${f}" does not exist`);
      walked.push(f);
      node = next;
    }
    let text = `KIND:       ${ref.info.kind}\nVERSION:    ${apiVersionOf(ref.info)}\n\n`;
    if (walked.length) text += `FIELD: ${walked[walked.length - 1]} <${node.type}>\n\n`;
    text += `DESCRIPTION:\n${node.description.split('\n').map((l) => '    ' + l).join('\n')}\n`;
    if (node.fields) {
      text += `\nFIELDS:\n`;
      for (const [k, v] of Object.entries(node.fields)) text += `  ${k}\t<${v.type}>${v.required ? ' -required-' : ''}\n${v.description.split('\n').slice(0, 2).map((l) => '    ' + l).join('\n')}\n\n`;
    }
    yield out(tabwrite(text, { minwidth: 0, tabwidth: 8, padding: 1 }));
    return 0;
  },
};

export const topCommand: KubectlCommand = {
  name: 'top',
  summary: 'Display resource (CPU/memory) usage',
  usage: 'kubectl top (node|pod) [NAME | -l label] [flags]',
  flags: [{ name: 'all-namespaces', short: 'A', type: 'bool' }, { name: 'selector', short: 'l', type: 'string' }, { name: 'containers', type: 'bool' }, { name: 'no-headers', type: 'bool' }, { name: 'sort-by', type: 'string' }, { name: 'sum', type: 'bool' }],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    const sub = a.positional[0];
    const allNs = bool(a, 'all-namespaces');
    if (sub === 'pod' || sub === 'pods' || sub === 'po') {
      const ref = parseResourceArgs(a.positional[1] ? ['pods', a.positional[1]] : ['pods'])[0]!;
      const pods = fetch(ctx.engine, ref, ctx.namespace, allNs, str(a, 'selector')) as Pod[];
      const running = pods.filter((p) => p.status.phase === 'Running');
      if (!running.length) { yield err(`No resources found in ${ctx.namespace} namespace.\n`); return 0; }
      const rows: string[][] = [[...(allNs ? ['NAMESPACE'] : []), 'NAME', 'CPU(cores)', 'MEMORY(bytes)']];
      for (const p of running) {
        const u = podUsage(ctx.engine, p);
        rows.push([...(allNs ? [p.metadata.namespace as string] : []), p.metadata.name, `${u.cpuMillis}m`, `${Math.round(u.memoryBytes / 1024 / 1024)}Mi`]);
      }
      yield out(table(bool(a, 'no-headers') ? rows.slice(1) : rows));
      return 0;
    }
    if (sub === 'node' || sub === 'nodes' || sub === 'no') {
      const ref = parseResourceArgs(a.positional[1] ? ['nodes', a.positional[1]] : ['nodes'])[0]!;
      const nodes = fetch(ctx.engine, ref, ctx.namespace, true, str(a, 'selector')) as Node[];
      const rows: string[][] = [['NAME', 'CPU(cores)', 'CPU(%)', 'MEMORY(bytes)', 'MEMORY(%)']];
      for (const n of nodes) {
        const rt = ctx.engine.nodeRuntime(n.metadata.name);
        if (!rt.ready) { rows.push([n.metadata.name, '<unknown>', '<unknown>', '<unknown>', '<unknown>']); continue; }
        let cpu = 120, mem = 600 * 1024 * 1024; // system daemons
        for (const p of ctx.engine.store.list<Pod>('Pod')) if (p.spec.nodeName === n.metadata.name) { const u = podUsage(ctx.engine, p); cpu += u.cpuMillis; mem += u.memoryBytes; }
        const cap = parseCpuMillis(n.status.allocatable.cpu ?? '1'), capMem = parseMemoryBytes(n.status.allocatable.memory ?? '1');
        rows.push([n.metadata.name, `${cpu}m`, `${Math.round((cpu / cap) * 100)}%`, `${Math.round(mem / 1024 / 1024)}Mi`, `${Math.round((mem / capMem) * 100)}%`]);
      }
      yield out(table(bool(a, 'no-headers') ? rows.slice(1) : rows));
      void formatCpuMillis;
      return 0;
    }
    throw new KubectlError(sub ? `unknown command "${sub}" for "kubectl top"` : 'You must specify the type of resource to get. Use "kubectl top node" or "kubectl top pod".');
  },
};

export const waitCommand: KubectlCommand = {
  name: 'wait',
  summary: 'Experimental: Wait for a specific condition on one or many resources',
  usage: 'kubectl wait ([-f FILENAME] | resource.group/resource.name | resource.group [(-l label | --all)]) [--for=delete|--for condition=available|--for=jsonpath=\'{}\'[=value]] [flags]',
  flags: [{ name: 'for', type: 'string' }, { name: 'timeout', type: 'string', def: '30s' }, { name: 'all', type: 'bool' }, { name: 'selector', short: 'l', type: 'string' }, { name: 'all-namespaces', short: 'A', type: 'bool' }, { name: 'filename', short: 'f', type: 'strings' }, { name: 'field-selector', type: 'string' }],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    const forFlag = str(a, 'for');
    if (!forFlag) throw new KubectlError('required flag(s) "for" not set');
    const refs = parseResourceArgs(a.positional);
    if (!refs.length) throw new KubectlError('resource(s) were provided, but no name was specified');
    const timeout = parseGoDuration(str(a, 'timeout') ?? '30s') ?? 30000;
    const start = ctx.engine.clock.nowMs;
    let objs: KubeObject[] = [];
    for (const r of refs) {
      if (r.name === undefined && !bool(a, 'all') && !str(a, 'selector')) throw new KubectlError('resource(s) were provided, but no name was specified');
      objs.push(...fetch(ctx.engine, r, ctx.namespace, bool(a, 'all-namespaces'), str(a, 'selector')));
    }
    const check = (o: KubeObject): boolean => {
      const live = ctx.engine.store.getByUid(o.metadata.uid as string);
      if (forFlag === 'delete') return !live;
      if (!live) return false;
      const m = /^condition=([^=]+)(?:=(.*))?$/.exec(forFlag);
      if (m) {
        const want = (m[2] ?? 'true').toLowerCase();
        const conds = ((live.status as { conditions?: { type: string; status: string }[] } | undefined)?.conditions) ?? [];
        const c = conds.find((x) => x.type.toLowerCase() === (m[1] as string).toLowerCase());
        return !!c && c.status.toLowerCase() === want;
      }
      const jp = /^jsonpath=(?:'|")?\{?([^}'"]+)\}?(?:'|")?(?:=(.*))?$/.exec(forFlag);
      if (jp) {
        const v = getPath(live, jp[1] as string);
        return jp[2] !== undefined ? String(v) === jp[2] : v !== undefined && v !== null;
      }
      throw new KubectlError(`unrecognized condition: "${forFlag}"`);
    };
    const pending = new Set(objs);
    while (pending.size && !ctx.host.aborted()) {
      for (const o of [...pending]) {
        if (check(o)) {
          yield out(forFlag === 'delete' ? `${qualifiedName(o.kind, o.metadata.name)} condition met\n` : `${qualifiedName(o.kind, o.metadata.name)} condition met\n`);
          pending.delete(o);
        }
      }
      if (!pending.size) break;
      if (timeout >= 0 && ctx.engine.clock.nowMs - start >= timeout) {
        for (const o of pending) yield err(`error: timed out waiting for the condition on ${o.kind.toLowerCase()}s/${o.metadata.name}\n`);
        return 1;
      }
      await ctx.host.sleep(250);
    }
    objs = [];
    return 0;
  },
};

function nodeArg(ctx: CommandContext): Node {
  const name = ctx.args.positional[0];
  if (!name) throw new KubectlError('USAGE: cordon NODE [flags]\nSee \'kubectl cordon -h\' for help and examples');
  const node = ctx.engine.store.get<Node>('Node', undefined, name.replace(/^node\//, ''));
  if (!node) throw new KubectlError(`Error from server (NotFound): nodes "${name}" not found`);
  return node;
}

export const cordonCommand: KubectlCommand = {
  name: 'cordon', summary: 'Mark node as unschedulable', usage: 'kubectl cordon NODE [flags]', flags: [{ name: 'selector', short: 'l', type: 'string' }, { name: 'dry-run', type: 'string', noOptDefault: 'client' }],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const n = nodeArg(ctx);
    if (n.spec.unschedulable) { yield out(`node/${n.metadata.name} already cordoned\n`); return 0; }
    n.spec.unschedulable = true;
    ctx.engine.store.update(n);
    yield out(`node/${n.metadata.name} cordoned\n`);
    return 0;
  },
};

export const uncordonCommand: KubectlCommand = {
  name: 'uncordon', summary: 'Mark node as schedulable', usage: 'kubectl uncordon NODE [flags]', flags: [{ name: 'selector', short: 'l', type: 'string' }, { name: 'dry-run', type: 'string', noOptDefault: 'client' }],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const n = nodeArg(ctx);
    if (!n.spec.unschedulable) { yield out(`node/${n.metadata.name} already uncordoned\n`); return 0; }
    delete n.spec.unschedulable;
    ctx.engine.store.update(n);
    yield out(`node/${n.metadata.name} uncordoned\n`);
    return 0;
  },
};

export const drainCommand: KubectlCommand = {
  name: 'drain', summary: 'Drain node in preparation for maintenance', usage: 'kubectl drain NODE [flags]',
  flags: [{ name: 'ignore-daemonsets', type: 'bool' }, { name: 'delete-emptydir-data', type: 'bool' }, { name: 'delete-local-data', type: 'bool' }, { name: 'force', type: 'bool' }, { name: 'grace-period', type: 'int', def: -1 }, { name: 'timeout', type: 'string' }, { name: 'dry-run', type: 'string', noOptDefault: 'client' }, { name: 'selector', short: 'l', type: 'string' }, { name: 'disable-eviction', type: 'bool' }, { name: 'skip-wait-for-delete-timeout', type: 'int' }],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    const n = nodeArg(ctx);
    const pods = ctx.engine.store.list<Pod>('Pod').filter((p) => p.spec.nodeName === n.metadata.name && !p.metadata.deletionTimestamp && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed');
    const dsPods = pods.filter((p) => p.metadata.ownerReferences?.some((r) => r.kind === 'DaemonSet'));
    const unmanaged = pods.filter((p) => !p.metadata.ownerReferences?.some((r) => r.controller));
    const emptyDir = pods.filter((p) => p.spec.volumes?.some((v) => v.emptyDir !== undefined) && !dsPods.includes(p));
    const errs: string[] = [];
    if (dsPods.length && !bool(a, 'ignore-daemonsets')) errs.push(`cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore): ${dsPods.map((p) => `${p.metadata.namespace}/${p.metadata.name}`).join(', ')}`);
    if (unmanaged.length && !bool(a, 'force')) errs.push(`cannot delete Pods that declare no controller (use --force to override): ${unmanaged.map((p) => `${p.metadata.namespace}/${p.metadata.name}`).join(', ')}`);
    if (emptyDir.length && !bool(a, 'delete-emptydir-data') && !bool(a, 'delete-local-data')) errs.push(`cannot delete Pods with local storage (use --delete-emptydir-data to override): ${emptyDir.map((p) => `${p.metadata.namespace}/${p.metadata.name}`).join(', ')}`);
    if (!n.spec.unschedulable) { n.spec.unschedulable = true; ctx.engine.store.update(n); yield out(`node/${n.metadata.name} cordoned\n`); }
    else yield out(`node/${n.metadata.name} already cordoned\n`);
    if (errs.length) { yield err(`error: unable to drain node "${n.metadata.name}" due to error: [${errs.join(', ')}], continuing command...\nThere are pending nodes to be drained:\n ${n.metadata.name}\nerror: ${errs.join('\n')}\n`); return 1; }
    const victims = pods.filter((p) => !dsPods.includes(p));
    if (dsPods.length) yield err(`Warning: ignoring DaemonSet-managed Pods: ${dsPods.map((p) => `${p.metadata.namespace}/${p.metadata.name}`).join(', ')}\n`);
    for (const p of victims) yield out(`evicting pod ${p.metadata.namespace}/${p.metadata.name}\n`);
    const grace = (a.flags['grace-period'] as number) >= 0 ? (a.flags['grace-period'] as number) : undefined;
    for (const p of victims) ctx.engine.store.markDeleting(p, grace ?? p.spec.terminationGracePeriodSeconds ?? 30);
    const pending = new Set(victims);
    const deadline = ctx.engine.clock.nowMs + (str(a, 'timeout') ? (parseGoDuration(str(a, 'timeout')!) ?? 0) : 10 * 60_000);
    while (pending.size && !ctx.host.aborted() && ctx.engine.clock.nowMs < deadline) {
      for (const p of [...pending]) if (!ctx.engine.store.getByUid(p.metadata.uid as string)) { pending.delete(p); yield out(`pod/${p.metadata.name} evicted\n`); }
      if (pending.size) await ctx.host.sleep(250);
    }
    if (pending.size) { yield err(`error: unable to drain node "${n.metadata.name}": global timeout reached\n`); return 1; }
    yield out(`node/${n.metadata.name} drained\n`);
    return 0;
  },
};

export const helpCommand: KubectlCommand = {
  name: 'help', summary: 'Help about any command', usage: 'kubectl help [command]', flags: [],
  run: async function* (): AsyncGenerator<OutputChunk, number> {
    yield out(COMMAND_MATRIX);
    void ((0 as unknown) as Deployment);
    return 0;
  },
};
