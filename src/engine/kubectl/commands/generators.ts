/** `kubectl create <kind>` generators beyond the MVP set. Object shapes follow staging/src/k8s.io/kubectl/pkg/cmd/create. */
import type { CommandContext } from '../context.ts';
import { str, strs, bool, int, KubectlError } from '../args.ts';
import type { KubeObject, PolicyRule, CronJob } from '../../types.ts';
import { resolveResource } from '../../registry.ts';
import { b64encode } from '../../encoding.ts';
import type { FlagSpec } from '../args.ts';

export const GENERATOR_FLAGS: FlagSpec[] = [
  { name: 'verb', type: 'strings' }, { name: 'resource', type: 'strings' }, { name: 'resource-name', type: 'strings' }, { name: 'non-resource-url', type: 'strings' },
  { name: 'role', type: 'string' }, { name: 'clusterrole', type: 'string' }, { name: 'user', type: 'strings' }, { name: 'group', type: 'strings' }, { name: 'serviceaccount', type: 'strings' },
  { name: 'class', type: 'string' }, { name: 'rule', type: 'strings' }, { name: 'default-backend', type: 'string' }, { name: 'annotation', type: 'strings' },
  { name: 'selector', short: 'l', type: 'string' }, { name: 'min-available', type: 'string' }, { name: 'max-unavailable', type: 'string' },
  { name: 'hard', type: 'string' }, { name: 'scopes', type: 'string' }, { name: 'value', type: 'int' }, { name: 'global-default', type: 'bool' }, { name: 'description', type: 'string' }, { name: 'preemption-policy', type: 'string' },
  { name: 'cert', type: 'string' }, { name: 'key', type: 'string' }, { name: 'docker-server', type: 'string' }, { name: 'docker-username', type: 'string' }, { name: 'docker-password', type: 'string' }, { name: 'docker-email', type: 'string' },
  { name: 'duration', type: 'string' },
];

const NULL_TS = null as unknown as string;
const split = (items: string[]): string[] => items.flatMap((x) => x.split(',')).map((x) => x.trim()).filter((x) => x);

function exactlyOneName(a: CommandContext['args'], from: number, what: string): string {
  const names = a.positional.slice(from);
  if (names.length !== 1) throw new KubectlError(`exactly one NAME is required, got ${names.length}\nSee 'kubectl create ${what} -h' for help and examples`);
  return names[0] as string;
}

/** `--resource=pods,deployments.apps,pods/log` → rules grouped by API group (upstream: one rule per group). */
function policyRules(a: CommandContext['args'], cluster: boolean): PolicyRule[] {
  const verbs = split(strs(a, 'verb'));
  const resources = split(strs(a, 'resource'));
  const urls = split(strs(a, 'non-resource-url'));
  if (!verbs.length) throw new KubectlError('at least one verb must be specified');
  if (!resources.length && !(cluster && urls.length)) throw new KubectlError(cluster ? 'one of resource or nonResourceURL must be specified' : 'at least one resource must be specified');
  const byGroup = new Map<string, string[]>();
  for (const r of resources) {
    const [base, sub] = r.split('/') as [string, string | undefined];
    const info = resolveResource(base);
    if (!info) throw new KubectlError(`the server doesn't have a resource type "${base.split('.')[0]}"`);
    const list = byGroup.get(info.group) ?? [];
    list.push(sub ? `${info.plural}/${sub}` : info.plural);
    byGroup.set(info.group, list);
  }
  const names = split(strs(a, 'resource-name'));
  const rules: PolicyRule[] = [...byGroup.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([g, res]) => ({ apiGroups: [g], ...(names.length ? { resourceNames: names } : {}), resources: res, verbs }));
  if (urls.length) rules.push({ nonResourceURLs: urls, verbs });
  return rules;
}

function subjects(a: CommandContext['args']): KubeObject['subjects'] {
  const out: Record<string, string>[] = [];
  for (const u of split(strs(a, 'user'))) out.push({ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: u });
  for (const g of split(strs(a, 'group'))) out.push({ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: g });
  for (const s of split(strs(a, 'serviceaccount'))) {
    const parts = s.split(':');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new KubectlError('serviceaccount must be <namespace>:<name>');
    out.push({ kind: 'ServiceAccount', name: parts[1], namespace: parts[0] });
  }
  return out;
}

function ingressBackend(spec: string): { service: { name: string; port: { number?: number; name?: string } } } {
  const [name, port] = spec.split(':') as [string, string | undefined];
  return { service: { name, port: port !== undefined && /^\d+$/.test(port) ? { number: parseInt(port, 10) } : { name: port ?? '' } } };
}

