/** Table printers mirroring kubectl's text/tabwriter output and per-kind columns (pkg/printers/internalversion). */
import type { KubeObject, Pod, Deployment, ReplicaSet, Service, Node, Namespace, Event, Job, CronJob, DaemonSet, ConfigMap, Secret, Endpoints } from '../types.ts';
import { humanDuration } from '../duration.ts';
import { labelsToString, selectorToString } from '../selector.ts';
import { resourceByKind } from '../registry.ts';
import { nextCronTime, parseCron } from '../controllers/job.ts';

export interface Table {
  headers: string[];
  rows: string[][];
}

/** text/tabwriter with minwidth=6, tabwidth=4, padding=3 (kubectl's settings). */
export function renderTable(t: Table, opts: { noHeaders?: boolean } = {}): string {
  const rows = opts.noHeaders ? t.rows : [t.headers, ...t.rows];
  if (rows.length === 0) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = 0;
    for (const r of rows) w = Math.max(w, (r[c] ?? '').length);
    widths.push(Math.max(w + 3, 6));
  }
  return rows
    .map((r) => {
      let line = '';
      for (let c = 0; c < r.length; c++) {
        const cell = r[c] ?? '';
        line += c === r.length - 1 ? cell : cell.padEnd(widths[c] as number, ' ');
      }
      return line;
    })
    .join('\n') + '\n';
}

export function age(obj: KubeObject, nowMs: number): string {
  const ts = obj.metadata.creationTimestamp;
  if (!ts) return '<unknown>';
  return humanDuration(nowMs - Date.parse(ts));
}

// ---------------------------------------------------------------------------
// Pod
// ---------------------------------------------------------------------------

export function podStatusReason(pod: Pod): string {
  let reason: string = pod.status.phase ?? 'Pending';
  if (pod.status.reason) reason = pod.status.reason;
  const statuses = pod.status.containerStatuses ?? [];
  let hasRunning = false;
  for (let i = statuses.length - 1; i >= 0; i--) {
    const c = statuses[i] as NonNullable<Pod['status']['containerStatuses']>[number];
    if (c.state.waiting?.reason) reason = c.state.waiting.reason;
    else if (c.state.terminated?.reason) reason = c.state.terminated.reason;
    else if (c.state.terminated) reason = `ExitCode:${c.state.terminated.exitCode}`;
    else if (c.ready && c.state.running) hasRunning = true;
  }
  if (reason === 'Completed' && hasRunning) {
    reason = pod.status.conditions?.some((x) => x.type === 'Ready' && x.status === 'True') ? 'Running' : 'NotReady';
  }
  if (pod.metadata.deletionTimestamp && pod.status.reason === 'NodeLost') reason = 'Unknown';
  else if (pod.metadata.deletionTimestamp && pod.status.phase !== 'Succeeded' && pod.status.phase !== 'Failed') reason = 'Terminating';
  return reason;
}

export function podReady(pod: Pod): string {
  const statuses = pod.status.containerStatuses ?? [];
  const total = pod.spec.containers.length;
  const ready = statuses.filter((c) => c.ready && c.state.running).length;
  return `${ready}/${total}`;
}

export function podRestarts(pod: Pod, nowMs: number): string {
  let restarts = 0;
  let last = 0;
  for (const c of pod.status.containerStatuses ?? []) {
    restarts += c.restartCount;
    const f = c.lastState.terminated?.finishedAt;
    if (f) last = Math.max(last, Date.parse(f));
  }
  if (restarts > 0 && last > 0) return `${restarts} (${humanDuration(nowMs - last)} ago)`;
  return String(restarts);
}

export function nodeRoles(node: Node): string {
  const roles = Object.keys(node.metadata.labels ?? {})
    .filter((k) => k.startsWith('node-role.kubernetes.io/'))
    .map((k) => k.slice('node-role.kubernetes.io/'.length))
    .filter((r) => r)
    .sort();
  return roles.length ? roles.join(',') : '<none>';
}

export function nodeStatus(node: Node): string {
  const ready = node.status.conditions.find((c) => c.type === 'Ready');
  let s = ready?.status === 'True' ? 'Ready' : ready?.status === 'False' ? 'NotReady' : ready ? 'NotReady' : 'Unknown';
  if (ready?.status === 'Unknown') s = 'NotReady';
  if (node.spec.unschedulable) s += ',SchedulingDisabled';
  return s;
}

