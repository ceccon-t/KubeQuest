/** `kubectl describe` layouts for the kinds added after the MVP (staging/src/k8s.io/kubectl/pkg/describe/describe.go, release-1.32). */
import type { Engine } from '../engine.ts';
import type { KubeObject, Ingress, IngressBackend, NetworkPolicy, NetworkPolicyPeer, NetworkPolicyPort, PersistentVolume, PersistentVolumeClaim, StorageClass, StatefulSet, HorizontalPodAutoscaler, PodDisruptionBudget, ResourceQuota, LimitRange, Role, RoleBinding, PriorityClass, Secret, Pod, Service } from '../types.ts';
import { W, mapLines, annotationLines, describeEvents, describePodTemplate, podsStatusLine, rfc1123 } from './describe.ts';
import { selectorToString, labelsToString } from '../selector.ts';
import { accessModes, isDefaultStorageClass, ingressAddress } from './printers-ext.ts';
import { humanDuration } from '../duration.ts';

const L0 = '', L1 = '  ', L2 = '    ';

/** upstream: smartLabelFor — camelCase → "Title Case" with common acronyms upper-cased. */
function smartLabel(field: string): string {
  if (/[^A-Za-z-]/.test(field)) return field;
  const parts = field.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|-/g) ?? [field];
  return parts.map((p) => (['API', 'URL', 'UID', 'OSB', 'GUID'].includes(p.toUpperCase()) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1))).join(' ');
}

const SKIP = new Set(['.metadata.managedFields', '.metadata.name', '.metadata.namespace', '.metadata.labels', '.metadata.annotations']);

/** upstream: printUnstructuredContent (the generic describer used for custom resources). */
export function describeUnstructured(w: W, level: number, content: Record<string, unknown>, prefix: string): void {
  const pad = '  '.repeat(level);
  for (const field of Object.keys(content).sort()) {
    const value = content[field];
    const expr = `${prefix}.${field}`;
    if (SKIP.has(expr)) continue;
    if (Array.isArray(value)) {
      w.write(pad, `${smartLabel(field)}:`);
      for (const child of value) {
        if (child && typeof child === 'object' && !Array.isArray(child)) describeUnstructured(w, level + 1, child as Record<string, unknown>, expr);
        else w.write(pad + '  ', String(child));
      }
    } else if (value && typeof value === 'object') {
      w.write(pad, `${smartLabel(field)}:`);
      describeUnstructured(w, level + 1, value as Record<string, unknown>, expr);
    } else w.write(pad, `${smartLabel(field)}:\t${value === null ? '<nil>' : String(value)}`);
  }
}

function sliceEndpoints(engine: Engine, ns: string | undefined, svcName: string, portName: string): string {
  const addrs: string[] = [];
  for (const es of engine.store.list('EndpointSlice', ns)) {
    if (es.metadata.labels?.['kubernetes.io/service-name'] !== svcName) continue;
    const ports = ((es.ports as { name?: string; port: number }[] | undefined) ?? []).filter((p) => (p.name ?? '') === portName);
    for (const ep of (es.endpoints as { addresses: string[]; conditions?: { ready?: boolean } }[] | undefined) ?? []) {
      if (ep.conditions?.ready === false) continue;
      for (const a of ep.addresses) for (const p of ports) addrs.push(`${a}:${p.port}`);
    }
  }
  if (!addrs.length) return '<none>';
  return addrs.length > 3 ? `${addrs.slice(0, 3).join(',')} + ${addrs.length - 3} more...` : addrs.join(',');
}

function backendString(engine: Engine, ns: string | undefined, b: IngressBackend | undefined): string {
  if (!b?.service) return '';
  const port = b.service.port?.number !== undefined ? String(b.service.port.number) : (b.service.port?.name ?? '');
  const sb = `${b.service.name}:${port}`;
  const svc = engine.store.get<Service>('Service', ns, b.service.name);
  if (!svc) return `${sb} (<error: services "${b.service.name}" not found>)`;
  let spName = '';
  for (const sp of svc.spec.ports ?? []) if ((b.service.port?.number !== undefined && b.service.port.number === sp.port) || (b.service.port?.name && b.service.port.name === sp.name)) spName = sp.name ?? '';
  return `${sb} (${sliceEndpoints(engine, ns, b.service.name, spName)})`;
}