/** Build the object for `kubectl create SUB …`, or return undefined when SUB is not one of these generators. */
export function generate(ctx: CommandContext, sub: string): KubeObject | undefined {
  const a = ctx.args;
  switch (sub) {
    case 'serviceaccount': case 'sa':
      return { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { creationTimestamp: NULL_TS, name: exactlyOneName(a, 1, 'serviceaccount') } };
    case 'role':
      return { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { creationTimestamp: NULL_TS, name: exactlyOneName(a, 1, 'role') }, rules: policyRules(a, false) };
    case 'clusterrole':
      return { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { creationTimestamp: NULL_TS, name: exactlyOneName(a, 1, 'clusterrole') }, rules: policyRules(a, true) };
    case 'rolebinding': {
      const name = exactlyOneName(a, 1, 'rolebinding');
      const role = str(a, 'role'), cr = str(a, 'clusterrole');
      if ((role ? 1 : 0) + (cr ? 1 : 0) !== 1) throw new KubectlError('exactly one of clusterrole or role must be specified');
      return { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { creationTimestamp: NULL_TS, name }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: role ? 'Role' : 'ClusterRole', name: (role ?? cr) as string }, subjects: subjects(a) };
    }
    case 'clusterrolebinding': {
      const name = exactlyOneName(a, 1, 'clusterrolebinding');
      const cr = str(a, 'clusterrole');
      if (!cr) throw new KubectlError('required flag(s) "clusterrole" not set');
      return { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { creationTimestamp: NULL_TS, name }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: cr }, subjects: subjects(a) };
    }
    case 'ingress': case 'ing': {
      const name = exactlyOneName(a, 1, 'ingress');
      const rulesIn = strs(a, 'rule');
      const def = str(a, 'default-backend');
      if (!rulesIn.length && !def) throw new KubectlError('not enough information provided: every ingress has to either specify a default-backend (which catches all traffic) or a list of rules (which catch specific paths)');
      const rules: { host?: string; http: { paths: unknown[] } }[] = [];
      const tls: { hosts: string[]; secretName?: string }[] = [];
      for (const r of rulesIn) {
        const m = /^([^/=]*)(\/[^=]*)?=([^:,]+:[^,]+)(?:,(tls)(?:=(.+))?)?$/.exec(r);
        if (!m) throw new KubectlError(`rule ${r} is invalid and should be in format host/path=svcname:svcport[,tls[=secret]]`);
        const host = m[1] as string;
        let path = m[2] ?? '/';
        const pathType = path.endsWith('*') ? 'Prefix' : 'Exact';
        if (path.endsWith('*')) path = path.slice(0, -1) || '/';
        let rule = rules.find((x) => (x.host ?? '') === host);
        if (!rule) { rule = { ...(host ? { host } : {}), http: { paths: [] } }; rules.push(rule); }
        rule.http.paths.push({ backend: ingressBackend(m[3] as string), path, pathType });
        if (m[4]) { const t = tls.find((x) => x.secretName === m[5]); if (t) { if (host && !t.hosts.includes(host)) t.hosts.push(host); } else tls.push({ hosts: host ? [host] : [], ...(m[5] ? { secretName: m[5] } : {}) }); }
      }
      const annotations = Object.fromEntries(strs(a, 'annotation').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
      return { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { ...(Object.keys(annotations).length ? { annotations } : {}), creationTimestamp: NULL_TS, name }, spec: { ...(def ? { defaultBackend: ingressBackend(def) } : {}), ...(str(a, 'class') ? { ingressClassName: str(a, 'class') } : {}), ...(rules.length ? { rules } : {}), ...(tls.length ? { tls } : {}) }, status: { loadBalancer: {} } };
    }
    case 'poddisruptionbudget': case 'pdb': {
      const name = exactlyOneName(a, 1, 'poddisruptionbudget');
      const sel = str(a, 'selector'), min = str(a, 'min-available'), max = str(a, 'max-unavailable');
      if (!sel) throw new KubectlError('a selector must be specified');
      if (!min && !max) throw new KubectlError('one of min-available or max-unavailable must be specified');
      if (min && max) throw new KubectlError('min-available and max-unavailable cannot be both specified');
      const num = (v: string): number | string => (/^\d+$/.test(v) ? parseInt(v, 10) : v);
      const matchLabels = Object.fromEntries(sel.split(',').map((kv) => kv.split('=') as [string, string]));
      return { apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: { creationTimestamp: NULL_TS, name }, spec: { ...(max ? { maxUnavailable: num(max) } : {}), ...(min ? { minAvailable: num(min) } : {}), selector: { matchLabels } }, status: { currentHealthy: 0, desiredHealthy: 0, disruptionsAllowed: 0, expectedPods: 0 } };
    }
    case 'quota': case 'resourcequota': {
      const name = exactlyOneName(a, 1, 'quota');
      const hard: Record<string, string> = {};
      for (const kv of (str(a, 'hard') ?? '').split(',').filter((x) => x)) { const i = kv.indexOf('='); if (i <= 0) throw new KubectlError(`Invalid argument syntax ${kv}, expected <resource>=<value>`); hard[kv.slice(0, i)] = kv.slice(i + 1); }
      return { apiVersion: 'v1', kind: 'ResourceQuota', metadata: { creationTimestamp: NULL_TS, name }, spec: { hard }, status: {} };
    }
    case 'priorityclass': case 'pc': {
      const name = exactlyOneName(a, 1, 'priorityclass');
      return { apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: { creationTimestamp: NULL_TS, name }, ...(str(a, 'description') ? { description: str(a, 'description') } : {}), ...(bool(a, 'global-default') ? { globalDefault: true } : {}), preemptionPolicy: str(a, 'preemption-policy') ?? 'PreemptLowerPriority', value: int(a, 'value') ?? 0 };
    }
    default: return undefined;
  }
}