export function servicePorts(svc: Service): string {
  const ports = svc.spec.ports ?? [];
  if (!ports.length) return '<none>';
  return ports
    .map((p) => {
      const proto = p.protocol ?? 'TCP';
      if (p.nodePort && (svc.spec.type === 'NodePort' || svc.spec.type === 'LoadBalancer')) return `${p.port}:${p.nodePort}/${proto}`;
      return `${p.port}/${proto}`;
    })
    .join(',');
}

export function serviceExternalIp(svc: Service): string {
  switch (svc.spec.type) {
    case 'LoadBalancer': {
      const ing = svc.status.loadBalancer?.ingress ?? [];
      return ing.length ? ing.map((i) => i.ip ?? i.hostname ?? '').join(',') : '<pending>';
    }
    case 'ExternalName':
      return svc.spec.externalName ?? '';
    default:
      return '<none>';
  }
}

function containersAndImages(containers: { name: string; image: string }[]): [string, string] {
  return [containers.map((c) => c.name).join(','), containers.map((c) => c.image).join(',')];
}

function jobStatus(job: Job): string {
  const conds = job.status.conditions ?? [];
  if (conds.some((c) => c.type === 'Complete' && c.status === 'True')) return 'Complete';
  if (conds.some((c) => c.type === 'Failed' && c.status === 'True')) return 'Failed';
  if (conds.some((c) => c.type === 'Suspended' && c.status === 'True')) return 'Suspended';
  if (conds.some((c) => c.type === 'FailureTarget' && c.status === 'True')) return 'FailureTarget';
  return 'Running';
}

function jobDuration(job: Job, nowMs: number): string {
  if (!job.status.startTime) return '';
  const start = Date.parse(job.status.startTime);
  const end = job.status.completionTime ? Date.parse(job.status.completionTime) : nowMs;
  return humanDuration(end - start);
}

function endpointsString(ep: Endpoints): string {
  const list: string[] = [];
  for (const s of ep.subsets ?? []) {
    for (const a of s.addresses ?? []) for (const p of s.ports ?? [{ port: undefined }]) list.push(p.port !== undefined ? `${a.ip}:${p.port}` : a.ip);
  }
  if (list.length === 0) return '<none>';
  if (list.length > 3) return `${list.slice(0, 3).join(',')} + ${list.length - 3} more...`;
  return list.join(',');
}

export interface PrintOptions {
  wide?: boolean;
  showLabels?: boolean;
  labelColumns?: string[];
  withNamespace?: boolean;
  withKind?: boolean;
  nowMs: number;
}

