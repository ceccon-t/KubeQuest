/** Table printers for the kinds added after the MVP. Columns follow pkg/printers/internalversion/printers.go (release-1.32). */
import type { KubeObject, Ingress, NetworkPolicy, PersistentVolume, PersistentVolumeClaim, StorageClass, StatefulSet, HorizontalPodAutoscaler, PodDisruptionBudget, ResourceQuota, RoleBinding, PriorityClass } from '../types.ts';
import { selectorToString } from '../selector.ts';
import { resourceByKind } from '../registry.ts';
import { humanDuration } from '../duration.ts';
import { jsonpathFirst } from './jsonpath.ts';

export interface ExtTable { headers: string[]; rows: string[][] }

const MODE_SHORT: Record<string, string> = { ReadWriteOnce: 'RWO', ReadOnlyMany: 'ROX', ReadWriteMany: 'RWX', ReadWriteOncePod: 'RWOP' };

/** upstream: helper.GetAccessModesAsString — deduplicated, fixed order. */
export function accessModes(modes: string[] | undefined): string {
  const set = new Set(modes ?? []);
  return ['ReadWriteOnce', 'ReadOnlyMany', 'ReadWriteMany', 'ReadWriteOncePod'].filter((m) => set.has(m)).map((m) => MODE_SHORT[m] as string).join(',');
}

export function isDefaultStorageClass(sc: KubeObject): boolean {
  const a = sc.metadata.annotations ?? {};
  return a['storageclass.kubernetes.io/is-default-class'] === 'true' || a['storageclass.beta.kubernetes.io/is-default-class'] === 'true';
}

/** upstream: formatHosts — first three hosts, `*` when none. */
export function ingressHosts(ing: Ingress): string {
  const hosts = (ing.spec.rules ?? []).map((r) => r.host ?? '').filter((h) => h !== '');
  if (!hosts.length) return '*';
  const shown = hosts.slice(0, 3).join(',');
  return hosts.length > 3 ? `${shown} + ${hosts.length - 3} more...` : shown;
}

export function ingressAddress(ing: Ingress): string {
  return [...new Set((ing.status?.loadBalancer?.ingress ?? []).map((i) => i.ip ?? i.hostname ?? '').filter((x) => x))].sort().join(',');
}

/** upstream: formatHPAMetrics — at most two metrics, only resource metrics carry a name prefix. */
export function hpaTargets(hpa: HorizontalPodAutoscaler): string {
  const specs = hpa.spec.metrics ?? [];
  if (!specs.length) return '<none>';
  const statuses = hpa.status.currentMetrics ?? [];
  const list: string[] = [];
  specs.slice(0, 2).forEach((spec, i) => {
    const st = statuses[i];
    if (spec.type === 'Resource' && spec.resource) {
      const t = spec.resource.target;
      if (t.averageValue !== undefined) list.push(`${spec.resource.name}: ${st?.resource?.current.averageValue ?? '<unknown>'}/${t.averageValue}`);
      else {
        const cur = st?.resource?.current.averageUtilization;
        list.push(`${spec.resource.name}: ${cur !== undefined ? `${cur}%` : '<unknown>'}/${t.averageUtilization !== undefined ? `${t.averageUtilization}%` : '<auto>'}`);
      }
    } else if (spec.type === 'Pods' && spec.pods) list.push(`${st?.pods?.current.averageValue ?? '<unknown>'}/${spec.pods.target.averageValue ?? ''}`);
    else list.push('<unknown type>');
  });
  const ret = list.join(', ');
  return specs.length > 2 ? `${ret} + ${specs.length - 2} more...` : ret;
}

/** upstream: printResourceQuota — `limits.*` go to LIMIT, everything else to REQUEST. */
export function quotaCells(q: ResourceQuota): [string, string] {
  const hard = q.status?.hard ?? {};
  const used = q.status?.used ?? {};
  const req: string[] = [], lim: string[] = [];
  for (const name of Object.keys(hard).sort()) {
    const cell = `${name}: ${used[name] ?? '0'}/${hard[name]}`;
    const parts = name.split('.');
    if (parts[0] === 'limits' && parts.length > 1) lim.push(cell); else req.push(cell);
  }
  return [req.join(', '), lim.join(', ')];
}

function rfc3339(o: KubeObject): string {
  return o.metadata.creationTimestamp ? o.metadata.creationTimestamp.replace(/\.\d+Z$/, 'Z') : '';
}