/** `kubectl create secret tls|docker-registry` */
export function generateSecret(ctx: CommandContext, kind: string, name: string): KubeObject | undefined {
  const a = ctx.args;
  if (kind === 'tls') {
    const certPath = str(a, 'cert'), keyPath = str(a, 'key');
    if (!certPath || !keyPath) throw new KubectlError('key and cert must be specified');
    const cert = ctx.vfs.read(certPath), key = ctx.vfs.read(keyPath);
    if (cert === undefined) throw new KubectlError(`open ${certPath}: no such file or directory`);
    if (key === undefined) throw new KubectlError(`open ${keyPath}: no such file or directory`);
    if (!cert.includes('-----BEGIN CERTIFICATE-----')) throw new KubectlError('failed to load key pair tls: failed to find any PEM data in certificate input');
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) throw new KubectlError('failed to load key pair tls: failed to find any PEM data in key input');
    return { apiVersion: 'v1', kind: 'Secret', metadata: { creationTimestamp: NULL_TS, name }, type: 'kubernetes.io/tls', data: { 'tls.crt': b64encode(cert), 'tls.key': b64encode(key) } };
  }
  if (kind === 'docker-registry') {
    const server = str(a, 'docker-server') ?? 'https://index.docker.io/v1/', username = str(a, 'docker-username'), password = str(a, 'docker-password'), email = str(a, 'docker-email');
    if (!username || !password) throw new KubectlError('either --from-file or the combination of --docker-username, --docker-password and --docker-server is required');
    const entry: Record<string, string> = { username, password, ...(email ? { email } : {}), auth: b64encode(`${username}:${password}`) };
    return { apiVersion: 'v1', kind: 'Secret', metadata: { creationTimestamp: NULL_TS, name }, type: 'kubernetes.io/dockerconfigjson', data: { '.dockerconfigjson': b64encode(JSON.stringify({ auths: { [server]: entry } })) } };
  }
  return undefined;
}

/** Key/value pairs for `--from-literal`, `--from-file` (file, key=file or directory) and `--from-env-file`. */
export function keyValueSources(ctx: CommandContext): Record<string, string> {
  const a = ctx.args;
  const data: Record<string, string> = {};
  for (const it of strs(a, 'from-literal')) {
    const eq = it.indexOf('=');
    if (eq <= 0) throw new KubectlError(`invalid literal source ${it}, expected key=value`);
    data[it.slice(0, eq)] = it.slice(eq + 1);
  }
  for (const it of strs(a, 'from-file')) {
    const eq = it.indexOf('=');
    const [key, path] = eq > 0 ? [it.slice(0, eq), it.slice(eq + 1)] : [undefined, it];
    if (ctx.vfs.isDir(path) && ctx.vfs.read(path) === undefined) {
      for (const e of ctx.vfs.list(path)) if (!e.endsWith('/')) data[e] = ctx.vfs.read(`${path}/${e}`) as string;
      continue;
    }
    const content = ctx.vfs.read(path);
    if (content === undefined) throw new KubectlError(`error reading ${path}: no such file or directory`);
    data[key ?? (path.split('/').pop() as string)] = content;
  }
  for (const f of strs(a, 'from-env-file')) {
    const content = ctx.vfs.read(f);
    if (content === undefined) throw new KubectlError(`open ${f}: no such file or directory`);
    for (const line of content.split('\n')) { const t = line.trim(); if (!t || t.startsWith('#')) continue; const i = t.indexOf('='); if (i > 0) data[t.slice(0, i)] = t.slice(i + 1); }
  }
  return data;
}

/** `kubectl create job NAME --from=cronjob/X` */
export function jobFromCronJob(ctx: CommandContext, name: string, from: string): KubeObject {
  const m = /^(cronjob|cronjobs|cj|cronjob\.batch)\/(.+)$/.exec(from);
  if (!m) throw new KubectlError(`from must be an existing cronjob: unknown object type ${from.split('/')[0]}`);
  const cj = ctx.engine.store.get<CronJob>('CronJob', ctx.namespace, m[2] as string);
  if (!cj) throw new KubectlError(`Error from server (NotFound): cronjobs.batch "${m[2]}" not found`);
  return {
    apiVersion: 'batch/v1', kind: 'Job',
    metadata: { annotations: { 'cronjob.kubernetes.io/instantiate': 'manual' }, creationTimestamp: NULL_TS, name, namespace: cj.metadata.namespace, ownerReferences: [{ apiVersion: 'batch/v1', kind: 'CronJob', name: cj.metadata.name, uid: cj.metadata.uid as string, controller: true, blockOwnerDeletion: true }] },
    spec: structuredClone(cj.spec.jobTemplate.spec), status: {},
  };
}
