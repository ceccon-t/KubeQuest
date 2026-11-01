import type { KubectlCommand, CommandContext, OutputChunk } from '../context.ts';
import { out, err } from '../context.ts';
import { str, bool, int, KubectlError } from '../args.ts';
import { parseResourceArgs, fetch } from '../resources.ts';
import type { Pod, Deployment, ReplicaSet, Service, KubeObject, DaemonSet, Job } from '../../types.ts';
import { fromLabelSelector, matches } from '../../selector.ts';
import { parseGoDuration } from '../../duration.ts';
import { execInContainer, interactiveShell } from '../../container-shell.ts';
import { resolveTargetPort, serviceBackends } from '../../controllers/service.ts';

/** Resolve `POD`, `pod/NAME`, `deploy/NAME`, `svc/NAME` etc. to pods (first match for workloads, like kubectl). */
function podsFor(ctx: CommandContext, arg: string, selector?: string): { pods: Pod[]; note?: string } {
  if (selector) {
    const ref = parseResourceArgs(['pods'])[0]!;
    return { pods: fetch(ctx.engine, ref, ctx.namespace, ctx.allNamespaces, selector) as Pod[] };
  }
  const refs = parseResourceArgs(arg.includes('/') ? [arg] : ['pod', arg]);
  const ref = refs[0]!;
  const obj = fetch(ctx.engine, ref, ctx.namespace, false)[0] as KubeObject;
  if (obj.kind === 'Pod') return { pods: [obj as Pod] };
  let reqs;
  switch (obj.kind) {
    case 'Deployment': reqs = fromLabelSelector((obj as Deployment).spec.selector); break;
    case 'ReplicaSet': reqs = fromLabelSelector((obj as ReplicaSet).spec.selector); break;
    case 'DaemonSet': reqs = fromLabelSelector((obj as DaemonSet).spec.selector); break;
    case 'Job': reqs = [{ key: 'batch.kubernetes.io/controller-uid', op: 'in' as const, values: [obj.metadata.uid as string] }]; break;
    case 'Service': reqs = Object.entries((obj as Service).spec.selector ?? {}).map(([k, v]) => ({ key: k, op: 'in' as const, values: [v] })); break;
    default: throw new KubectlError(`cannot get the logs from ${obj.kind.toLowerCase()}s/${obj.metadata.name}: no pod template`);
  }
  const all = ctx.engine.store.list<Pod>('Pod', obj.metadata.namespace).filter((p) => matches(reqs, p.metadata.labels));
  if (!all.length) throw new KubectlError(`no pods found for ${obj.kind.toLowerCase()}s/${obj.metadata.name}`);
  void ((0 as unknown) as Job);
  return { pods: [all[0] as Pod], note: all.length > 1 ? `Found ${all.length} pods, using pod/${all[0]!.metadata.name}\n` : undefined };
}

function pickContainer(pod: Pod, name: string | undefined): string {
  const names = pod.spec.containers.map((c) => c.name);
  if (name) {
    if (!names.includes(name)) throw new KubectlError(`container ${name} is not valid for pod ${pod.metadata.name}`);
    return name;
  }
  if (names.length > 1) {
    const def = pod.metadata.annotations?.['kubectl.kubernetes.io/default-container'];
    if (def && names.includes(def)) return def;
    throw new KubectlError(`a container name must be specified for pod ${pod.metadata.name}, choose one of: [${names.join(' ')}]`);
  }
  return names[0] as string;
}

