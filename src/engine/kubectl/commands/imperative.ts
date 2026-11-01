import type { KubectlCommand, CommandContext, OutputChunk } from '../context.ts';
import { out, err } from '../context.ts';
import { str, bool, strs, int, KubectlError } from '../args.ts';
import { parseResourceArgs, fetch } from '../resources.ts';
import { qualifiedName, resourceByKind } from '../../registry.ts';
import type { KubeObject, Pod, Deployment, ReplicaSet, Service, Namespace, DaemonSet, Node } from '../../types.ts';
import { admit, loadManifests } from './apply.ts';
import { parseOutputFlag, renderObjects } from '../output.ts';
import { ValidationError } from '../validate.ts';
import { ApiError } from '../../store.ts';
import { interactiveShell } from '../../container-shell.ts';

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export const runCommand: KubectlCommand = {
  name: 'run',
  summary: 'Run a particular image on the cluster',
  usage: 'kubectl run NAME --image=image [--env="key=value"] [--port=port] [--dry-run=server|client] [--overrides=inline-json] [--command] -- [COMMAND] [args...] [flags]',
  flags: [
    { name: 'image', type: 'string' },
    { name: 'env', type: 'strings' },
    { name: 'labels', short: 'l', type: 'string' },
    { name: 'port', type: 'string' },
    { name: 'restart', type: 'string', def: 'Always' },
    { name: 'command', type: 'bool' },
    { name: 'stdin', short: 'i', type: 'bool' },
    { name: 'tty', short: 't', type: 'bool' },
    { name: 'rm', type: 'bool' },
    { name: 'dry-run', type: 'string', noOptDefault: 'client' },
    { name: 'output', short: 'o', type: 'string' },
    { name: 'image-pull-policy', type: 'string' },
    { name: 'requests', type: 'string' },
    { name: 'limits', type: 'string' },
    { name: 'annotations', type: 'strings' },
    { name: 'attach', type: 'bool' },
    { name: 'quiet', short: 'q', type: 'bool' },
    { name: 'overrides', type: 'string' },
  ],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    const name = a.positional[0];
    if (!name) throw new KubectlError('NAME is required for run');
    if (a.positional.length > 1) throw new KubectlError(`exactly one NAME is required, got ${a.positional.length}`);
    const image = str(a, 'image');
    if (!image) throw new KubectlError('--image is required');
    const restart = str(a, 'restart') ?? 'Always';
    if (!['Always', 'OnFailure', 'Never'].includes(restart)) throw new KubectlError(`invalid restart policy: ${restart}`);
    const container: Record<string, unknown> = { image, name, resources: {} };
    const envs = strs(a, 'env').map((e) => { const i = e.indexOf('='); if (i <= 0) throw new KubectlError(`invalid env: ${e}`); return { name: e.slice(0, i), value: e.slice(i + 1) }; });
    if (envs.length) container.env = envs;
    const port = str(a, 'port');
    if (port) container.ports = [{ containerPort: parseInt(port, 10) }];
    if (a.rest.length) { if (bool(a, 'command')) container.command = a.rest; else container.args = a.rest; }
    const pull = str(a, 'image-pull-policy');
    if (pull) container.imagePullPolicy = pull;
    if (bool(a, 'stdin')) container.stdin = true;
    if (bool(a, 'tty')) container.tty = true;
    const res: Record<string, Record<string, string>> = {};
    for (const key of ['requests', 'limits'] as const) {
      const v = str(a, key);
      if (v) res[key] = Object.fromEntries(v.split(',').map((kv) => kv.split('=') as [string, string]));
    }
    if (Object.keys(res).length) container.resources = res;
    let labels: Record<string, string> = { run: name };
    if (str(a, 'labels')) labels = Object.fromEntries(str(a, 'labels')!.split(',').map((kv) => kv.split('=') as [string, string]));
    const pod: KubeObject = {
      apiVersion: 'v1', kind: 'Pod',
      metadata: { creationTimestamp: null as unknown as string, labels, name, ...(ctx.namespaceExplicit ? { namespace: ctx.namespace } : {}) },
      spec: { containers: [container], dnsPolicy: 'ClusterFirst', restartPolicy: restart },
      status: {},
    };
    const dry = str(a, 'dry-run');
    const fmt = parseOutputFlag(str(a, 'output'));
    if (dry && dry !== 'none') {
      if (fmt.kind === 'table') yield out(`pod/${name} created (${dry === 'server' ? 'server dry run' : 'dry run'})\n`);
      else yield out(renderObjects(fmt, [pod], true));
      return 0;
    }
    delete pod.metadata.creationTimestamp;
    const admitted = admit(ctx.engine, { obj: pod, source: 'kubectl run' }, ctx.namespace, ctx.namespaceExplicit);
    try { ctx.engine.store.create(admitted); }
    catch (e) { if (e instanceof ApiError) throw new KubectlError(`Error from server (${e.reason}): ${e.message}`); throw e; }
    const interactive = bool(a, 'stdin') && bool(a, 'tty');
    if (!interactive) {
      if (fmt.kind === 'table') yield out(`pod/${name} created\n`);
      else yield out(renderObjects(fmt, [admitted], true));
      return 0;
    }
    // -it: wait for the container, attach a shell, delete on exit when --rm
    const deadline = ctx.engine.clock.nowMs + 60_000;
    let p = ctx.engine.store.get<Pod>('Pod', ctx.namespace, name);
    while (p && p.status.phase === 'Pending' && ctx.engine.clock.nowMs < deadline && !ctx.host.aborted()) {
      await ctx.host.sleep(300);
      p = ctx.engine.store.get<Pod>('Pod', ctx.namespace, name);
    }
    if (!p || p.status.phase !== 'Running') {
      yield err(`error: timed out waiting for the condition\n`);
      return 1;
    }
    yield out("If you don't see a command prompt, try pressing enter.\n");
    const code = yield* interactiveShell(ctx.engine, ctx.host, p, p.spec.containers[0]!.name, a.rest.length ? a.rest : ['sh']);
    if (bool(a, 'rm')) {
      ctx.engine.store.markDeleting(p, 1);
      yield out(`pod "${name}" deleted\n`);
      while (ctx.engine.store.get('Pod', ctx.namespace, name) && !ctx.host.aborted()) await ctx.host.sleep(200);
    }
    return code;
  },
};

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