export function buildExtTable(kind: string, objs: KubeObject[], wide: boolean, name: (o: KubeObject) => string, A: (o: KubeObject) => string, nowMs: number): ExtTable | undefined {
  switch (kind) {
    case 'Ingress':
      return { headers: ['NAME', 'CLASS', 'HOSTS', 'ADDRESS', 'PORTS', 'AGE'], rows: (objs as Ingress[]).map((i) => [name(i), i.spec.ingressClassName ?? '<none>', ingressHosts(i), ingressAddress(i), i.spec.tls?.length ? '80, 443' : '80', A(i)]) };
    case 'IngressClass':
      return { headers: ['NAME', 'CONTROLLER', 'PARAMETERS', 'AGE'], rows: objs.map((c) => [name(c), String((c.spec as { controller?: string } | undefined)?.controller ?? ''), '<none>', A(c)]) };
    case 'NetworkPolicy':
      return { headers: ['NAME', 'POD-SELECTOR', 'AGE'], rows: (objs as NetworkPolicy[]).map((n) => [name(n), selectorToString(n.spec.podSelector), A(n)]) };
    case 'PersistentVolume': {
      const headers = ['NAME', 'CAPACITY', 'ACCESS MODES', 'RECLAIM POLICY', 'STATUS', 'CLAIM', 'STORAGECLASS', 'VOLUMEATTRIBUTESCLASS', 'REASON', 'AGE'];
      if (wide) headers.push('VOLUMEMODE');
      return { headers, rows: (objs as PersistentVolume[]).map((p) => {
        const row = [name(p), p.spec.capacity?.storage ?? '', accessModes(p.spec.accessModes), p.spec.persistentVolumeReclaimPolicy ?? '', p.metadata.deletionTimestamp ? 'Terminating' : (p.status?.phase ?? ''), p.spec.claimRef ? `${p.spec.claimRef.namespace}/${p.spec.claimRef.name}` : '', p.spec.storageClassName ?? '', '<unset>', '', A(p)];
        if (wide) row.push(p.spec.volumeMode ?? '<unset>');
        return row;
      }) };
    }
    case 'PersistentVolumeClaim': {
      const headers = ['NAME', 'STATUS', 'VOLUME', 'CAPACITY', 'ACCESS MODES', 'STORAGECLASS', 'VOLUMEATTRIBUTESCLASS', 'AGE'];
      if (wide) headers.push('VOLUMEMODE');
      return { headers, rows: (objs as PersistentVolumeClaim[]).map((c) => {
        const bound = !!c.spec.volumeName;
        const row = [name(c), c.metadata.deletionTimestamp ? 'Terminating' : (c.status?.phase ?? 'Pending'), c.spec.volumeName ?? '', bound ? (c.status?.capacity?.storage ?? '') : '', bound ? accessModes(c.status?.accessModes) : '', c.spec.storageClassName ?? '', '<unset>', A(c)];
        if (wide) row.push(c.spec.volumeMode ?? '<unset>');
        return row;
      }) };
    }
    case 'StorageClass':
      return { headers: ['NAME', 'PROVISIONER', 'RECLAIMPOLICY', 'VOLUMEBINDINGMODE', 'ALLOWVOLUMEEXPANSION', 'AGE'], rows: (objs as StorageClass[]).map((s) => [name(s) + (isDefaultStorageClass(s) ? ' (default)' : ''), s.provisioner, s.reclaimPolicy ?? 'Delete', s.volumeBindingMode ?? 'Immediate', String(s.allowVolumeExpansion ?? false), A(s)]) };
    case 'StatefulSet': {
      const headers = ['NAME', 'READY', 'AGE'];
      if (wide) headers.push('CONTAINERS', 'IMAGES');
      return { headers, rows: (objs as StatefulSet[]).map((s) => {
        const row = [name(s), `${s.status.readyReplicas ?? 0}/${s.spec.replicas ?? 1}`, A(s)];
        if (wide) row.push(s.spec.template.spec.containers.map((c) => c.name).join(','), s.spec.template.spec.containers.map((c) => c.image).join(','));
        return row;
      }) };
    }
    case 'HorizontalPodAutoscaler':
      return { headers: ['NAME', 'REFERENCE', 'TARGETS', 'MINPODS', 'MAXPODS', 'REPLICAS', 'AGE'], rows: (objs as HorizontalPodAutoscaler[]).map((h) => [name(h), `${h.spec.scaleTargetRef.kind}/${h.spec.scaleTargetRef.name}`, hpaTargets(h), h.spec.minReplicas !== undefined ? String(h.spec.minReplicas) : '<unset>', String(h.spec.maxReplicas), String(h.status.currentReplicas ?? 0), A(h)]) };
    case 'PodDisruptionBudget':
      return { headers: ['NAME', 'MIN AVAILABLE', 'MAX UNAVAILABLE', 'ALLOWED DISRUPTIONS', 'AGE'], rows: (objs as PodDisruptionBudget[]).map((p) => [name(p), p.spec.minAvailable !== undefined ? String(p.spec.minAvailable) : 'N/A', p.spec.maxUnavailable !== undefined ? String(p.spec.maxUnavailable) : 'N/A', String(p.status?.disruptionsAllowed ?? 0), A(p)]) };
    case 'ResourceQuota':
      return { headers: ['NAME', 'AGE', 'REQUEST', 'LIMIT'], rows: (objs as ResourceQuota[]).map((q) => [name(q), A(q), ...quotaCells(q)]) };
    case 'LimitRange': case 'Role': case 'ClusterRole': case 'CustomResourceDefinition':
      return { headers: ['NAME', 'CREATED AT'], rows: objs.map((o) => [name(o), rfc3339(o)]) };
    case 'RoleBinding': case 'ClusterRoleBinding': {
      const headers = ['NAME', 'ROLE', 'AGE'];
      if (wide) headers.push('USERS', 'GROUPS', 'SERVICEACCOUNTS');
      return { headers, rows: (objs as RoleBinding[]).map((b) => {
        const row = [name(b), `${b.roleRef.kind}/${b.roleRef.name}`, A(b)];
        const subs = b.subjects ?? [];
        if (wide) row.push(subs.filter((s) => s.kind === 'User').map((s) => s.name).join(', '), subs.filter((s) => s.kind === 'Group').map((s) => s.name).join(', '), subs.filter((s) => s.kind === 'ServiceAccount').map((s) => `${s.namespace ?? ''}/${s.name}`).join(', '));
        return row;
      }) };
    }
    case 'PriorityClass':
      return { headers: ['NAME', 'VALUE', 'GLOBAL-DEFAULT', 'AGE', 'PREEMPTIONPOLICY'], rows: (objs as PriorityClass[]).map((p) => [name(p), String(p.value), String(p.globalDefault ?? false), A(p), p.preemptionPolicy ?? 'PreemptLowerPriority']) };
    case 'ValidatingAdmissionPolicy':
      return { headers: ['NAME', 'VALIDATIONS', 'PARAMKIND', 'AGE'], rows: objs.map((p) => { const s = (p.spec ?? {}) as { validations?: unknown[]; paramKind?: { apiVersion: string; kind: string } }; return [name(p), String((s.validations ?? []).length), s.paramKind ? `${s.paramKind.apiVersion}/${s.paramKind.kind}` : '<unset>', A(p)]; }) };
    case 'ValidatingAdmissionPolicyBinding':
      return { headers: ['NAME', 'POLICYNAME', 'PARAMREF', 'AGE'], rows: objs.map((b) => { const s = (b.spec ?? {}) as { policyName?: string; paramRef?: { name?: string; namespace?: string } }; return [name(b), s.policyName ?? '', s.paramRef?.name ? `${s.paramRef.namespace ?? '*'}/${s.paramRef.name}` : '<unset>', A(b)]; }) };
    default: {
      // custom resources: NAME + the CRD's additionalPrinterColumns, or NAME/AGE when it declares none (apiextensions tableconvertor)
      const cols = resourceByKind(kind)?.columns;
      if (!cols) return undefined;
      const shown = cols.filter((c) => wide || !c.priority);
      return { headers: ['NAME', ...shown.map((c) => c.name.toUpperCase())], rows: objs.map((o) => [name(o), ...shown.map((c) => {
        const v = jsonpathFirst(c.jsonPath, o);
        if (v === undefined || v === null) return '';
        if (c.type === 'date') { const t = Date.parse(String(v)); return Number.isNaN(t) ? '<invalid>' : humanDuration(nowMs - t); }
        return typeof v === 'object' ? JSON.stringify(v) : String(v);
      })]) };
    }
  }
}