export const logsCommand: KubectlCommand = {
  name: 'logs',
  summary: 'Print the logs for a container in a pod',
  usage: 'kubectl logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER] [flags]',
  flags: [
    { name: 'container', short: 'c', type: 'string' },
    { name: 'follow', short: 'f', type: 'bool' },
    { name: 'previous', short: 'p', type: 'bool' },
    { name: 'tail', type: 'int' },
    { name: 'since', type: 'string' },
    { name: 'since-time', type: 'string' },
    { name: 'timestamps', type: 'bool' },
    { name: 'selector', short: 'l', type: 'string' },
    { name: 'all-containers', type: 'bool' },
    { name: 'prefix', type: 'bool' },
    { name: 'all-namespaces', short: 'A', type: 'bool' },
    { name: 'max-log-requests', type: 'int' },
    { name: 'limit-bytes', type: 'int' },
    { name: 'ignore-errors', type: 'bool' },
    { name: 'pod-running-timeout', type: 'string' },
  ],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    const selector = str(a, 'selector');
    if (!a.positional.length && !selector) throw new KubectlError('expected \'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]\'.\nPOD or TYPE/NAME is a required argument for the logs command\nSee \'kubectl logs -h\' for help and examples');
    if (a.positional.length > 2) throw new KubectlError(`expected 'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]'.\nPOD or TYPE/NAME is a required argument for the logs command\nSee 'kubectl logs -h' for help and examples`);
    if (a.positional.length === 2 && str(a, 'container')) throw new KubectlError('only one of -c or an inline [CONTAINER] arg is allowed');
    const containerFlag = str(a, 'container') ?? a.positional[1];
    const { pods, note } = podsFor(ctx, a.positional[0] ?? '', selector);
    if (note) yield err(note);
    const prefix = bool(a, 'prefix') || (!!selector && pods.length > 1 && bool(a, 'prefix'));
    const since = str(a, 'since') ? (parseGoDuration(str(a, 'since')!) ?? undefined) : undefined;
    const tail = int(a, 'tail');
    const follow = bool(a, 'follow');
    const allContainers = bool(a, 'all-containers');
    if (follow && pods.length > 1 && !selector) throw new KubectlError('only one of follow or selector is allowed');
    const streams: { pod: Pod; container: string; printed: number }[] = [];
    for (const pod of pods) {
      const names = allContainers ? pod.spec.containers.map((c) => c.name) : [pickContainer(pod, containerFlag)];
      for (const c of names) streams.push({ pod, container: c, printed: 0 });
    }
    const render = (line: string): string => {
      const ts = line.slice(0, 20), body = line.slice(21);
      return bool(a, 'timestamps') ? `${ts} ${body}` : body;
    };
    for (const s of streams) {
      const rt = ctx.engine.podRuntime(s.pod).containers.find((c) => c.name === s.container);
      const cs = s.pod.status.containerStatuses?.find((c) => c.name === s.container);
      if (bool(a, 'previous')) {
        if (!rt || !rt.lastExit || !rt.prevLogs.length && !rt.lastExit) throw new KubectlError(`Error from server (BadRequest): previous terminated container "${s.container}" in pod "${s.pod.metadata.name}" not found`);
      } else if (!rt || !cs || cs.state.waiting) {
        const reason = cs?.state.waiting?.reason ?? 'ContainerCreating';
        const why = reason === 'ImagePullBackOff' || reason === 'ErrImagePull' ? `trying and failing to pull image` : reason === 'CrashLoopBackOff' ? `CrashLoopBackOff` : reason;
        if (reason === 'CrashLoopBackOff' && rt) { /* crashlooping: current logs may exist from the latest attempt; upstream returns logs of the last run */ }
        else throw new KubectlError(`Error from server (BadRequest): container "${s.container}" in pod "${s.pod.metadata.name}" is waiting to start: ${why}`);
      }
      let lines = bool(a, 'previous') ? rt!.prevLogs : (rt!.logs.length ? rt!.logs : rt!.prevLogs);
      if (since !== undefined) lines = lines.filter((l) => ctx.engine.clock.nowMs - Date.parse(l.slice(0, 20)) <= since);
      if (tail !== undefined && tail >= 0) lines = lines.slice(-tail);
      const pre = prefix || streams.length > 1 ? `[pod/${s.pod.metadata.name}/${s.container}] ` : '';
      if (lines.length) yield out(lines.map((l) => pre + render(l)).join('\n') + '\n');
      s.printed = rt!.logs.length;
    }
    if (!follow) return 0;
    while (!ctx.host.aborted()) {
      await ctx.host.sleep(300);
      for (const s of streams) {
        const live = ctx.engine.store.getByUid<Pod>(s.pod.metadata.uid as string);
        if (!live) return 0;
        const rt = ctx.engine.podRuntime(live).containers.find((c) => c.name === s.container);
        if (!rt) continue;
        if (rt.logs.length < s.printed) s.printed = 0; // restarted
        const fresh = rt.logs.slice(s.printed);
        s.printed = rt.logs.length;
        if (fresh.length) yield out(fresh.map((l) => (prefix || streams.length > 1 ? `[pod/${live.metadata.name}/${s.container}] ` : '') + render(l)).join('\n') + '\n');
      }
    }
    return 0;
  },
};