export const deleteCommand: KubectlCommand = {
  name: 'delete',
  summary: 'Delete resources by file names, stdin, resources and names, or by resources and label selector',
  usage: 'kubectl delete ([-f FILENAME] | [-k DIRECTORY] | TYPE [(NAME | -l label | --all)]) [flags]',
  flags: [
    { name: 'filename', short: 'f', type: 'strings' },
    { name: 'selector', short: 'l', type: 'string' },
    { name: 'all', type: 'bool' },
    { name: 'all-namespaces', short: 'A', type: 'bool' },
    { name: 'force', type: 'bool' },
    { name: 'grace-period', type: 'int' },
    { name: 'now', type: 'bool' },
    { name: 'wait', type: 'bool', def: true },
    { name: 'timeout', type: 'string' },
    { name: 'cascade', type: 'string', noOptDefault: 'background' },
    { name: 'ignore-not-found', type: 'bool' },
    { name: 'field-selector', type: 'string' },
    { name: 'recursive', short: 'R', type: 'bool' },
    { name: 'dry-run', type: 'string', noOptDefault: 'client' },
    { name: 'output', short: 'o', type: 'string' },
    { name: 'interactive', short: 'i', type: 'bool' },
  ],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    const files = strs(a, 'filename');
    const allNs = bool(a, 'all-namespaces');
    const targets: KubeObject[] = [];
    if (files.length) {
      for (const m of loadManifests(ctx, files, bool(a, 'recursive'))) {
        const r = resourceByKind(m.obj.kind) ?? (() => { throw new KubectlError(`the server doesn't have a resource type "${m.obj.kind}"`); })();
        const ns = r.namespaced ? (m.obj.metadata?.namespace ?? ctx.namespace) : undefined;
        const o = ctx.engine.store.get(r.kind, ns, m.obj.metadata?.name ?? '');
        if (!o) { if (!bool(a, 'ignore-not-found')) yield err(`Error from server (NotFound): error when deleting "${m.source}": ${r.plural} "${m.obj.metadata?.name}" not found\n`); continue; }
        targets.push(o);
      }
    } else {
      if (a.positional.length === 0) throw new KubectlError('resource(s) were provided, but no name was specified');
      const refs = parseResourceArgs(a.positional, { allowAll: true });
      const sel = str(a, 'selector');
      if (refs.every((r) => r.name === undefined) && !sel && !bool(a, 'all') && !str(a, 'field-selector')) throw new KubectlError('resource(s) were provided, but no name was specified');
      for (const ref of refs) {
        try { targets.push(...fetch(ctx.engine, ref, ctx.namespace, allNs, sel, str(a, 'field-selector'))); }
        catch (e) {
          if (e instanceof KubectlError && e.message.includes('NotFound') && bool(a, 'ignore-not-found')) continue;
          if (e instanceof KubectlError && e.message.includes('NotFound')) { yield err(e.message + '\n'); return 1; }
          throw e;
        }
      }
    }
    if (targets.length === 0) { yield err('No resources found\n'); return 0; }
    const dry = str(a, 'dry-run');
    let grace = int(a, 'grace-period');
    if (bool(a, 'now')) grace = 1;
    if (bool(a, 'force')) {
      if (grace !== undefined && grace !== 0) throw new KubectlError('--force and --grace-period greater than 0 cannot be specified together');
      grace = 0;
      yield err('Warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.\n');
    }
    const cascade = str(a, 'cascade') ?? 'background';
    if (!['background', 'foreground', 'orphan'].includes(cascade)) throw new KubectlError(`invalid cascade value (${cascade}). Must be "background", "foreground", or "orphan".`);
    for (const o of targets) {
      const qn = qualifiedName(o.kind, o.metadata.name);
      if (dry && dry !== 'none') { yield out(`${o.kind.toLowerCase()} "${o.metadata.name}" deleted (${dry === 'server' ? 'server dry run' : 'dry run'})\n`); continue; }
      if (cascade === 'orphan') {
        for (const dep of ctx.engine.store.all()) {
          if (dep.metadata.ownerReferences?.some((r) => r.uid === o.metadata.uid)) {
            dep.metadata.ownerReferences = dep.metadata.ownerReferences.filter((r) => r.uid !== o.metadata.uid);
            if (dep.metadata.ownerReferences.length === 0) delete dep.metadata.ownerReferences;
            ctx.engine.store.update(dep);
          }
        }
      }
      if (o.kind === 'Pod') {
        const p = o as Pod;
        const g = grace ?? p.spec.terminationGracePeriodSeconds ?? 30;
        if (g === 0) { ctx.engine.store.remove(p); ctx.engine.podRuntimes.delete(p.metadata.uid as string); }
        else ctx.engine.store.markDeleting(p, g);
      } else if (o.kind === 'Namespace') {
        const ns = o as Namespace;
        if (['default', 'kube-system', 'kube-public', 'kube-node-lease'].includes(ns.metadata.name)) throw new KubectlError(`Error from server (Forbidden): namespaces "${ns.metadata.name}" is forbidden: this namespace may not be deleted`);
        ns.status = { phase: 'Terminating' };
        ctx.engine.store.markDeleting(ns, 0);
        for (const dep of ctx.engine.store.all()) {
          if (dep.metadata.namespace !== ns.metadata.name || dep.kind === 'Event') continue;
          if (dep.kind === 'Pod') ctx.engine.store.markDeleting(dep, (dep as Pod).spec.terminationGracePeriodSeconds ?? 30);
          else ctx.engine.store.remove(dep);
        }
      } else {
        ctx.engine.store.remove(o);
      }
      const label = o.kind === 'Pod' || o.kind === 'Namespace' || o.kind === 'Service' || o.kind === 'Node' || o.kind === 'ConfigMap' || o.kind === 'Secret' || o.kind === 'Event' || o.kind === 'Endpoints' ? o.kind.toLowerCase() : qn.split('/')[0];
      yield out(`${label} "${o.metadata.name}"${grace === 0 && o.kind === 'Pod' ? ' force deleted' : ' deleted'}\n`);
    }
    if (bool(a, 'wait') && !(dry && dry !== 'none')) {
      const deadline = ctx.engine.clock.nowMs + 120_000;
      for (const o of targets) {
        while (ctx.engine.store.getByUid(o.metadata.uid as string) && ctx.engine.clock.nowMs < deadline && !ctx.host.aborted()) await ctx.host.sleep(200);
      }
    }
    void allNs;
    return 0;
  },
};