/** Build a table for a homogeneous list of objects. */
export function buildTable(kind: string, objs: KubeObject[], o: PrintOptions): Table {
  const r = resourceByKind(kind);
  const name = (obj: KubeObject): string => (o.withKind ? `${r ? (r.group ? `${r.singular}.${r.group}` : r.singular) : kind.toLowerCase()}/${obj.metadata.name}` : obj.metadata.name);
  let headers: string[] = [];
  let rows: string[][] = [];
  const A = (obj: KubeObject) => age(obj, o.nowMs);
  switch (kind) {
    case 'Pod': {
      headers = ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE'];
      if (o.wide) headers.push('IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES');
      rows = (objs as Pod[]).map((p) => {
        const row = [name(p), podReady(p), podStatusReason(p), podRestarts(p, o.nowMs), A(p)];
        if (o.wide) row.push(p.status.podIP ?? '<none>', p.spec.nodeName ?? '<none>', p.status.nominatedNodeName ?? '<none>', '<none>');
        return row;
      });
      break;
    }
    case 'Deployment': {
      headers = ['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'];
      if (o.wide) headers.push('CONTAINERS', 'IMAGES', 'SELECTOR');
      rows = (objs as Deployment[]).map((d) => {
        const row = [name(d), `${d.status.readyReplicas ?? 0}/${d.spec.replicas ?? 1}`, String(d.status.updatedReplicas ?? 0), String(d.status.availableReplicas ?? 0), A(d)];
        if (o.wide) row.push(...containersAndImages(d.spec.template.spec.containers), selectorToString(d.spec.selector));
        return row;
      });
      break;
    }
    case 'ReplicaSet': {
      headers = ['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE'];
      if (o.wide) headers.push('CONTAINERS', 'IMAGES', 'SELECTOR');
      rows = (objs as ReplicaSet[]).map((rs) => {
        const row = [name(rs), String(rs.spec.replicas ?? 0), String(rs.status.replicas ?? 0), String(rs.status.readyReplicas ?? 0), A(rs)];
        if (o.wide) row.push(...containersAndImages(rs.spec.template.spec.containers), selectorToString(rs.spec.selector));
        return row;
      });
      break;
    }
    case 'DaemonSet': {
      headers = ['NAME', 'DESIRED', 'CURRENT', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'NODE SELECTOR', 'AGE'];
      if (o.wide) headers.push('CONTAINERS', 'IMAGES', 'SELECTOR');
      rows = (objs as DaemonSet[]).map((ds) => {
        const row = [name(ds), String(ds.status.desiredNumberScheduled), String(ds.status.currentNumberScheduled), String(ds.status.numberReady), String(ds.status.updatedNumberScheduled ?? 0), String(ds.status.numberAvailable ?? 0), selectorToString(ds.spec.template.spec.nodeSelector, true), A(ds)];
        if (o.wide) row.push(...containersAndImages(ds.spec.template.spec.containers), selectorToString(ds.spec.selector));
        return row;
      });
      break;
    }
    case 'Service': {
      headers = ['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE'];
      if (o.wide) headers.push('SELECTOR');
      rows = (objs as Service[]).map((s) => {
        const row = [name(s), s.spec.type ?? 'ClusterIP', s.spec.clusterIP ?? '<none>', serviceExternalIp(s), servicePorts(s), A(s)];
        if (o.wide) row.push(selectorToString(s.spec.selector, true));
        return row;
      });
      break;
    }
    case 'Endpoints': {
      headers = ['NAME', 'ENDPOINTS', 'AGE'];
      rows = (objs as Endpoints[]).map((e) => [name(e), endpointsString(e), A(e)]);
      break;
    }
    case 'EndpointSlice': {
      headers = ['NAME', 'ADDRESSTYPE', 'PORTS', 'ENDPOINTS', 'AGE'];
      rows = objs.map((e) => {
        const ports = (e.ports as { port: number }[] | undefined) ?? [];
        const eps = (e.endpoints as { addresses: string[] }[] | undefined) ?? [];
        const addrs = eps.flatMap((x) => x.addresses);
        return [name(e), String(e.addressType ?? 'IPv4'), ports.length ? ports.map((p) => String(p.port)).join(',') : '<unset>', addrs.length ? (addrs.length > 3 ? `${addrs.slice(0, 3).join(',')} + ${addrs.length - 3} more...` : addrs.join(',')) : '<unset>', A(e)];
      });
      break;
    }
    case 'Node': {
      headers = ['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION'];
      if (o.wide) headers.push('INTERNAL-IP', 'EXTERNAL-IP', 'OS-IMAGE', 'KERNEL-VERSION', 'CONTAINER-RUNTIME');
      rows = (objs as Node[]).map((n) => {
        const row = [name(n), nodeStatus(n), nodeRoles(n), A(n), n.status.nodeInfo.kubeletVersion];
        if (o.wide) row.push(n.status.addresses.find((a) => a.type === 'InternalIP')?.address ?? '<none>', n.status.addresses.find((a) => a.type === 'ExternalIP')?.address ?? '<none>', n.status.nodeInfo.osImage, n.status.nodeInfo.kernelVersion, n.status.nodeInfo.containerRuntimeVersion);
        return row;
      });
      break;
    }
    case 'Namespace': {
      headers = ['NAME', 'STATUS', 'AGE'];
      rows = (objs as Namespace[]).map((n) => [name(n), n.status?.phase ?? 'Active', A(n)]);
      break;
    }
    case 'ConfigMap': {
      headers = ['NAME', 'DATA', 'AGE'];
      rows = (objs as ConfigMap[]).map((c) => [name(c), String(Object.keys(c.data ?? {}).length + Object.keys(c.binaryData ?? {}).length), A(c)]);
      break;
    }
    case 'Secret': {
      headers = ['NAME', 'TYPE', 'DATA', 'AGE'];
      rows = (objs as Secret[]).map((s) => [name(s), s.type ?? 'Opaque', String(Object.keys(s.data ?? {}).length), A(s)]);
      break;
    }
    case 'ServiceAccount': {
      headers = ['NAME', 'SECRETS', 'AGE'];
      rows = objs.map((s) => [name(s), String(((s.secrets as unknown[] | undefined) ?? []).length), A(s)]);
      break;
    }
    case 'Job': {
      headers = ['NAME', 'STATUS', 'COMPLETIONS', 'DURATION', 'AGE'];
      if (o.wide) headers.push('CONTAINERS', 'IMAGES', 'SELECTOR');
      rows = (objs as Job[]).map((j) => {
        const row = [name(j), jobStatus(j), `${j.status.succeeded ?? 0}/${j.spec.completions ?? 1}`, jobDuration(j, o.nowMs), A(j)];
        if (o.wide) row.push(...containersAndImages(j.spec.template.spec.containers), `batch.kubernetes.io/controller-uid=${j.metadata.uid}`);
        return row;
      });
      break;
    }
    case 'CronJob': {
      headers = ['NAME', 'SCHEDULE', 'TIMEZONE', 'SUSPEND', 'ACTIVE', 'LAST SCHEDULE', 'AGE'];
      if (o.wide) headers.push('CONTAINERS', 'IMAGES', 'SELECTOR');
      rows = (objs as CronJob[]).map((c) => {
        const last = c.status.lastScheduleTime ? humanDuration(o.nowMs - Date.parse(c.status.lastScheduleTime)) : '<none>';
        const row = [name(c), c.spec.schedule, c.spec.timeZone ?? '<none>', c.spec.suspend ? 'True' : 'False', String((c.status.active ?? []).length), last, A(c)];
        if (o.wide) row.push(...containersAndImages(c.spec.jobTemplate.spec.template.spec.containers), '<none>');
        return row;
      });
      break;
    }
    case 'Event': {
      headers = ['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'];
      if (o.wide) headers = ['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'SUBOBJECT', 'SOURCE', 'MESSAGE', 'FIRST SEEN', 'COUNT', 'NAME'];
      rows = (objs as Event[]).map((e) => {
        const last = humanDuration(o.nowMs - Date.parse(e.lastTimestamp));
        const obj = `${e.involvedObject.kind.toLowerCase()}/${e.involvedObject.name}`;
        const lastSeen = e.count > 1 ? `${last} (x${e.count} over ${humanDuration(o.nowMs - Date.parse(e.firstTimestamp))})` : last;
        if (o.wide) return [lastSeen, e.type, e.reason, obj, e.involvedObject.fieldPath ?? '', e.source.host ? `${e.source.component}, ${e.source.host}` : e.source.component, e.message, humanDuration(o.nowMs - Date.parse(e.firstTimestamp)), String(e.count), e.metadata.name];
        return [lastSeen, e.type, e.reason, obj, e.message];
      });
      break;
    }
    default: {
      headers = ['NAME', 'AGE'];
      rows = objs.map((x) => [name(x), A(x)]);
    }
  }
  if (o.labelColumns?.length) {
    headers.push(...o.labelColumns.map((l) => l.toUpperCase().replace(/[^A-Z0-9]/g, '-').replace(/^.*\//, '')));
    rows = rows.map((row, i) => [...row, ...(o.labelColumns as string[]).map((l) => objs[i]?.metadata.labels?.[l] ?? '')]);
  }
  if (o.showLabels) {
    headers.push('LABELS');
    rows = rows.map((row, i) => [...row, labelsToString(objs[i]?.metadata.labels)]);
  }
  if (o.withNamespace) {
    headers = ['NAMESPACE', ...headers];
    rows = rows.map((row, i) => [objs[i]?.metadata.namespace ?? '', ...row]);
  }
  return { headers, rows };
}

/** `get cronjobs` helper: when is the next run (used by describe). */
export function cronNext(c: CronJob, nowMs: number): string {
  try {
    const n = nextCronTime(parseCron(c.spec.schedule), nowMs);
    return n ? new Date(n).toISOString() : '<unknown>';
  } catch {
    return '<invalid>';
  }
}
