/** `kubectl describe` renderers (pkg/describe) with the PrefixWriter + tabwriter layout. */
import type { Engine } from '../engine.ts';
import type { KubeObject, Pod, Deployment, ReplicaSet, Service, Node, Namespace, Job, CronJob, DaemonSet, ConfigMap, Endpoints, Container, Probe, Event } from '../types.ts';
import { tabwrite } from './tabwriter.ts';
import { humanDuration, parseCpuMillis, parseMemoryBytes, formatCpuMillis } from '../duration.ts';
import { labelsToString, selectorToString } from '../selector.ts';
import { podStatusReason, nodeStatus, nodeRoles, servicePorts, cronNext } from './printers.ts';
import { activePods } from '../controllers/replicaset.ts';
import { replicaSetsOf, findNewReplicaSet } from '../controllers/deployment.ts';
import { podRequests } from '../controllers/scheduler.ts';
import { jobPods } from '../controllers/job.ts';

const L0 = '', L1 = '  ', L2 = '    ', L3 = '      ';

export function rfc1123(iso: string | undefined): string {
  if (!iso) return '<unset>';
  const d = new Date(iso);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

class W {
  lines: string[] = [];
  write(prefix: string, text: string): void {
    this.lines.push(prefix + text);
  }
  /** Write a key/value where value may be multi-line (continuation lines aligned via tabs). */
  kv(prefix: string, key: string, value: string): void {
    const parts = value.split('\n');
    this.write(prefix, `${key}\t${parts[0]}`);
    for (const p of parts.slice(1)) this.write(prefix, `\t${p}`);
  }
  render(): string {
    return tabwrite(this.lines.join('\n') + '\n', { minwidth: 0, tabwidth: 8, padding: 2 });
  }
}

function mapLines(m: Record<string, string> | undefined, sep = '='): string {
  const entries = Object.entries(m ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  return entries.length ? entries.map(([k, v]) => `${k}${sep}${v}`).join('\n') : '<none>';
}

function annotationLines(m: Record<string, string> | undefined): string {
  const entries = Object.entries(m ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  if (!entries.length) return '<none>';
  return entries.map(([k, v]) => `${k}: ${v.length > 100 ? v.slice(0, 97) + '...' : v}`).join('\n');
}

function describeEvents(w: W, engine: Engine, obj: KubeObject): void {
  const events = engine.store.eventsFor(obj);
  if (!events.length) { w.write(L0, 'Events:\t<none>'); return; }
  w.write(L0, 'Events:');
  w.write(L1, 'Type\tReason\tAge\tFrom\tMessage');
  w.write(L1, '----\t------\t----\t----\t-------');
  const now = engine.clock.nowMs;
  for (const e of events) {
    const last = humanDuration(now - Date.parse(e.lastTimestamp));
    const ageStr = e.count > 1 ? `${last} (x${e.count} over ${humanDuration(now - Date.parse(e.firstTimestamp))})` : last;
    const from = e.source.host ? `${e.source.component}, ${e.source.host}` : e.source.component;
    w.write(L1, `${e.type}\t${e.reason}\t${ageStr}\t${from}\t${e.message.replace(/\n/g, ' ')}`);
  }
}

function probeString(p: Probe): string {
  let s = '';
  if (p.httpGet) s = `http-get ${(p.httpGet.scheme ?? 'HTTP').toLowerCase()}://${p.httpGet.host ?? ''}:${p.httpGet.port}${p.httpGet.path ?? '/'}`;
  else if (p.tcpSocket) s = `tcp-socket :${p.tcpSocket.port}`;
  else if (p.exec) s = `exec [${p.exec.command.join(' ')}]`;
  return `${s} delay=${p.initialDelaySeconds ?? 0}s timeout=${p.timeoutSeconds ?? 1}s period=${p.periodSeconds ?? 10}s #success=${p.successThreshold ?? 1} #failure=${p.failureThreshold ?? 3}`;
}

function describeContainerSpec(w: W, engine: Engine, pod: Pod | undefined, c: Container, prefix: string, status?: NonNullable<Pod['status']['containerStatuses']>[number]): void {
  const P = prefix;
  const P1 = L2; // container fields always sit at 4 spaces (upstream describeContainers)
  w.write(P, `${c.name}:`);
  if (status) {
    w.write(P1, `Container ID:\t${status.containerID ?? ''}`);
    w.write(P1, `Image:\t${c.image}`);
    w.write(P1, `Image ID:\t${status.imageID}`);
  } else w.write(P1, `Image:\t${c.image}`);
  const ports = c.ports ?? [];
  if (ports.length === 0) { w.write(P1, 'Port:\t<none>'); w.write(P1, 'Host Port:\t<none>'); }
  else if (ports.length === 1) { w.write(P1, `Port:\t${ports[0]!.containerPort}/${ports[0]!.protocol ?? 'TCP'}`); w.write(P1, `Host Port:\t${ports[0]!.hostPort ?? 0}/${ports[0]!.protocol ?? 'TCP'}`); }
  else { w.write(P1, `Ports:\t${ports.map((p) => `${p.containerPort}/${p.protocol ?? 'TCP'}`).join(', ')}`); w.write(P1, `Host Ports:\t${ports.map((p) => `${p.hostPort ?? 0}/${p.protocol ?? 'TCP'}`).join(', ')}`); }
  if (c.command) { w.write(P1, 'Command:'); for (const a of c.command) w.write(P1 + '  ', a); }
  if (c.args) { w.write(P1, 'Args:'); for (const a of c.args) w.write(P1 + '  ', a); }
  if (status) {
    const st = status.state;
    if (st.running) { w.write(P1, 'State:\tRunning'); w.write(P1 + '  ', `Started:\t${rfc1123(st.running.startedAt)}`); }
    else if (st.waiting) { w.write(P1, 'State:\tWaiting'); if (st.waiting.reason) w.write(P1 + '  ', `Reason:\t${st.waiting.reason}`); if (st.waiting.message) w.write(P1 + '  ', `Message:\t${st.waiting.message}`); }
    else if (st.terminated) {
      w.write(P1, 'State:\tTerminated');
      if (st.terminated.reason) w.write(P1 + '  ', `Reason:\t${st.terminated.reason}`);
      if (st.terminated.message) w.write(P1 + '  ', `Message:\t${st.terminated.message}`);
      w.write(P1 + '  ', `Exit Code:\t${st.terminated.exitCode}`);
      if (st.terminated.startedAt) w.write(P1 + '  ', `Started:\t${rfc1123(st.terminated.startedAt)}`);
      w.write(P1 + '  ', `Finished:\t${rfc1123(st.terminated.finishedAt)}`);
    }
    const ls = status.lastState;
    if (ls.terminated) {
      w.write(P1, 'Last State:\tTerminated');
      if (ls.terminated.reason) w.write(P1 + '  ', `Reason:\t${ls.terminated.reason}`);
      w.write(P1 + '  ', `Exit Code:\t${ls.terminated.exitCode}`);
      if (ls.terminated.startedAt) w.write(P1 + '  ', `Started:\t${rfc1123(ls.terminated.startedAt)}`);
      w.write(P1 + '  ', `Finished:\t${rfc1123(ls.terminated.finishedAt)}`);
    }
    w.write(P1, `Ready:\t${status.ready ? 'True' : 'False'}`);
    w.write(P1, `Restart Count:\t${status.restartCount}`);
  }
  const lim = c.resources?.limits ?? {}, req = c.resources?.requests ?? {};
  if (Object.keys(lim).length) { w.write(P1, 'Limits:'); for (const k of Object.keys(lim).sort()) w.write(P1 + '  ', `${k}:\t${lim[k]}`); }
  if (Object.keys(req).length) { w.write(P1, 'Requests:'); for (const k of Object.keys(req).sort()) w.write(P1 + '  ', `${k}:\t${req[k]}`); }
  if (c.livenessProbe) w.write(P1, `Liveness:\t${probeString(c.livenessProbe)}`);
  if (c.readinessProbe) w.write(P1, `Readiness:\t${probeString(c.readinessProbe)}`);
  if (c.startupProbe) w.write(P1, `Startup:\t${probeString(c.startupProbe)}`);
  const envFrom = c.envFrom ?? [];
  if (envFrom.length) {
    w.write(P1, 'Environment Variables from:');
    for (const ef of envFrom) {
      if (ef.configMapRef) w.write(P1 + '  ', `${ef.configMapRef.name}\tConfigMap\tOptional: ${ef.configMapRef.optional ?? false}`);
      if (ef.secretRef) w.write(P1 + '  ', `${ef.secretRef.name}\tSecret\tOptional: ${ef.secretRef.optional ?? false}`);
    }
  }
  const env = c.env ?? [];
  if (!env.length) w.write(P1, 'Environment:\t<none>');
  else {
    w.write(P1, 'Environment:');
    for (const e of env) {
      if (e.valueFrom?.configMapKeyRef) w.write(P1 + '  ', `${e.name}:\t<set to the key '${e.valueFrom.configMapKeyRef.key}' of config map '${e.valueFrom.configMapKeyRef.name}'>\tOptional: ${e.valueFrom.configMapKeyRef.optional ?? false}`);
      else if (e.valueFrom?.secretKeyRef) w.write(P1 + '  ', `${e.name}:\t<set to the key '${e.valueFrom.secretKeyRef.key}' in secret '${e.valueFrom.secretKeyRef.name}'>\tOptional: ${e.valueFrom.secretKeyRef.optional ?? false}`);
      else if (e.valueFrom?.fieldRef) w.write(P1 + '  ', `${e.name}:\t (v1:${e.valueFrom.fieldRef.fieldPath})`);
      else w.write(P1 + '  ', `${e.name}:\t${e.value ?? ''}`);
    }
  }
  const mounts = c.volumeMounts ?? [];
  if (!mounts.length) w.write(P1, 'Mounts:\t<none>');
  else {
    w.write(P1, 'Mounts:');
    for (const m of mounts) w.write(P1 + '  ', `${m.mountPath} from ${m.name} (${m.readOnly ? 'ro' : 'rw'})`);
  }
  void engine; void pod;
}

function describeVolumes(w: W, pod: { volumes?: Pod['spec']['volumes'] }, prefix: string): void {
  const vols = pod.volumes ?? [];
  if (!vols.length) { w.write(prefix, 'Volumes:\t<none>'); return; }
  w.write(prefix, 'Volumes:');
  for (const v of vols) {
    w.write(prefix + '  ', `${v.name}:`);
    const P = prefix + '    ';
    if (v.emptyDir !== undefined) { w.write(P, 'Type:\tEmptyDir (a temporary directory that shares a pod\'s lifetime)'); w.write(P, `Medium:\t${(v.emptyDir as { medium?: string }).medium ?? ''}`); w.write(P, `SizeLimit:\t${(v.emptyDir as { sizeLimit?: string }).sizeLimit ?? '<unset>'}`); }
    else if (v.configMap) { w.write(P, 'Type:\tConfigMap (a volume populated by a ConfigMap)'); w.write(P, `Name:\t${v.configMap.name}`); w.write(P, `Optional:\t${v.configMap.optional ?? false}`); }
    else if (v.secret) { w.write(P, 'Type:\tSecret (a volume populated by a Secret)'); w.write(P, `SecretName:\t${v.secret.secretName}`); w.write(P, `Optional:\t${v.secret.optional ?? false}`); }
    else if (v.hostPath) { w.write(P, 'Type:\tHostPath (bare host directory volume)'); w.write(P, `Path:\t${v.hostPath.path}`); w.write(P, `HostPathType:\t${v.hostPath.type ?? ''}`); }
    else if (v.persistentVolumeClaim) { w.write(P, 'Type:\tPersistentVolumeClaim (a reference to a PersistentVolumeClaim in the same namespace)'); w.write(P, `ClaimName:\t${v.persistentVolumeClaim.claimName}`); w.write(P, 'ReadOnly:\tfalse'); }
    else w.write(P, 'Type:\t<unknown>');
  }
}

function tolerationsString(t: Pod['spec']['tolerations']): string {
  if (!t || !t.length) return '<none>';
  return t.map((x) => {
    let s = x.key ?? '';
    if (x.operator === 'Exists' && !x.key) s = '';
    if (x.value) s += `=${x.value}`;
    if (x.effect) s += `:${x.effect}`;
    if ((x.operator ?? 'Equal') === 'Exists') s += ' op=Exists';
    if (x.tolerationSeconds !== undefined) s += ` for ${x.tolerationSeconds}s`;
    return s;
  }).join('\n');
}

export function describePod(engine: Engine, pod: Pod): string {
  const w = new W();
  w.write(L0, `Name:\t${pod.metadata.name}`);
  w.write(L0, `Namespace:\t${pod.metadata.namespace}`);
  w.write(L0, `Priority:\t${pod.spec.priority ?? 0}`);
  if (pod.spec.priorityClassName) w.write(L0, `Priority Class Name:\t${pod.spec.priorityClassName}`);
  w.write(L0, `Service Account:\t${pod.spec.serviceAccountName ?? 'default'}`);
  if (pod.spec.nodeName) w.write(L0, `Node:\t${pod.spec.nodeName}/${pod.status.hostIP ?? ''}`);
  else w.write(L0, 'Node:\t<none>');
  if (pod.status.startTime) w.write(L0, `Start Time:\t${rfc1123(pod.status.startTime)}`);
  w.kv(L0, 'Labels:', mapLines(pod.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(pod.metadata.annotations));
  if (pod.metadata.deletionTimestamp) {
    w.write(L0, `Status:\tTerminating (lasts ${humanDuration(engine.clock.nowMs - Date.parse(pod.metadata.deletionTimestamp))})`);
    w.write(L0, `Termination Grace Period:\t${pod.metadata.deletionGracePeriodSeconds ?? 0}s`);
  } else w.write(L0, `Status:\t${pod.status.phase ?? 'Pending'}`);
  if (pod.status.reason) w.write(L0, `Reason:\t${pod.status.reason}`);
  if (pod.status.message) w.write(L0, `Message:\t${pod.status.message}`);
  w.write(L0, `IP:\t${pod.status.podIP ?? ''}`);
  if (pod.status.podIPs?.length) { w.write(L0, 'IPs:'); for (const ip of pod.status.podIPs) w.write(L1, `IP:\t${ip.ip}`); }
  else w.write(L0, 'IPs:\t<none>');
  const ctrl = pod.metadata.ownerReferences?.find((r) => r.controller);
  if (ctrl) w.write(L0, `Controlled By:\t${ctrl.kind}/${ctrl.name}`);
  w.write(L0, 'Containers:');
  for (const c of pod.spec.containers) describeContainerSpec(w, engine, pod, c, L1, pod.status.containerStatuses?.find((s) => s.name === c.name));
  const conds = pod.status.conditions ?? [];
  if (conds.length) {
    w.write(L0, 'Conditions:');
    w.write(L1, 'Type\tStatus');
    for (const c of conds) w.write(L1, `${c.type} \t${c.status} `);
  }
  describeVolumes(w, pod.spec, L0);
  w.write(L0, `QoS Class:\t${pod.status.qosClass ?? 'BestEffort'}`);
  w.kv(L0, 'Node-Selectors:', mapLines(pod.spec.nodeSelector));
  w.kv(L0, 'Tolerations:', tolerationsString(pod.spec.tolerations));
  describeEvents(w, engine, pod);
  return w.render();
}

function describePodTemplate(w: W, engine: Engine, tpl: Deployment['spec']['template'], prefix: string): void {
  w.write(prefix, 'Pod Template:');
  const P = prefix + '  ';
  w.kv(P, 'Labels:', mapLines(tpl.metadata.labels));
  if (tpl.metadata.annotations && Object.keys(tpl.metadata.annotations).length) w.kv(P, 'Annotations:', annotationLines(tpl.metadata.annotations));
  if (tpl.spec.serviceAccountName && tpl.spec.serviceAccountName !== 'default') w.write(P, `Service Account:\t${tpl.spec.serviceAccountName}`);
  if (tpl.spec.initContainers?.length) { w.write(P, 'Init Containers:'); for (const c of tpl.spec.initContainers) describeContainerSpec(w, engine, undefined, c, P + ' '); }
  w.write(P, 'Containers:');
  for (const c of tpl.spec.containers) describeContainerSpec(w, engine, undefined, c, P + ' ');
  describeVolumes(w, tpl.spec, P);
  w.kv(P, 'Node-Selectors:', mapLines(tpl.spec.nodeSelector));
  w.kv(P, 'Tolerations:', tolerationsString(tpl.spec.tolerations));
}

export function describeDeployment(engine: Engine, d: Deployment): string {
  const w = new W();
  w.write(L0, `Name:\t${d.metadata.name}`);
  w.write(L0, `Namespace:\t${d.metadata.namespace}`);
  w.write(L0, `CreationTimestamp:\t${rfc1123(d.metadata.creationTimestamp)}`);
  w.kv(L0, 'Labels:', mapLines(d.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(d.metadata.annotations));
  w.write(L0, `Selector:\t${selectorToString(d.spec.selector)}`);
  const s = d.status;
  w.write(L0, `Replicas:\t${d.spec.replicas ?? 1} desired | ${s.updatedReplicas ?? 0} updated | ${s.replicas ?? 0} total | ${s.availableReplicas ?? 0} available | ${s.unavailableReplicas ?? 0} unavailable`);
  w.write(L0, `StrategyType:\t${d.spec.strategy?.type ?? 'RollingUpdate'}`);
  w.write(L0, `MinReadySeconds:\t${d.spec.minReadySeconds ?? 0}`);
  if ((d.spec.strategy?.type ?? 'RollingUpdate') === 'RollingUpdate') w.write(L0, `RollingUpdateStrategy:\t${d.spec.strategy?.rollingUpdate?.maxUnavailable ?? '25%'} max unavailable, ${d.spec.strategy?.rollingUpdate?.maxSurge ?? '25%'} max surge`);
  describePodTemplate(w, engine, d.spec.template, L0);
  const conds = s.conditions ?? [];
  if (conds.length) {
    w.write(L0, 'Conditions:');
    w.write(L1, 'Type\tStatus\tReason');
    w.write(L1, '----\t------\t------');
    for (const c of conds) w.write(L1, `${c.type} \t${c.status}\t${c.reason ?? ''}`);
  }
  const rss = replicaSetsOf(engine, d);
  const newRs = findNewReplicaSet(engine, d);
  const old = rss.filter((r) => r !== newRs);
  const rsLine = (rs: ReplicaSet) => `${rs.metadata.name} (${rs.status.replicas ?? 0}/${rs.spec.replicas ?? 0} replicas created)`;
  w.write(L0, `OldReplicaSets:\t${old.length ? old.map(rsLine).join(', ') : '<none>'}`);
  w.write(L0, `NewReplicaSet:\t${newRs ? rsLine(newRs) : '<none>'}`);
  describeEvents(w, engine, d);
  return w.render();
}

function podsStatusLine(pods: Pod[]): string {
  let running = 0, waiting = 0, succeeded = 0, failed = 0;
  for (const p of pods) {
    switch (p.status.phase) { case 'Running': running++; break; case 'Pending': waiting++; break; case 'Succeeded': succeeded++; break; case 'Failed': failed++; break; default: break; }
  }
  return `${running} Running / ${waiting} Waiting / ${succeeded} Succeeded / ${failed} Failed`;
}

export function describeReplicaSet(engine: Engine, rs: ReplicaSet): string {
  const w = new W();
  w.write(L0, `Name:\t${rs.metadata.name}`);
  w.write(L0, `Namespace:\t${rs.metadata.namespace}`);
  w.write(L0, `Selector:\t${selectorToString(rs.spec.selector)}`);
  w.kv(L0, 'Labels:', mapLines(rs.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(rs.metadata.annotations));
  const ctrl = rs.metadata.ownerReferences?.find((r) => r.controller);
  if (ctrl) w.write(L0, `Controlled By:\t${ctrl.kind}/${ctrl.name}`);
  w.write(L0, `Replicas:\t${rs.status.replicas} current / ${rs.spec.replicas ?? 0} desired`);
  w.write(L0, `Pods Status:\t${podsStatusLine(activePods(engine, rs))}`);
  describePodTemplate(w, engine, rs.spec.template, L0);
  describeEvents(w, engine, rs);
  return w.render();
}

export function describeService(engine: Engine, svc: Service): string {
  const w = new W();
  w.write(L0, `Name:\t${svc.metadata.name}`);
  w.write(L0, `Namespace:\t${svc.metadata.namespace}`);
  w.kv(L0, 'Labels:', mapLines(svc.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(svc.metadata.annotations));
  w.write(L0, `Selector:\t${selectorToString(svc.spec.selector, true)}`);
  w.write(L0, `Type:\t${svc.spec.type ?? 'ClusterIP'}`);
  w.write(L0, `IP Family Policy:\t${svc.spec.ipFamilyPolicy ?? 'SingleStack'}`);
  w.write(L0, `IP Families:\t${(svc.spec.ipFamilies ?? ['IPv4']).join(',')}`);
  w.write(L0, `IP:\t${svc.spec.clusterIP ?? ''}`);
  w.write(L0, `IPs:\t${(svc.spec.clusterIPs ?? [svc.spec.clusterIP ?? '']).join(',')}`);
  if (svc.spec.type === 'LoadBalancer') {
    const ing = svc.status.loadBalancer?.ingress ?? [];
    if (ing.length) w.write(L0, `LoadBalancer Ingress:\t${ing.map((i) => i.ip ?? i.hostname).join(', ')}`);
  }
  const ep = engine.store.get<Endpoints>('Endpoints', svc.metadata.namespace, svc.metadata.name);
  for (const p of svc.spec.ports ?? []) {
    const name = p.name ?? '<unset>';
    w.write(L0, `Port:\t${name}\t${p.port}/${p.protocol ?? 'TCP'}`);
    w.write(L0, `TargetPort:\t${p.targetPort ?? p.port}/${p.protocol ?? 'TCP'}`);
    if (p.nodePort) w.write(L0, `NodePort:\t${name}\t${p.nodePort}/${p.protocol ?? 'TCP'}`);
    const addrs: string[] = [];
    for (const s of ep?.subsets ?? []) {
      const port = (s.ports ?? []).find((x) => (x.name ?? '') === (p.name ?? ''));
      if (!port) continue;
      for (const a of s.addresses ?? []) addrs.push(`${a.ip}:${port.port}`);
    }
    w.write(L0, `Endpoints:\t${addrs.length ? (addrs.length > 3 ? `${addrs.slice(0, 3).join(',')} + ${addrs.length - 3} more...` : addrs.join(',')) : '<none>'}`);
  }
  w.write(L0, `Session Affinity:\t${svc.spec.sessionAffinity ?? 'None'}`);
  if (svc.spec.type === 'NodePort' || svc.spec.type === 'LoadBalancer') w.write(L0, `External Traffic Policy:\t${svc.spec.externalTrafficPolicy ?? 'Cluster'}`);
  w.write(L0, `Internal Traffic Policy:\t${svc.spec.internalTrafficPolicy ?? 'Cluster'}`);
  describeEvents(w, engine, svc);
  return w.render();
}

export function describeNode(engine: Engine, node: Node): string {
  const w = new W();
  w.write(L0, `Name:\t${node.metadata.name}`);
  w.write(L0, `Roles:\t${nodeRoles(node)}`);
  w.kv(L0, 'Labels:', mapLines(node.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(node.metadata.annotations));
  w.write(L0, `CreationTimestamp:\t${rfc1123(node.metadata.creationTimestamp)}`);
  w.kv(L0, 'Taints:', node.spec.taints?.length ? node.spec.taints.map((t) => `${t.key}${t.value ? '=' + t.value : ''}:${t.effect}`).join('\n') : '<none>');
  w.write(L0, `Unschedulable:\t${node.spec.unschedulable ?? false}`);
  w.write(L0, 'Lease:');
  w.write(L1, `HolderIdentity:\t${node.metadata.name}`);
  w.write(L1, 'AcquireTime:\t<unset>');
  w.write(L1, `RenewTime:\t${rfc1123(engine.clock.iso())}`);
  w.write(L0, 'Conditions:');
  w.write(L1, 'Type\tStatus\tLastHeartbeatTime\tLastTransitionTime\tReason\tMessage');
  w.write(L1, '----\t------\t-----------------\t------------------\t------\t-------');
  for (const c of node.status.conditions) w.write(L1, `${c.type} \t${c.status} \t${rfc1123((c as { lastHeartbeatTime?: string }).lastHeartbeatTime)} \t${rfc1123(c.lastTransitionTime)} \t${c.reason ?? ''} \t${c.message ?? ''}`);
  w.write(L0, 'Addresses:');
  for (const a of node.status.addresses) w.write(L1, `${a.type}:\t${a.address}`);
  w.write(L0, 'Capacity:');
  for (const k of Object.keys(node.status.capacity).sort()) w.write(L1, `${k}:\t${node.status.capacity[k]}`);
  w.write(L0, 'Allocatable:');
  for (const k of Object.keys(node.status.allocatable).sort()) w.write(L1, `${k}:\t${node.status.allocatable[k]}`);
  w.write(L0, 'System Info:');
  const ni = node.status.nodeInfo;
  w.write(L1, `Machine ID:\t${ni.machineID ?? ''}`);
  w.write(L1, `System UUID:\t${ni.systemUUID ?? ''}`);
  w.write(L1, `Boot ID:\t${ni.bootID ?? ''}`);
  w.write(L1, `Kernel Version:\t${ni.kernelVersion}`);
  w.write(L1, `OS Image:\t${ni.osImage}`);
  w.write(L1, `Operating System:\t${ni.operatingSystem}`);
  w.write(L1, `Architecture:\t${ni.architecture}`);
  w.write(L1, `Container Runtime Version:\t${ni.containerRuntimeVersion}`);
  w.write(L1, `Kubelet Version:\t${ni.kubeletVersion}`);
  w.write(L1, `Kube-Proxy Version:\t${ni.kubeProxyVersion ?? ni.kubeletVersion}`);
  w.write(L0, `PodCIDR:\t${node.spec.podCIDR ?? ''}`);
  w.write(L0, 'PodCIDRs:\t' + (node.spec.podCIDRs ?? []).join(','));
  const pods = engine.store.list<Pod>('Pod').filter((p) => p.spec.nodeName === node.metadata.name && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed');
  w.write(L0, `Non-terminated Pods:\t(${pods.length} in total)`);
  w.write(L1, 'Namespace\tName\tCPU Requests\tCPU Limits\tMemory Requests\tMemory Limits\tAge');
  w.write(L1, '---------\t----\t------------\t----------\t---------------\t-------------\t---');
  const allocCpu = parseCpuMillis(node.status.allocatable.cpu ?? '0');
  const allocMem = parseMemoryBytes(node.status.allocatable.memory ?? '0');
  let cpuR = 0, cpuL = 0, memR = 0, memL = 0;
  const pct = (v: number, total: number) => (total ? `${Math.round((v / total) * 100)}%` : '0%');
  const memStr = (b: number) => (b % (1024 ** 2) === 0 ? `${b / 1024 ** 2}Mi` : b % 1024 === 0 ? `${b / 1024}Ki` : `${b}`);
  for (const p of pods) {
    const r = podRequests(p);
    let lc = 0, lm = 0;
    for (const c of p.spec.containers) { if (c.resources?.limits?.cpu !== undefined) lc += parseCpuMillis(c.resources.limits.cpu); if (c.resources?.limits?.memory !== undefined) lm += parseMemoryBytes(c.resources.limits.memory); }
    cpuR += r.cpu; cpuL += lc; memR += r.mem; memL += lm;
    w.write(L1, `${p.metadata.namespace}\t${p.metadata.name}\t${formatCpuMillis(r.cpu)} (${pct(r.cpu, allocCpu)})\t${formatCpuMillis(lc)} (${pct(lc, allocCpu)})\t${memStr(r.mem)} (${pct(r.mem, allocMem)})\t${memStr(lm)} (${pct(lm, allocMem)})\t${humanDuration(engine.clock.nowMs - Date.parse(p.metadata.creationTimestamp ?? ''))}`);
  }
  w.write(L0, 'Allocated resources:');
  w.write(L1, '(Total limits may be over 100 percent, i.e., overcommitted.)');
  w.write(L1, 'Resource\tRequests\tLimits');
  w.write(L1, '--------\t--------\t------');
  w.write(L1, `cpu\t${formatCpuMillis(cpuR)} (${pct(cpuR, allocCpu)})\t${formatCpuMillis(cpuL)} (${pct(cpuL, allocCpu)})`);
  w.write(L1, `memory\t${memStr(memR)} (${pct(memR, allocMem)})\t${memStr(memL)} (${pct(memL, allocMem)})`);
  w.write(L1, 'ephemeral-storage\t0 (0%)\t0 (0%)');
  describeEvents(w, engine, node);
  return w.render();
}

export function describeNamespace(engine: Engine, ns: Namespace): string {
  const w = new W();
  w.write(L0, `Name:\t${ns.metadata.name}`);
  w.kv(L0, 'Labels:', mapLines(ns.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(ns.metadata.annotations));
  w.write(L0, `Status:\t${ns.status?.phase ?? 'Active'}`);
  w.write(L0, '');
  w.write(L0, 'No resource quota.');
  w.write(L0, '');
  w.write(L0, 'No LimitRange resource.');
  void engine;
  return w.render();
}

export function describeJob(engine: Engine, job: Job): string {
  const w = new W();
  w.write(L0, `Name:\t${job.metadata.name}`);
  w.write(L0, `Namespace:\t${job.metadata.namespace}`);
  w.write(L0, `Selector:\tbatch.kubernetes.io/controller-uid=${job.metadata.uid}`);
  w.kv(L0, 'Labels:', mapLines(job.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(job.metadata.annotations));
  const ctrl = job.metadata.ownerReferences?.find((r) => r.controller);
  if (ctrl) w.write(L0, `Controlled By:\t${ctrl.kind}/${ctrl.name}`);
  w.write(L0, `Parallelism:\t${job.spec.parallelism ?? 1}`);
  w.write(L0, `Completions:\t${job.spec.completions ?? 1}`);
  w.write(L0, `Completion Mode:\t${job.spec.completionMode ?? 'NonIndexed'}`);
  if (job.status.startTime) w.write(L0, `Start Time:\t${rfc1123(job.status.startTime)}`);
  if (job.status.completionTime) w.write(L0, `Completed At:\t${rfc1123(job.status.completionTime)}`);
  if (job.status.startTime) w.write(L0, `Duration:\t${humanDuration((job.status.completionTime ? Date.parse(job.status.completionTime) : engine.clock.nowMs) - Date.parse(job.status.startTime))}`);
  w.write(L0, `Pods Statuses:\t${job.status.active ?? 0} Active (${job.status.ready ?? 0} Ready) / ${job.status.succeeded ?? 0} Succeeded / ${job.status.failed ?? 0} Failed`);
  describePodTemplate(w, engine, job.spec.template, L0);
  void jobPods;
  describeEvents(w, engine, job);
  return w.render();
}

export function describeCronJob(engine: Engine, cj: CronJob): string {
  const w = new W();
  w.write(L0, `Name:\t${cj.metadata.name}`);
  w.write(L0, `Namespace:\t${cj.metadata.namespace}`);
  w.kv(L0, 'Labels:', mapLines(cj.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(cj.metadata.annotations));
  w.write(L0, `Schedule:\t${cj.spec.schedule}`);
  w.write(L0, `Concurrency Policy:\t${cj.spec.concurrencyPolicy ?? 'Allow'}`);
  w.write(L0, `Suspend:\t${cj.spec.suspend ?? false}`);
  w.write(L0, `Successful Job History Limit:\t${cj.spec.successfulJobsHistoryLimit ?? 3}`);
  w.write(L0, `Failed Job History Limit:\t${cj.spec.failedJobsHistoryLimit ?? 1}`);
  w.write(L0, `Starting Deadline Seconds:\t${cj.spec.startingDeadlineSeconds ?? '<unset>'}`);
  w.write(L0, `Selector:\t<unset>`);
  w.write(L0, `Parallelism:\t${cj.spec.jobTemplate.spec.parallelism ?? '<unset>'}`);
  w.write(L0, `Completions:\t${cj.spec.jobTemplate.spec.completions ?? '<unset>'}`);
  w.write(L0, `Next Schedule:\t${cronNext(cj, engine.clock.nowMs)}`);
  describePodTemplate(w, engine, cj.spec.jobTemplate.spec.template, L0);
  w.write(L0, `Last Schedule Time:\t${cj.status.lastScheduleTime ? rfc1123(cj.status.lastScheduleTime) : '<unset>'}`);
  w.write(L0, `Active Jobs:\t${(cj.status.active ?? []).map((a) => a.name).join(', ') || '<none>'}`);
  describeEvents(w, engine, cj);
  return w.render();
}

export function describeDaemonSet(engine: Engine, ds: DaemonSet): string {
  const w = new W();
  w.write(L0, `Name:\t${ds.metadata.name}`);
  w.write(L0, `Selector:\t${selectorToString(ds.spec.selector)}`);
  w.write(L0, `Node-Selector:\t${selectorToString(ds.spec.template.spec.nodeSelector, true)}`);
  w.kv(L0, 'Labels:', mapLines(ds.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(ds.metadata.annotations));
  const s = ds.status;
  w.write(L0, `Desired Number of Nodes Scheduled: ${s.desiredNumberScheduled}`);
  w.write(L0, `Current Number of Nodes Scheduled: ${s.currentNumberScheduled}`);
  w.write(L0, `Number of Nodes Scheduled with Up-to-date Pods: ${s.updatedNumberScheduled ?? 0}`);
  w.write(L0, `Number of Nodes Scheduled with Available Pods: ${s.numberAvailable ?? 0}`);
  w.write(L0, `Number of Nodes Misscheduled: ${s.numberMisscheduled}`);
  w.write(L0, `Pods Status:\t${podsStatusLine(engine.store.ownedBy<Pod>(ds, 'Pod'))}`);
  describePodTemplate(w, engine, ds.spec.template, L0);
  describeEvents(w, engine, ds);
  return w.render();
}

export function describeConfigMap(engine: Engine, cm: ConfigMap): string {
  const w = new W();
  w.write(L0, `Name:\t${cm.metadata.name}`);
  w.write(L0, `Namespace:\t${cm.metadata.namespace}`);
  w.kv(L0, 'Labels:', mapLines(cm.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(cm.metadata.annotations));
  w.write(L0, '');
  w.write(L0, 'Data');
  w.write(L0, '====');
  for (const k of Object.keys(cm.data ?? {}).sort()) {
    w.write(L0, `${k}:`);
    w.write(L0, '----');
    w.write(L0, (cm.data as Record<string, string>)[k] as string);
    w.write(L0, '');
  }
  w.write(L0, '');
  w.write(L0, 'BinaryData');
  w.write(L0, '====');
  w.write(L0, '');
  describeEvents(w, engine, cm);
  return w.render();
}

export function describeEndpoints(engine: Engine, ep: Endpoints): string {
  const w = new W();
  w.write(L0, `Name:\t${ep.metadata.name}`);
  w.write(L0, `Namespace:\t${ep.metadata.namespace}`);
  w.kv(L0, 'Labels:', mapLines(ep.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(ep.metadata.annotations));
  w.write(L0, 'Subsets:');
  for (const s of ep.subsets ?? []) {
    w.write(L1, `Addresses:\t${(s.addresses ?? []).map((a) => a.ip).join(',') || '<none>'}`);
    w.write(L1, `NotReadyAddresses:\t${(s.notReadyAddresses ?? []).map((a) => a.ip).join(',') || '<none>'}`);
    w.write(L1, 'Ports:');
    w.write(L2, 'Name\tPort\tProtocol');
    w.write(L2, '----\t----\t--------');
    for (const p of s.ports ?? []) w.write(L2, `${p.name ?? '<unset>'}\t${p.port}\t${p.protocol ?? 'TCP'}`);
    w.write(L0, '');
  }
  describeEvents(w, engine, ep);
  return w.render();
}

export function describeGeneric(engine: Engine, obj: KubeObject): string {
  const w = new W();
  w.write(L0, `Name:\t${obj.metadata.name}`);
  if (obj.metadata.namespace) w.write(L0, `Namespace:\t${obj.metadata.namespace}`);
  w.kv(L0, 'Labels:', mapLines(obj.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(obj.metadata.annotations));
  w.write(L0, `API Version:\t${obj.apiVersion}`);
  w.write(L0, `Kind:\t${obj.kind}`);
  describeEvents(w, engine, obj);
  return w.render();
}

export function describe(engine: Engine, obj: KubeObject): string {
  switch (obj.kind) {
    case 'Pod': return describePod(engine, obj as Pod);
    case 'Deployment': return describeDeployment(engine, obj as Deployment);
    case 'ReplicaSet': return describeReplicaSet(engine, obj as ReplicaSet);
    case 'Service': return describeService(engine, obj as Service);
    case 'Node': return describeNode(engine, obj as Node);
    case 'Namespace': return describeNamespace(engine, obj as Namespace);
    case 'Job': return describeJob(engine, obj as Job);
    case 'CronJob': return describeCronJob(engine, obj as CronJob);
    case 'DaemonSet': return describeDaemonSet(engine, obj as DaemonSet);
    case 'ConfigMap': return describeConfigMap(engine, obj as ConfigMap);
    case 'Endpoints': return describeEndpoints(engine, obj as Endpoints);
    default: return describeGeneric(engine, obj);
  }
}

export function describeEvent(e: Event): string {
  return `${e.type} ${e.reason} ${e.message}`;
}
void podStatusReason; void nodeStatus; void servicePorts; void labelsToString;