// ---------------------------------------------------------------------------
// scale
// ---------------------------------------------------------------------------

export const scaleCommand: KubectlCommand = {
  name: 'scale',
  summary: 'Set a new size for a deployment, replica set, or replication controller',
  usage: 'kubectl scale [--resource-version=version] [--current-replicas=count] --replicas=COUNT (-f FILENAME | TYPE NAME) [flags]',
  flags: [
    { name: 'replicas', type: 'int' },
    { name: 'current-replicas', type: 'int' },
    { name: 'filename', short: 'f', type: 'strings' },
    { name: 'selector', short: 'l', type: 'string' },
    { name: 'all', type: 'bool' },
    { name: 'timeout', type: 'string' },
    { name: 'dry-run', type: 'string', noOptDefault: 'client' },
    { name: 'output', short: 'o', type: 'string' },
  ],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    const replicas = int(a, 'replicas');
    if (replicas === undefined) throw new KubectlError('required flag(s) "replicas" not set');
    if (replicas < 0) throw new KubectlError('The --replicas=COUNT flag is required, and COUNT must be greater than or equal to 0');
    let targets: KubeObject[] = [];
    const files = strs(a, 'filename');
    if (files.length) {
      for (const m of loadManifests(ctx, files)) {
        const o = ctx.engine.store.get(m.obj.kind, m.obj.metadata?.namespace ?? ctx.namespace, m.obj.metadata?.name ?? '');
        if (!o) throw new KubectlError(`Error from server (NotFound): ${resourceByKind(m.obj.kind)?.plural ?? m.obj.kind} "${m.obj.metadata?.name}" not found`);
        targets.push(o);
      }
    } else {
      if (a.positional.length === 0) throw new KubectlError('resource(s) were provided, but no name was specified');
      const refs = parseResourceArgs(a.positional);
      for (const ref of refs) {
        if (!['Deployment', 'ReplicaSet', 'StatefulSet', 'ReplicationController'].includes(ref.info.kind)) throw new KubectlError(`the server doesn't have a resource type "${ref.info.plural}" that can be scaled`);
        if (ref.name === undefined && !str(a, 'selector') && !bool(a, 'all')) throw new KubectlError('resource(s) were provided, but no name was specified');
        targets = targets.concat(fetch(ctx.engine, ref, ctx.namespace, false, str(a, 'selector')));
      }
    }
    const dry = str(a, 'dry-run');
    for (const o of targets) {
      const cur = int(a, 'current-replicas');
      const spec = o.spec as { replicas?: number };
      if (cur !== undefined && (spec.replicas ?? 1) !== cur) throw new KubectlError(`Expected replicas to be ${cur}, was ${spec.replicas ?? 1}`);
      if (!(dry && dry !== 'none')) {
        spec.replicas = replicas;
        ctx.engine.store.update(o, { specChanged: true });
      }
      yield out(`${qualifiedName(o.kind, o.metadata.name)} scaled${dry && dry !== 'none' ? ' (dry run)' : ''}\n`);
    }
    return 0;
  },
};