function describeIngress(engine: Engine, ing: Ingress): string {
  const w = new W();
  w.write(L0, `Name:\t${ing.metadata.name}`);
  w.kv(L0, 'Labels:', mapLines(ing.metadata.labels));
  w.write(L0, `Namespace:\t${ing.metadata.namespace}`);
  w.write(L0, `Address:\t${ingressAddress(ing)}`);
  w.write(L0, `Ingress Class:\t${ing.spec.ingressClassName ?? '<none>'}`);
  w.write(L0, `Default backend:\t${ing.spec.defaultBackend ? backendString(engine, ing.metadata.namespace, ing.spec.defaultBackend) : '<default>'}`);
  if (ing.spec.tls?.length) {
    w.write(L0, 'TLS:');
    for (const t of ing.spec.tls) w.write(L1, t.secretName ? `${t.secretName} terminates ${(t.hosts ?? []).join(',')}` : `SNI routes ${(t.hosts ?? []).join(',')}`);
  }
  w.write(L0, 'Rules:');
  w.write(L1, 'Host\tPath\tBackends');
  w.write(L1, '----\t----\t--------');
  let any = false;
  for (const r of ing.spec.rules ?? []) {
    if (!r.http) continue;
    any = true;
    w.write(L1, `${r.host || '*'}\t`);
    for (const p of r.http.paths) w.write(L2, `\t${p.path ?? ''} \t${backendString(engine, ing.metadata.namespace, p.backend)}`);
  }
  if (!any) w.write(L1, `*\t*\t${ing.spec.defaultBackend ? backendString(engine, ing.metadata.namespace, ing.spec.defaultBackend) : '<default>'}`);
  w.kv(L0, 'Annotations:', annotationLines(ing.metadata.annotations));
  describeEvents(w, engine, ing);
  return w.render();
}

function npPorts(w: W, ports: NetworkPolicyPort[] | undefined, word: 'To' | 'From'): void {
  void word;
  if (!ports?.length) { w.write(L2, 'To Port: <any> (traffic allowed to all ports)'); return; }
  for (const p of ports) w.write(L2, p.endPort === undefined ? `To Port: ${p.port ?? ''}/${p.protocol ?? 'TCP'}` : `To Port Range: ${p.port ?? ''}-${p.endPort}/${p.protocol ?? 'TCP'}`);
}

function npPeers(w: W, peers: NetworkPolicyPeer[] | undefined, word: 'From' | 'To'): void {
  if (!peers?.length) { w.write(L2, word === 'From' ? 'From: <any> (traffic not restricted by source)' : 'To: <any> (traffic not restricted by destination)'); return; }
  for (const p of peers) {
    w.write(L2, `${word}:`);
    if (p.podSelector && p.namespaceSelector) { w.write(L2 + L1, `NamespaceSelector: ${selectorToString(p.namespaceSelector)}`); w.write(L2 + L1, `PodSelector: ${selectorToString(p.podSelector)}`); }
    else if (p.podSelector) w.write(L2 + L1, `PodSelector: ${selectorToString(p.podSelector)}`);
    else if (p.namespaceSelector) w.write(L2 + L1, `NamespaceSelector: ${selectorToString(p.namespaceSelector)}`);
    else if (p.ipBlock) { w.write(L2 + L1, 'IPBlock:'); w.write(L2 + L2, `CIDR: ${p.ipBlock.cidr}`); w.write(L2 + L2, `Except: ${(p.ipBlock.except ?? []).join(', ')}`); }
  }
}