export const execCommand: KubectlCommand = {
  name: 'exec',
  summary: 'Execute a command in a container',
  usage: 'kubectl exec (POD | TYPE/NAME) [-c CONTAINER] [flags] -- COMMAND [args...]',
  stopAtFirstPositional: false,
  flags: [
    { name: 'container', short: 'c', type: 'string' },
    { name: 'stdin', short: 'i', type: 'bool' },
    { name: 'tty', short: 't', type: 'bool' },
    { name: 'quiet', short: 'q', type: 'bool' },
    { name: 'pod-running-timeout', type: 'string' },
    { name: 'filename', short: 'f', type: 'strings' },
  ],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    if (!a.positional.length) throw new KubectlError('pod, type/name or --filename must be specified');
    if (a.positional.length > 1 && a.rest.length === 0) throw new KubectlError('exec [POD] [COMMAND] is not supported anymore. Use exec [POD] -- [COMMAND] instead.');
    if (a.rest.length === 0) throw new KubectlError('you must specify at least one command for the container');
    const { pods } = podsFor(ctx, a.positional[0] as string);
    const pod = pods[0] as Pod;
    const container = pickContainer(pod, str(a, 'container'));
    const cs = pod.status.containerStatuses?.find((c) => c.name === container);
    if (!cs || !cs.state.running) {
      if (cs?.state.waiting?.reason === 'ContainerCreating' || !cs) throw new KubectlError(`Error from server (BadRequest): pod ${pod.metadata.name} does not have a host assigned`.replace('does not have a host assigned', pod.spec.nodeName ? `container "${container}" is waiting to start: ${cs?.state.waiting?.reason ?? 'ContainerCreating'}` : 'does not have a host assigned'));
      throw new KubectlError(`unable to upgrade connection: container not found ("${container}")`);
    }
    if (bool(a, 'stdin') && bool(a, 'tty')) return yield* interactiveShell(ctx.engine, ctx.host, pod, container, a.rest);
    const r = execInContainer(ctx.engine, pod, container, a.rest);
    for (const c of r.chunks) yield c;
    if (r.code !== 0) yield err(`command terminated with exit code ${r.code}\n`);
    return r.code;
  },
};

export interface PortForward { local: number; target: { pod?: Pod; service?: Service }; remote: number; namespace: string }

export const portForwardCommand: KubectlCommand = {
  name: 'port-forward',
  summary: 'Forward one or more local ports to a pod',
  usage: 'kubectl port-forward TYPE/NAME [options] [LOCAL_PORT:]REMOTE_PORT [...[LOCAL_PORT_N:]REMOTE_PORT_N]',
  flags: [
    { name: 'address', type: 'strings' },
    { name: 'pod-running-timeout', type: 'string' },
  ],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    if (a.positional.length < 2) throw new KubectlError('TYPE/NAME and list of ports are required for port-forward\nSee \'kubectl port-forward -h\' for help and examples');
    const target = a.positional[0] as string;
    const refs = parseResourceArgs(target.includes('/') ? [target] : ['pod', target]);
    const obj = fetch(ctx.engine, refs[0]!, ctx.namespace, false)[0] as KubeObject;
    let pod: Pod | undefined;
    let svc: Service | undefined;
    if (obj.kind === 'Pod') pod = obj as Pod;
    else if (obj.kind === 'Service') {
      svc = obj as Service;
      const { ready } = serviceBackends(ctx.engine, svc);
      if (!ready.length) throw new KubectlError(`no pods found for service ${svc.metadata.name}`);
      pod = ready[0] as Pod;
    } else {
      const { pods } = podsFor(ctx, target);
      pod = pods[0] as Pod;
    }
    if (pod.status.phase !== 'Running') throw new KubectlError(`unable to forward port because pod is not running. Current status=${pod.status.phase}`);
    const forwards: { local: number; remote: number }[] = [];
    for (const p of a.positional.slice(1)) {
      const m = /^(?:(\d+):)?(\d+)$/.exec(p);
      if (!m) throw new KubectlError(`invalid port format: ${p}`);
      const remotePort = parseInt(m[2] as string, 10);
      const remote = svc ? resolveTargetPort(svc, (svc.spec.ports ?? []).find((sp) => sp.port === remotePort) ?? { port: remotePort }, pod) : remotePort;
      forwards.push({ local: m[1] ? parseInt(m[1], 10) : remotePort, remote });
    }
    const registry = (ctx.engine.scratch.get('port-forwards') as PortForward[] | undefined) ?? [];
    for (const f of forwards) {
      if (registry.some((r) => r.local === f.local)) throw new KubectlError(`unable to listen on any of the requested ports: [{${f.local} ${f.remote}}]`);
    }
    const mine: PortForward[] = forwards.map((f) => ({ local: f.local, remote: f.remote, target: { pod, service: svc }, namespace: pod!.metadata.namespace as string }));
    registry.push(...mine);
    ctx.engine.scratch.set('port-forwards', registry);
    for (const f of forwards) yield out(`Forwarding from 127.0.0.1:${f.local} -> ${f.remote}\nForwarding from [::1]:${f.local} -> ${f.remote}\n`);
    try {
      while (!ctx.host.aborted()) {
        await ctx.host.sleep(500);
        if (!ctx.engine.store.getByUid(pod.metadata.uid as string)) { yield err(`E1005 09:00:00.000000   12345 portforward.go:413] "Unhandled Error" err="an error occurred forwarding ${forwards[0]!.local} -> ${forwards[0]!.remote}: error forwarding port ${forwards[0]!.remote} to pod ${pod.metadata.name}: pod not found"\nerror: lost connection to pod\n`); return 1; }
      }
    } finally {
      const current = (ctx.engine.scratch.get('port-forwards') as PortForward[] | undefined) ?? [];
      ctx.engine.scratch.set('port-forwards', current.filter((r) => !mine.includes(r)));
    }
    return 0;
  },
};