// ---------------------------------------------------------------------------
// label / annotate
// ---------------------------------------------------------------------------

function parseLabelArgs(args: string[]): { set: Record<string, string>; remove: string[]; rest: string[] } {
  const set: Record<string, string> = {};
  const remove: string[] = [];
  const rest: string[] = [];
  for (const a of args) {
    if (/^[^=]+-$/.test(a) && !a.includes('=')) remove.push(a.slice(0, -1));
    else if (a.includes('=') ) { const i = a.indexOf('='); set[a.slice(0, i)] = a.slice(i + 1); }
    else rest.push(a);
  }
  return { set, remove, rest };
}

function makeMetaEditor(name: 'label' | 'annotate', field: 'labels' | 'annotations', verb: string): KubectlCommand {
  return {
    name,
    summary: name === 'label' ? 'Update the labels on a resource' : 'Update the annotations on a resource',
    usage: `kubectl ${name} [--overwrite] (-f FILENAME | TYPE NAME) KEY_1=VAL_1 ... KEY_N=VAL_N [--resource-version=version] [flags]`,
    flags: [
      { name: 'overwrite', type: 'bool' },
      { name: 'all', type: 'bool' },
      { name: 'all-namespaces', short: 'A', type: 'bool' },
      { name: 'selector', short: 'l', type: 'string' },
      { name: 'filename', short: 'f', type: 'strings' },
      { name: 'list', type: 'bool' },
      { name: 'dry-run', type: 'string', noOptDefault: 'client' },
      { name: 'output', short: 'o', type: 'string' },
      { name: 'field-selector', type: 'string' },
    ],
    run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
      const a = ctx.args;
      // split positional args into resource args and key=value pairs (upstream: everything containing '=' or ending with '-' after the first non-kv arg)
      const resArgs: string[] = [];
      const kvArgs: string[] = [];
      for (const p of a.positional) {
        if ((p.includes('=') || /[^=]-$/.test(p)) && resArgs.length > 0) kvArgs.push(p);
        else resArgs.push(p);
      }
      if (resArgs.length === 0) throw new KubectlError(`one or more resources must be specified as <resource> <name> or <resource>/<name>`);
      const { set, remove } = parseLabelArgs(kvArgs);
      if (!Object.keys(set).length && !remove.length && !bool(a, 'list')) throw new KubectlError(`at least one ${name === 'label' ? 'label' : 'annotation'} update is required`);
      const refs = parseResourceArgs(resArgs);
      const objs: KubeObject[] = [];
      for (const r of refs) {
        if (r.name === undefined && !str(a, 'selector') && !bool(a, 'all')) throw new KubectlError('resource(s) were provided, but no name was specified');
        objs.push(...fetch(ctx.engine, r, ctx.namespace, bool(a, 'all-namespaces'), str(a, 'selector'), str(a, 'field-selector')));
      }
      if (name === 'label') {
        for (const [k, v] of Object.entries(set)) {
          if (!/^([a-z0-9A-Z]([-a-z0-9A-Z_.]*[a-z0-9A-Z])?\/)?[a-z0-9A-Z]([-a-z0-9A-Z_.]*[a-z0-9A-Z])?$/.test(k)) throw new KubectlError(`invalid label key "${k}": name part must consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyName',  or 'my.name',  or '123-abc', regex used for validation is '([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]')`);
          if (v !== '' && !/^[a-z0-9A-Z]([-a-z0-9A-Z_.]*[a-z0-9A-Z])?$/.test(v)) throw new KubectlError(`invalid label value: "${v}": at key: "${k}": a valid label must be an empty string or consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyValue',  or 'my_value',  or '12345', regex used for validation is '(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?')`);
        }
      }
      const dry = str(a, 'dry-run');
      for (const o of objs) {
        const m = (o.metadata[field] ?? {}) as Record<string, string>;
        if (bool(a, 'list')) { yield out(`Listing ${field} for ${o.kind}/${o.metadata.name}:\n` + Object.entries(m).map(([k, v]) => ` ${k}=${v}\n`).join('')); continue; }
        let changed = false;
        for (const [k, v] of Object.entries(set)) {
          if (m[k] !== undefined && m[k] !== v && !bool(a, 'overwrite')) throw new KubectlError(`'${k}' already has a value (${m[k]}), and --overwrite is false`);
          if (m[k] !== v) { m[k] = v; changed = true; }
        }
        for (const k of remove) if (m[k] !== undefined) { delete m[k]; changed = true; }
        if (changed && !(dry && dry !== 'none')) {
          if (Object.keys(m).length) o.metadata[field] = m; else delete o.metadata[field];
          ctx.engine.store.update(o);
        }
        yield out(`${qualifiedName(o.kind, o.metadata.name)} ${changed ? verb : `not ${verb}`}${dry && dry !== 'none' ? ' (dry run)' : ''}\n`);
      }
      return 0;
    },
  };
}