function describeNetworkPolicy(np: NetworkPolicy): string {
  const w = new W();
  w.write(L0, `Name:\t${np.metadata.name}`);
  w.write(L0, `Namespace:\t${np.metadata.namespace}`);
  w.write(L0, `Created on:\t${(np.metadata.creationTimestamp ?? '').replace('T', ' ').replace(/(\.\d+)?Z$/, ' +0000 UTC')}`);
  w.kv(L0, 'Labels:', mapLines(np.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(np.metadata.annotations));
  w.write(L0, 'Spec:');
  const sel = np.spec.podSelector ?? {};
  const empty = !Object.keys(sel.matchLabels ?? {}).length && !(sel.matchExpressions ?? []).length;
  w.write(L1, `PodSelector:     ${empty ? '<none> (Allowing the specific traffic to all pods in this namespace)' : selectorToString(sel)}`);
  const types = np.spec.policyTypes ?? [];
  if (types.includes('Ingress')) {
    w.write(L1, 'Allowing ingress traffic:');
    const rules = np.spec.ingress ?? [];
    if (!rules.length) w.write(L2, '<none> (Selected pods are isolated for ingress connectivity)');
    rules.forEach((r, i) => { npPorts(w, r.ports, 'To'); npPeers(w, r.from, 'From'); if (i !== rules.length - 1) w.write(L2, '----------'); });
  } else w.write(L1, 'Not affecting ingress traffic');
  if (types.includes('Egress')) {
    w.write(L1, 'Allowing egress traffic:');
    const rules = np.spec.egress ?? [];
    if (!rules.length) w.write(L2, '<none> (Selected pods are isolated for egress connectivity)');
    rules.forEach((r, i) => { npPorts(w, r.ports, 'To'); npPeers(w, r.to, 'To'); if (i !== rules.length - 1) w.write(L2, '----------'); });
  } else w.write(L1, 'Not affecting egress traffic');
  w.write(L1, `Policy Types: ${types.length ? types.join(', ') : '<none>'}`);
  return w.render();
}

function describePvc(engine: Engine, c: PersistentVolumeClaim): string {
  const w = new W();
  w.write(L0, `Name:\t${c.metadata.name}`);
  w.write(L0, `Namespace:\t${c.metadata.namespace}`);
  w.write(L0, `StorageClass:\t${c.spec.storageClassName ?? ''}`);
  w.write(L0, `Status:\t${c.metadata.deletionTimestamp ? `Terminating (lasts ${humanDuration(engine.clock.nowMs - Date.parse(c.metadata.deletionTimestamp))})` : (c.status?.phase ?? 'Pending')}`);
  w.write(L0, `Volume:\t${c.spec.volumeName ?? ''}`);
  w.kv(L0, 'Labels:', mapLines(c.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(c.metadata.annotations));
  w.write(L0, `Finalizers:\t[${(c.metadata.finalizers ?? []).join(' ')}]`);
  const bound = !!c.spec.volumeName;
  w.write(L0, `Capacity:\t${bound ? (c.status?.capacity?.storage ?? '') : ''}`);
  w.write(L0, `Access Modes:\t${bound ? accessModes(c.status?.accessModes) : ''}`);
  if (c.spec.volumeMode) w.write(L0, `VolumeMode:\t${c.spec.volumeMode}`);
  const users = engine.store.list<Pod>('Pod', c.metadata.namespace).filter((p) => p.spec.volumes?.some((v) => v.persistentVolumeClaim?.claimName === c.metadata.name)).map((p) => p.metadata.name).sort();
  w.kv(L0, 'Used By:', users.length ? users.join('\n') : '<none>');
  describeEvents(w, engine, c);
  return w.render();
}

function describePv(engine: Engine, p: PersistentVolume): string {
  const w = new W();
  w.write(L0, `Name:\t${p.metadata.name}`);
  w.kv(L0, 'Labels:', mapLines(p.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(p.metadata.annotations));
  w.write(L0, `Finalizers:\t[${(p.metadata.finalizers ?? []).join(' ')}]`);
  w.write(L0, `StorageClass:\t${p.spec.storageClassName ?? ''}`);
  w.write(L0, `Status:\t${p.status?.phase ?? ''}`);
  w.write(L0, `Claim:\t${p.spec.claimRef ? `${p.spec.claimRef.namespace}/${p.spec.claimRef.name}` : ''}`);
  w.write(L0, `Reclaim Policy:\t${p.spec.persistentVolumeReclaimPolicy ?? ''}`);
  w.write(L0, `Access Modes:\t${accessModes(p.spec.accessModes)}`);
  if (p.spec.volumeMode) w.write(L0, `VolumeMode:\t${p.spec.volumeMode}`);
  w.write(L0, `Capacity:\t${p.spec.capacity?.storage ?? ''}`);
  w.write(L0, 'Node Affinity:\t<none>');
  w.write(L0, 'Message:\t');
  w.write(L0, 'Source:');
  if (p.spec.csi) {
    w.write(L2, 'Type:\tCSI (a Container Storage Interface (CSI) volume source)');
    w.write(L2, `Driver:\t${p.spec.csi.driver}`);
    w.write(L2, `FSType:\t${p.spec.csi.fsType ?? ''}`);
    w.write(L2, `VolumeHandle:\t${p.spec.csi.volumeHandle}`);
    w.write(L2, 'ReadOnly:\tfalse');
    w.write(L2, 'VolumeAttributes:\t<none>');
  } else if (p.spec.hostPath) {
    w.write(L2, 'Type:\tHostPath (bare host directory volume)');
    w.write(L2, `Path:\t${p.spec.hostPath.path}`);
    w.write(L2, 'HostPathType:\t');
  }
  describeEvents(w, engine, p);
  return w.render();
}

function describeStorageClass(engine: Engine, s: StorageClass): string {
  const w = new W();
  w.write(L0, `Name:\t${s.metadata.name}`);
  w.write(L0, `IsDefaultClass:\t${isDefaultStorageClass(s) ? 'Yes' : 'No'}`);
  w.write(L0, `Annotations:\t${labelsToString(s.metadata.annotations)}`);
  w.write(L0, `Provisioner:\t${s.provisioner}`);
  w.write(L0, `Parameters:\t${labelsToString(s.parameters)}`);
  w.write(L0, `AllowVolumeExpansion:\t${s.allowVolumeExpansion === undefined ? '<unset>' : s.allowVolumeExpansion ? 'True' : 'False'}`);
  w.write(L0, 'MountOptions:\t<none>');
  if (s.reclaimPolicy) w.write(L0, `ReclaimPolicy:\t${s.reclaimPolicy}`);
  if (s.volumeBindingMode) w.write(L0, `VolumeBindingMode:\t${s.volumeBindingMode}`);
  describeEvents(w, engine, s);
  return w.render();
}

function describeStatefulSet(engine: Engine, s: StatefulSet): string {
  const w = new W();
  w.write(L0, `Name:\t${s.metadata.name}`);
  w.write(L0, `Namespace:\t${s.metadata.namespace}`);
  w.write(L0, `CreationTimestamp:\t${rfc1123(s.metadata.creationTimestamp)}`);
  w.write(L0, `Selector:\t${selectorToString(s.spec.selector)}`);
  w.kv(L0, 'Labels:', mapLines(s.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(s.metadata.annotations));
  w.write(L0, `Replicas:\t${s.spec.replicas ?? 1} desired | ${s.status.replicas ?? 0} total`);
  w.write(L0, `Update Strategy:\t${s.spec.updateStrategy?.type ?? 'RollingUpdate'}`);
  if (s.spec.updateStrategy?.rollingUpdate?.partition !== undefined) w.write(L1, `Partition:\t${s.spec.updateStrategy.rollingUpdate.partition}`);
  w.write(L0, `Pods Status:\t${podsStatusLine(engine.store.ownedBy<Pod>(s, 'Pod'))}`);
  describePodTemplate(w, engine, s.spec.template, L0);
  const vcts = s.spec.volumeClaimTemplates ?? [];
  if (!vcts.length) w.write(L0, 'Volume Claims:\t<none>');
  else {
    w.write(L0, 'Volume Claims:');
    for (const t of vcts) {
      w.write(L1, `Name:\t${t.metadata.name}`);
      w.write(L1, `StorageClass:\t${t.spec.storageClassName ?? ''}`);
      w.write(L1, `Labels:\t${labelsToString(t.metadata.labels)}`);
      w.write(L1, `Annotations:\t${labelsToString(t.metadata.annotations)}`);
      w.write(L1, `Capacity:\t${t.spec.resources?.requests?.storage ?? '<default>'}`);
      w.write(L1, `Access Modes:\t[${(t.spec.accessModes ?? []).join(' ')}]`);
    }
  }
  describeEvents(w, engine, s);
  return w.render();
}

function describeHpa(engine: Engine, h: HorizontalPodAutoscaler): string {
  const w = new W();
  w.write(L0, `Name:\t${h.metadata.name}`);
  w.write(L0, `Namespace:\t${h.metadata.namespace}`);
  w.kv(L0, 'Labels:', mapLines(h.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(h.metadata.annotations));
  w.write(L0, `CreationTimestamp:\t${rfc1123(h.metadata.creationTimestamp)}`);
  w.write(L0, `Reference:\t${h.spec.scaleTargetRef.kind}/${h.spec.scaleTargetRef.name}`);
  w.write(L0, 'Metrics:\t( current / target )');
  (h.spec.metrics ?? []).forEach((m, i) => {
    const st = h.status.currentMetrics?.[i];
    if (m.type === 'Resource' && m.resource) {
      const t = m.resource.target;
      if (t.averageValue !== undefined) w.write(L1, `resource ${m.resource.name} on pods:\t${st?.resource?.current.averageValue ?? '<unknown>'} / ${t.averageValue}`);
      else {
        const cur = st?.resource?.current;
        const current = cur?.averageUtilization !== undefined ? `${cur.averageUtilization}% (${cur.averageValue ?? ''})` : '<unknown>';
        w.write(L1, `resource ${m.resource.name} on pods  (as a percentage of request):\t${current} / ${t.averageUtilization !== undefined ? `${t.averageUtilization}%` : '<auto>'}`);
      }
    } else if (m.type === 'Pods' && m.pods) w.write(L1, `"${m.pods.metric.name}" on pods:\t${st?.pods?.current.averageValue ?? '<unknown>'} / ${m.pods.target.averageValue ?? ''}`);
  });
  w.write(L0, `Min replicas:\t${h.spec.minReplicas ?? '<unset>'}`);
  w.write(L0, `Max replicas:\t${h.spec.maxReplicas}`);
  w.write(L0, `${h.spec.scaleTargetRef.kind} pods:\t${h.status.currentReplicas ?? 0} current / ${h.status.desiredReplicas ?? 0} desired`);
  const conds = h.status.conditions ?? [];
  if (conds.length) {
    w.write(L0, 'Conditions:');
    w.write(L1, 'Type\tStatus\tReason\tMessage');
    w.write(L1, '----\t------\t------\t-------');
    for (const c of conds) w.write(L1, `${c.type}\t${c.status}\t${c.reason ?? ''}\t${c.message ?? ''}`);
  }
  describeEvents(w, engine, h);
  return w.render();
}

function describePdb(engine: Engine, p: PodDisruptionBudget): string {
  const w = new W();
  w.write(L0, `Name:\t${p.metadata.name}`);
  w.write(L0, `Namespace:\t${p.metadata.namespace}`);
  if (p.spec.minAvailable !== undefined) w.write(L0, `Min available:\t${p.spec.minAvailable}`);
  else if (p.spec.maxUnavailable !== undefined) w.write(L0, `Max unavailable:\t${p.spec.maxUnavailable}`);
  w.write(L0, `Selector:\t${p.spec.selector ? selectorToString(p.spec.selector) : '<unset>'}`);
  w.write(L0, 'Status:');
  w.write(L2, `Allowed disruptions:\t${p.status?.disruptionsAllowed ?? 0}`);
  w.write(L2, `Current:\t${p.status?.currentHealthy ?? 0}`);
  w.write(L2, `Desired:\t${p.status?.desiredHealthy ?? 0}`);
  w.write(L2, `Total:\t${p.status?.expectedPods ?? 0}`);
  describeEvents(w, engine, p);
  return w.render();
}

function quotaRows(w: W, q: ResourceQuota, prefix: string, dashes: string): void {
  w.write(prefix, 'Resource\tUsed\tHard');
  w.write(prefix, `--------\t${dashes}\t${dashes}`);
  const hard = q.status?.hard ?? {};
  for (const k of Object.keys(hard).sort()) w.write(prefix, `${k}\t${q.status?.used?.[k] ?? '0'}\t${hard[k]}`);
}

const LIMITS_HEAD = 'Type\tResource\tMin\tMax\tDefault Request\tDefault Limit\tMax Limit/Request Ratio';
const LIMITS_SEP = '----\t--------\t---\t---\t---------------\t-------------\t-----------------------';
function limitRows(w: W, lr: LimitRange, prefix: string): void {
  for (const item of lr.spec.limits ?? []) {
    const names = new Set<string>();
    for (const m of [item.min, item.max, item.defaultRequest, item.default, item.maxLimitRequestRatio]) for (const k of Object.keys(m ?? {})) names.add(k);
    for (const k of [...names].sort()) w.write(prefix, `${item.type}\t${k}\t${item.min?.[k] ?? '-'}\t${item.max?.[k] ?? '-'}\t${item.defaultRequest?.[k] ?? '-'}\t${item.default?.[k] ?? '-'}\t${item.maxLimitRequestRatio?.[k] ?? '-'}`);
  }
}

/** `describe namespace`: the Resource Quotas block (upstream DescribeResourceQuotas). */
export function quotaSection(w: W, engine: Engine, ns: string): void {
  const quotas = engine.store.list<ResourceQuota>('ResourceQuota', ns);
  if (!quotas.length) { w.write(L0, 'No resource quota.'); return; }
  w.write(L0, 'Resource Quotas');
  for (const q of quotas) { w.write(L1, `Name:\t${q.metadata.name}`); quotaRows(w, q, L1, '---'); }
}

/** `describe namespace`: the Resource Limits block (upstream DescribeLimitRanges). */
export function limitsSection(w: W, engine: Engine, ns: string): void {
  const ranges = engine.store.list<LimitRange>('LimitRange', ns);
  if (!ranges.length) { w.write(L0, 'No LimitRange resource.'); return; }
  w.write(L0, 'Resource Limits');
  w.write(' ', LIMITS_HEAD);
  w.write(' ', LIMITS_SEP);
  for (const lr of ranges) limitRows(w, lr, ' ');
}

function describeRole(r: Role): string {
  const w = new W();
  w.write(L0, `Name:\t${r.metadata.name}`);
  w.kv(L0, 'Labels:', mapLines(r.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(r.metadata.annotations));
  w.write(L0, 'PolicyRule:');
  w.write(L1, 'Resources\tNon-Resource URLs\tResource Names\tVerbs');
  w.write(L1, '---------\t-----------------\t--------------\t-----');
  // upstream: BreakdownRule + CompactRules — one row per (group, resource, resourceName), verbs merged in first-seen order
  const rows = new Map<string, { res: string; url: string; name: string; verbs: string[] }>();
  for (const rule of r.rules ?? []) {
    for (const url of rule.nonResourceURLs ?? []) {
      const key = `url|${url}`;
      const row = rows.get(key) ?? { res: '', url, name: '', verbs: [] };
      for (const v of rule.verbs) if (!row.verbs.includes(v)) row.verbs.push(v);
      rows.set(key, row);
    }
    for (const g of rule.apiGroups ?? []) for (const res of rule.resources ?? []) {
      const [base, sub] = res.split('/') as [string, string | undefined];
      const combined = `${base}${g ? `.${g}` : ''}${sub ? `/${sub}` : ''}`;
      for (const n of rule.resourceNames?.length ? rule.resourceNames : ['']) {
        const key = `${combined}|${n}`;
        const row = rows.get(key) ?? { res: combined, url: '', name: n, verbs: [] };
        for (const v of rule.verbs) if (!row.verbs.includes(v)) row.verbs.push(v);
        rows.set(key, row);
      }
    }
  }
  const sorted = [...rows.values()].sort((a, b) => { const va = a.verbs.join(' '), vb = b.verbs.join(' '); return va < vb ? -1 : va > vb ? 1 : a.res < b.res ? -1 : a.res > b.res ? 1 : 0; });
  for (const row of sorted) w.write(L1, `${row.res}\t[${row.url}]\t[${row.name}]\t[${row.verbs.join(' ')}]`);
  return w.render();
}

function describeBinding(b: RoleBinding): string {
  const w = new W();
  w.write(L0, `Name:\t${b.metadata.name}`);
  w.kv(L0, 'Labels:', mapLines(b.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(b.metadata.annotations));
  w.write(L0, 'Role:');
  w.write(L1, `Kind:\t${b.roleRef.kind}`);
  w.write(L1, `Name:\t${b.roleRef.name}`);
  w.write(L0, 'Subjects:');
  w.write(L1, 'Kind\tName\tNamespace');
  w.write(L1, '----\t----\t---------');
  for (const s of b.subjects ?? []) w.write(L1, `${s.kind}\t${s.name}\t${s.namespace ?? ''}`);
  return w.render();
}

function describeSecret(s: Secret): string {
  const w = new W();
  w.write(L0, `Name:\t${s.metadata.name}`);
  w.write(L0, `Namespace:\t${s.metadata.namespace}`);
  w.kv(L0, 'Labels:', mapLines(s.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(s.metadata.annotations));
  w.write(L0, '');
  w.write(L0, `Type:\t${s.type ?? 'Opaque'}`);
  w.write(L0, '');
  w.write(L0, 'Data');
  w.write(L0, '====');
  for (const k of Object.keys(s.data ?? {}).sort()) w.write(L0, `${k}:\t${b64len((s.data as Record<string, string>)[k] as string)} bytes`);
  return w.render();
}

function b64len(v: string): number {
  const clean = v.replace(/=+$/, '');
  return Math.floor((clean.length * 3) / 4);
}

function describeServiceAccount(engine: Engine, sa: KubeObject): string {
  const w = new W();
  w.write(L0, `Name:\t${sa.metadata.name}`);
  w.write(L0, `Namespace:\t${sa.metadata.namespace}`);
  w.kv(L0, 'Labels:', mapLines(sa.metadata.labels));
  w.kv(L0, 'Annotations:', annotationLines(sa.metadata.annotations));
  const pull = ((sa.imagePullSecrets as { name: string }[] | undefined) ?? []).map((p) => `${p.name}${engine.store.get('Secret', sa.metadata.namespace, p.name) ? '' : ' (not found)'}`);
  w.kv(L0, 'Image pull secrets:', pull.length ? pull.join('\n') : '<none>');
  w.write(L0, 'Mountable secrets: \t<none>');
  w.write(L0, 'Tokens:            \t<none>');
  describeEvents(w, engine, sa);
  return w.render();
}

export function describeExt(engine: Engine, obj: KubeObject): string | undefined {
  switch (obj.kind) {
    case 'Ingress': return describeIngress(engine, obj as Ingress);
    case 'NetworkPolicy': return describeNetworkPolicy(obj as NetworkPolicy);
    case 'PersistentVolumeClaim': return describePvc(engine, obj as PersistentVolumeClaim);
    case 'PersistentVolume': return describePv(engine, obj as PersistentVolume);
    case 'StorageClass': return describeStorageClass(engine, obj as StorageClass);
    case 'StatefulSet': return describeStatefulSet(engine, obj as StatefulSet);
    case 'HorizontalPodAutoscaler': return describeHpa(engine, obj as HorizontalPodAutoscaler);
    case 'PodDisruptionBudget': return describePdb(engine, obj as PodDisruptionBudget);
    case 'ResourceQuota': {
      const w = new W();
      w.write(L0, `Name:\t${obj.metadata.name}`);
      w.write(L0, `Namespace:\t${obj.metadata.namespace}`);
      quotaRows(w, obj as ResourceQuota, L0, '----');
      return w.render();
    }
    case 'LimitRange': {
      const w = new W();
      w.write(L0, `Name:\t${obj.metadata.name}`);
      w.write(L0, `Namespace:\t${obj.metadata.namespace}`);
      w.write(L0, LIMITS_HEAD);
      w.write(L0, LIMITS_SEP);
      limitRows(w, obj as LimitRange, L0);
      return w.render();
    }
    case 'Role': case 'ClusterRole': return describeRole(obj as Role);
    case 'RoleBinding': case 'ClusterRoleBinding': return describeBinding(obj as RoleBinding);
    case 'Secret': return describeSecret(obj as Secret);
    case 'ServiceAccount': return describeServiceAccount(engine, obj);
    case 'PriorityClass': {
      const p = obj as PriorityClass;
      const w = new W();
      w.write(L0, `Name:\t${p.metadata.name}`);
      w.write(L0, `Value:\t${p.value}`);
      w.write(L0, `GlobalDefault:\t${p.globalDefault ?? false}`);
      w.write(L0, `PreemptionPolicy:\t${p.preemptionPolicy ?? 'PreemptLowerPriority'}`);
      w.write(L0, `Description:\t${p.description ?? ''}`);
      w.write(L0, `Annotations:\t${labelsToString(p.metadata.annotations)}`);
      describeEvents(w, engine, p);
      return w.render();
    }
    default: return undefined;
  }
}