export const labelCommand = makeMetaEditor('label', 'labels', 'labeled');
export const annotateCommand = makeMetaEditor('annotate', 'annotations', 'annotated');

// ---------------------------------------------------------------------------
// expose
// ---------------------------------------------------------------------------

export const exposeCommand: KubectlCommand = {
  name: 'expose',
  summary: 'Take a replication controller, service, deployment or pod and expose it as a new Kubernetes service',
  usage: 'kubectl expose (-f FILENAME | TYPE NAME) [--port=port] [--protocol=TCP|UDP|SCTP] [--target-port=number-or-name] [--name=name] [--external-ip=external-ip-of-service] [--type=type] [flags]',
  flags: [
    { name: 'port', type: 'string' },
    { name: 'target-port', type: 'string' },
    { name: 'protocol', type: 'string', def: 'TCP' },
    { name: 'name', type: 'string' },
    { name: 'type', type: 'string' },
    { name: 'selector', type: 'string' },
    { name: 'labels', short: 'l', type: 'string' },
    { name: 'dry-run', type: 'string', noOptDefault: 'client' },
    { name: 'output', short: 'o', type: 'string' },
    { name: 'filename', short: 'f', type: 'strings' },
    { name: 'cluster-ip', type: 'string' },
    { name: 'external-ip', type: 'string' },
  ],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    if (strs(a, 'filename').length) throw new KubectlError('kubequest: `expose -f` is not supported in the simulator yet');
    const refs = parseResourceArgs(a.positional);
    if (refs.length !== 1 || refs[0]!.name === undefined) throw new KubectlError('resource(s) were provided, but no name was specified');
    const ref = refs[0]!;
    if (!['Deployment', 'ReplicaSet', 'Pod', 'Service'].includes(ref.info.kind)) throw new KubectlError(`cannot expose a ${ref.info.kind}`);
    const target = fetch(ctx.engine, ref, ctx.namespace, false)[0] as KubeObject;
    let selector: Record<string, string> = {};
    let containerPorts: { containerPort: number; protocol?: string; name?: string }[] = [];
    switch (target.kind) {
      case 'Deployment': { const d = target as Deployment; selector = { ...(d.spec.selector.matchLabels ?? {}) }; containerPorts = d.spec.template.spec.containers.flatMap((c) => c.ports ?? []); break; }
      case 'ReplicaSet': { const rs = target as ReplicaSet; selector = { ...(rs.spec.selector.matchLabels ?? {}) }; containerPorts = rs.spec.template.spec.containers.flatMap((c) => c.ports ?? []); break; }
      case 'Pod': { const p = target as Pod; selector = { ...(p.metadata.labels ?? {}) }; containerPorts = p.spec.containers.flatMap((c) => c.ports ?? []); break; }
      case 'Service': { const s = target as Service; selector = { ...(s.spec.selector ?? {}) }; containerPorts = (s.spec.ports ?? []).map((p) => ({ containerPort: p.port, protocol: p.protocol, name: p.name })); break; }
    }
    if (str(a, 'selector')) selector = Object.fromEntries(str(a, 'selector')!.split(',').map((kv) => kv.split('=') as [string, string]));
    if (!Object.keys(selector).length) throw new KubectlError(`couldn't retrieve selectors via --selector flag or introspection: the ${target.kind.toLowerCase()} has no labels and cannot be exposed`);
    const portFlag = str(a, 'port');
    let ports: { name?: string; port: number; protocol: string; targetPort?: number | string }[] = [];
    if (portFlag) {
      ports = portFlag.split(',').map((p, i, arr) => {
        const port = parseInt(p, 10);
        if (Number.isNaN(port)) throw new KubectlError(`strconv.Atoi: parsing "${p}": invalid syntax`);
        const tp = str(a, 'target-port');
        const targetPort: number | string | undefined = tp ? (/^\d+$/.test(tp) ? parseInt(tp, 10) : tp) : containerPorts.length ? undefined : port;
        const entry: { name?: string; port: number; protocol: string; targetPort?: number | string } = { port, protocol: str(a, 'protocol') ?? 'TCP' };
        if (arr.length > 1) entry.name = `port-${i + 1}`;
        if (targetPort !== undefined) entry.targetPort = targetPort;
        else if (containerPorts.length) entry.targetPort = containerPorts[0]!.containerPort;
        return entry;
      });
    } else if (containerPorts.length) {
      ports = containerPorts.map((cp, i, arr) => ({ ...(arr.length > 1 ? { name: cp.name ?? `port-${i + 1}` } : {}), port: cp.containerPort, protocol: cp.protocol ?? 'TCP', targetPort: cp.containerPort }));
    } else throw new KubectlError(`couldn't find port via --port flag or introspection`);
    const svcName = str(a, 'name') ?? target.metadata.name;
    const labels = str(a, 'labels') ? Object.fromEntries(str(a, 'labels')!.split(',').map((kv) => kv.split('=') as [string, string])) : (target.metadata.labels ? { ...target.metadata.labels } : undefined);
    if (labels) delete labels['pod-template-hash'];
    const svc: KubeObject = {
      apiVersion: 'v1', kind: 'Service',
      metadata: { creationTimestamp: null as unknown as string, ...(labels && Object.keys(labels).length ? { labels } : {}), name: svcName, namespace: target.metadata.namespace },
      spec: { ports, selector, ...(str(a, 'type') ? { type: str(a, 'type') } : {}), ...(str(a, 'cluster-ip') ? { clusterIP: str(a, 'cluster-ip') } : {}) },
      status: { loadBalancer: {} },
    };
    const dry = str(a, 'dry-run');
    const fmt = parseOutputFlag(str(a, 'output'));
    if (dry && dry !== 'none') {
      if (fmt.kind === 'table') yield out(`service/${svcName} exposed (dry run)\n`);
      else yield out(renderObjects(fmt, [svc], true));
      return 0;
    }
    delete svc.metadata.creationTimestamp;
    try {
      const admitted = admit(ctx.engine, { obj: svc, source: 'kubectl expose' }, ctx.namespace, ctx.namespaceExplicit);
      ctx.engine.store.create(admitted);
      if (fmt.kind === 'table') yield out(`service/${svcName} exposed\n`);
      else yield out(renderObjects(fmt, [admitted], true));
    } catch (e) {
      if (e instanceof ApiError) throw new KubectlError(`Error from server (${e.reason}): ${e.message}`);
      if (e instanceof ValidationError) throw new KubectlError(`The ${e.message}`);
      throw e;
    }
    void ((0 as unknown) as Node); void ((0 as unknown) as DaemonSet);
    return 0;
  },
};
