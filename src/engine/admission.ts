/**
 * Admission chain run when objects enter the API: ServiceAccount and PriorityClass resolution, LimitRange,
 * Pod Security, ValidatingAdmissionPolicy and ResourceQuota — in the order the API server runs them.
 * Messages are upstream format strings (see plugin/pkg/admission and staging/.../apiserver/pkg/admission).
 */
import type { Engine } from './engine.ts';
import type { KubeObject, Pod, Container, LimitRange, ResourceQuota, PriorityClass, Namespace, PersistentVolumeClaim, Service } from './types.ts';
import { ApiError } from './store.ts';
import { resourceByKind } from './registry.ts';
import { parseCpuMillis, parseMemoryBytes, parseQuantity, formatCpuMillis, formatMemory } from './duration.ts';
import { checkPodSecurity, namespacePolicy, violationText, podSpecOf } from './podsecurity.ts';
import { evalCel, CelError, CelUnsupported } from './cel.ts';
import { fromLabelSelector, matches, type LabelSelectorObj } from './selector.ts';
import { ADMIN, type UserInfo } from './rbac.ts';
import { qosClass } from './defaults.ts';

export type AdmissionOp = 'CREATE' | 'UPDATE';

function forbidden(obj: KubeObject, why: string): ApiError {
  const r = resourceByKind(obj.kind);
  const res = r ? (r.group ? `${r.plural}.${r.group}` : r.plural) : obj.kind.toLowerCase();
  return new ApiError('Forbidden', `${res} "${obj.metadata.name}" is forbidden: ${why}`);
}

// ---------------------------------------------------------------------------
// ResourceQuota accounting (shared with the quota controller for status)
// ---------------------------------------------------------------------------

type Unit = 'cpu' | 'bytes' | 'count';
function unitOf(resource: string): Unit {
  const leaf = resource.replace(/^(requests|limits)\./, '');
  if (leaf === 'cpu') return 'cpu';
  if (leaf === 'memory' || leaf === 'storage' || leaf === 'ephemeral-storage') return 'bytes';
  return 'count';
}
export function parseQuotaValue(resource: string, v: string | number): number {
  const u = unitOf(resource);
  return u === 'cpu' ? parseCpuMillis(v) : u === 'bytes' ? parseMemoryBytes(v) : parseQuantity(v);
}
export function formatQuotaValue(resource: string, n: number): string {
  if (n === 0) return '0'; // resource.Quantity prints a zero without a unit
  const u = unitOf(resource);
  return u === 'cpu' ? formatCpuMillis(n) : u === 'bytes' ? formatMemory(n) : String(n);
}

function add(m: Record<string, number>, k: string, n: number): void { m[k] = (m[k] ?? 0) + n; }

function podCharge(pod: Pod, m: Record<string, number>): void {
  add(m, 'pods', 1);
  add(m, 'count/pods', 1);
  for (const c of pod.spec.containers) {
    for (const [section, vals] of [['requests', c.resources?.requests], ['limits', c.resources?.limits]] as const) {
      for (const [k, v] of Object.entries(vals ?? {})) {
        const n = k === 'cpu' ? parseCpuMillis(v) : k === 'memory' || k === 'ephemeral-storage' ? parseMemoryBytes(v) : parseQuantity(v);
        add(m, `${section}.${k}`, n);
        if (section === 'requests' && (k === 'cpu' || k === 'memory')) add(m, k, n);
      }
    }
  }
}

function objectCharge(obj: KubeObject, m: Record<string, number>): void {
  if (obj.kind === 'Pod') { podCharge(obj as Pod, m); return; }
  const r = resourceByKind(obj.kind);
  if (!r) return;
  add(m, `count/${r.plural}${r.group ? `.${r.group}` : ''}`, 1);
  switch (obj.kind) {
    case 'PersistentVolumeClaim': add(m, 'persistentvolumeclaims', 1); add(m, 'requests.storage', parseMemoryBytes((obj as PersistentVolumeClaim).spec.resources?.requests?.storage ?? '0')); break;
    case 'Service': {
      add(m, 'services', 1);
      const t = (obj as Service).spec.type;
      if (t === 'NodePort' || t === 'LoadBalancer') add(m, 'services.nodeports', ((obj as Service).spec.ports ?? []).length);
      if (t === 'LoadBalancer') add(m, 'services.loadbalancers', 1);
      break;
    }
    case 'ConfigMap': add(m, 'configmaps', 1); break;
    case 'Secret': add(m, 'secrets', 1); break;
    case 'ResourceQuota': add(m, 'resourcequotas', 1); break;
    default: break;
  }
}

/** Everything a namespace currently consumes, keyed by quota resource name (base units). */
export function quotaUsage(engine: Engine, namespace: string): Record<string, number> {
  const m: Record<string, number> = {};
  for (const o of engine.store.all()) {
    if (o.metadata.namespace !== namespace || o.kind === 'Event' || o.kind === 'Endpoints' || o.kind === 'EndpointSlice') continue;
    if (o.kind === 'Pod' && ((o as Pod).status.phase === 'Succeeded' || (o as Pod).status.phase === 'Failed')) continue;
    objectCharge(o, m);
  }
  return m;
}

function checkQuota(engine: Engine, obj: KubeObject): void {
  const ns = obj.metadata.namespace;
  if (!ns) return;
  const quotas = engine.store.list<ResourceQuota>('ResourceQuota', ns);
  if (!quotas.length) return;
  const delta: Record<string, number> = {};
  objectCharge(obj, delta);
  const used = quotaUsage(engine, ns);
  for (const q of quotas) {
    const hard = q.spec.hard ?? {};
    if (obj.kind === 'Pod') {
      // upstream pod evaluator: every compute resource the quota constrains must be set on every container
      const missing: string[] = [];
      for (const res of Object.keys(hard).sort()) {
        const m = /^(?:(requests|limits)\.)?(cpu|memory)$/.exec(res);
        if (!m) continue;
        const section = m[1] === 'limits' ? 'limits' : 'requests';
        const lacking = (obj as Pod).spec.containers.filter((c) => c.resources?.[section]?.[m[2] as string] === undefined).map((c) => c.name);
        if (lacking.length) missing.push(`${res} for: ${lacking.join(',')}`);
      }
      if (missing.length) throw forbidden(obj, `failed quota: ${q.metadata.name}: must specify ${missing.join('; ')}`);
    }
    const over = Object.keys(hard).sort().filter((res) => (delta[res] ?? 0) > 0 && (used[res] ?? 0) + (delta[res] ?? 0) > parseQuotaValue(res, hard[res] as string));
    if (over.length) {
      const list = (f: (res: string) => string) => over.map((res) => `${res}=${f(res)}`).join(',');
      throw forbidden(obj, `exceeded quota: ${q.metadata.name}, requested: ${list((r) => formatQuotaValue(r, delta[r] ?? 0))}, used: ${list((r) => formatQuotaValue(r, used[r] ?? 0))}, limited: ${list((r) => String(hard[r]))}`);
    }
  }
}

// ---------------------------------------------------------------------------
// LimitRange
// ---------------------------------------------------------------------------

function applyLimitRanges(engine: Engine, pod: Pod): void {
  const ranges = engine.store.list<LimitRange>('LimitRange', pod.metadata.namespace);
  if (!ranges.length) return;
  const notes: string[] = [];
  const errs: string[] = [];
  const num = (res: string, v: string | number): number => (res === 'cpu' ? parseCpuMillis(v) : parseQuantity(v));
  for (const lr of ranges) {
    for (const item of lr.spec.limits ?? []) {
      if (item.type !== 'Container') continue;
      for (const c of pod.spec.containers) {
        const res = (c.resources ??= {});
        const setReq: string[] = [], setLim: string[] = [];
        for (const [k, v] of Object.entries(item.default ?? {})) if (res.limits?.[k] === undefined) { (res.limits ??= {})[k] = v; setLim.push(k); }
        for (const [k, v] of Object.entries(item.defaultRequest ?? {})) if (res.requests?.[k] === undefined) { (res.requests ??= {})[k] = v; setReq.push(k); }
        // a container with a limit and no request gets request = limit (API defaulting)
        for (const k of Object.keys(res.limits ?? {})) if (res.requests?.[k] === undefined) (res.requests ??= {})[k] = (res.limits as Record<string, string | number>)[k] as string;
        if (setReq.length) notes.push(`${setReq.sort().join(', ')} request for container ${c.name}`);
        if (setLim.length) notes.push(`${setLim.sort().join(', ')} limit for container ${c.name}`);
        for (const [k, min] of Object.entries(item.min ?? {})) {
          // upstream minConstraint/maxConstraint report the first violation per resource
          const r = res.requests?.[k], l = res.limits?.[k];
          if (r === undefined) errs.push(`minimum ${k} usage per Container is ${min}.  No request is specified`);
          else if (num(k, r) < num(k, min)) errs.push(`minimum ${k} usage per Container is ${min}, but request is ${r}`);
          else if (l !== undefined && num(k, l) < num(k, min)) errs.push(`minimum ${k} usage per Container is ${min}, but limit is ${l}`);
        }
        for (const [k, max] of Object.entries(item.max ?? {})) {
          const r = res.requests?.[k], l = res.limits?.[k];
          if (l === undefined) errs.push(`maximum ${k} usage per Container is ${max}.  No limit is specified`);
          else if (num(k, l) > num(k, max)) errs.push(`maximum ${k} usage per Container is ${max}, but limit is ${l}`);
          else if (r !== undefined && num(k, r) > num(k, max)) errs.push(`maximum ${k} usage per Container is ${max}, but request is ${r}`);
        }
      }
    }
  }
  if (errs.length) throw forbidden(pod, errs.length === 1 ? (errs[0] as string) : `[${errs.join(', ')}]`);
  if (notes.length) {
    pod.metadata.annotations = { ...(pod.metadata.annotations ?? {}), 'kubernetes.io/limit-ranger': `LimitRanger plugin set: ${notes.join('; ')}` };
    pod.status.qosClass = qosClass(pod.spec);
  }
}

// ---------------------------------------------------------------------------
// ValidatingAdmissionPolicy
// ---------------------------------------------------------------------------

interface VapSpec {
  failurePolicy?: string;
  matchConstraints?: { resourceRules?: { apiGroups?: string[]; apiVersions?: string[]; operations?: string[]; resources?: string[] }[]; namespaceSelector?: LabelSelectorObj };
  validations?: { expression: string; message?: string; messageExpression?: string }[];
  variables?: { name: string; expression: string }[];
}
interface VapBindingSpec { policyName?: string; validationActions?: string[]; matchResources?: { namespaceSelector?: LabelSelectorObj } }

function runPolicies(engine: Engine, obj: KubeObject, old: KubeObject | undefined, op: AdmissionOp, user: UserInfo): string[] {
  const bindings = engine.store.list('ValidatingAdmissionPolicyBinding');
  if (!bindings.length) return [];
  const r = resourceByKind(obj.kind);
  if (!r) return [];
  const warnings: string[] = [];
  const nsObj = obj.metadata.namespace ? engine.store.get<Namespace>('Namespace', undefined, obj.metadata.namespace) : undefined;
  for (const b of bindings) {
    const bs = (b.spec ?? {}) as VapBindingSpec;
    const policy = engine.store.get('ValidatingAdmissionPolicy', undefined, bs.policyName ?? '');
    if (!policy) continue;
    const ps = (policy.spec ?? {}) as VapSpec;
    const hit = (ps.matchConstraints?.resourceRules ?? []).some((rule) => (rule.apiGroups ?? []).some((g) => g === '*' || g === r.group) && (rule.apiVersions ?? ['*']).some((v) => v === '*' || v === r.version) && (rule.operations ?? ['*']).some((o) => o === '*' || o === op) && (rule.resources ?? []).some((x) => x === '*' || x === r.plural));
    if (!hit) continue;
    const nsOk = (sel: LabelSelectorObj | undefined): boolean => !sel || !r.namespaced || matches(fromLabelSelector(sel), nsObj?.metadata.labels);
    if (!nsOk(ps.matchConstraints?.namespaceSelector) || !nsOk(bs.matchResources?.namespaceSelector)) continue;
    const env: Record<string, unknown> = {
      object: obj, oldObject: old ?? null, params: null, namespaceObject: nsObj ?? null,
      request: { operation: op, namespace: obj.metadata.namespace ?? '', name: obj.metadata.name, userInfo: { username: user.name, groups: user.groups } },
    };
    let current = '';
    const run = (expr: string): unknown => {
      current = expr;
      try { return evalCel(expr, env); }
      catch (e) {
        if (e instanceof CelUnsupported) throw new ApiError('BadRequest', `kubequest: the CEL function "${e.message}" used by ValidatingAdmissionPolicy '${policy.metadata.name}' is not supported in the simulator yet`);
        throw e;
      }
    };
    const variables: Record<string, unknown> = {};
    env.variables = variables;
    let failure: string | undefined;
    try {
      for (const v of ps.variables ?? []) variables[v.name] = run(v.expression);
      for (const v of ps.validations ?? []) {
        if (run(v.expression) === true) continue;
        failure = v.message ?? `failed expression: ${v.expression.trim()}`;
        if (v.messageExpression) { try { const m = run(v.messageExpression); if (typeof m === 'string' && m) failure = m; } catch (e) { if (!(e instanceof CelError)) throw e; } }
        break;
      }
    } catch (e) {
      if (!(e instanceof CelError)) throw e;
      if ((ps.failurePolicy ?? 'Fail') === 'Ignore') continue;
      // upstream: plugin/cel/activation.go
      failure = `expression '${current}' resulted in error: ${e.message}`;
    }
    if (failure === undefined) continue;
    const actions = bs.validationActions ?? ['Deny'];
    if (actions.includes('Deny')) {
      const text = `ValidatingAdmissionPolicy '${policy.metadata.name}' with binding '${b.metadata.name}' denied request: ${failure}`;
      const err = forbidden(obj, text);
      // the API returns reason Invalid with an empty field path, which kubectl prints as `The <res> "<name>" is invalid: : <cause>`
      err.display = `The ${r.plural} "${obj.metadata.name}" is invalid: : ${text}`;
      throw err;
    }
    if (actions.includes('Warn')) warnings.push(`Validation failed for ValidatingAdmissionPolicy '${policy.metadata.name}' with binding '${b.metadata.name}': ${failure}`);
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function admitPodSpecific(engine: Engine, pod: Pod): void {
  const ns = pod.metadata.namespace as string;
  const sa = pod.spec.serviceAccountName ?? 'default';
  if (sa !== 'default' && !engine.store.get('ServiceAccount', ns, sa)) throw forbidden(pod, `error looking up service account ${ns}/${sa}: serviceaccount "${sa}" not found`);
  if (pod.spec.priorityClassName) {
    const pc = engine.store.get<PriorityClass>('PriorityClass', undefined, pod.spec.priorityClassName);
    if (!pc) throw forbidden(pod, `no PriorityClass with name ${pod.spec.priorityClassName} was found`);
    pod.spec.priority = pc.value;
    pod.spec.preemptionPolicy = pc.preemptionPolicy ?? 'PreemptLowerPriority';
  } else {
    const def = engine.store.list<PriorityClass>('PriorityClass').find((p) => p.globalDefault);
    if (def) { pod.spec.priorityClassName = def.metadata.name; pod.spec.priority = def.value; }
  }
  applyLimitRanges(engine, pod);
}

/**
 * Admit an object. Mutates it (defaults from LimitRange/PriorityClass), throws ApiError when a plugin rejects it and
 * returns the warnings the API server would send back (`Warning: …` lines in kubectl).
 */
export function admit(engine: Engine, obj: KubeObject, op: AdmissionOp, opts: { user?: UserInfo; old?: KubeObject } = {}): string[] {
  const warnings: string[] = [];
  const user = opts.user ?? ADMIN;
  if (obj.kind === 'Pod' && op === 'CREATE') admitPodSpecific(engine, obj as Pod);
  // Pod Security: enforce on pods, warn on pods and on the pod templates of workload resources
  const spec = podSpecOf(obj);
  if (spec && obj.metadata.namespace) {
    const pol = namespacePolicy(engine.store.get('Namespace', undefined, obj.metadata.namespace));
    if (obj.kind === 'Pod' && op === 'CREATE' && pol.enforce) {
      const v = checkPodSecurity(pol.enforce, spec);
      if (v.length) throw forbidden(obj, `violates PodSecurity "${pol.enforce}:${pol.versions.enforce}": ${violationText(v)}`);
    }
    if (pol.warn) {
      const v = checkPodSecurity(pol.warn, spec);
      if (v.length) warnings.push(`would violate PodSecurity "${pol.warn}:${pol.versions.warn}": ${violationText(v)}`);
    }
  }
  if (obj.kind === 'Namespace' && op === 'UPDATE') warnings.push(...namespaceLabelWarnings(engine, obj as Namespace, opts.old as Namespace | undefined));
  warnings.push(...runPolicies(engine, obj, opts.old, op, user));
  if (op === 'CREATE') checkQuota(engine, obj);
  return warnings;
}

/** Controllers create pods through the same chain; rejections surface as FailedCreate events. */
export function admitPod(engine: Engine, pod: Pod): void {
  admit(engine, pod, 'CREATE');
}

/** upstream: pod-security-admission warns about existing pods when a namespace gets a stricter enforce level. */
function namespaceLabelWarnings(engine: Engine, ns: Namespace, old: Namespace | undefined): string[] {
  const now = namespacePolicy(ns), before = namespacePolicy(old);
  if (!now.enforce || (now.enforce === before.enforce && now.versions.enforce === before.versions.enforce)) return [];
  const byReasons = new Map<string, string[]>();
  for (const p of engine.store.list<Pod>('Pod', ns.metadata.name)) {
    const v = checkPodSecurity(now.enforce, p.spec);
    if (!v.length) continue;
    const key = v.map((x) => x.reason).join(', ');
    byReasons.set(key, [...(byReasons.get(key) ?? []), p.metadata.name]);
  }
  if (!byReasons.size) return [];
  const out = [`existing pods in namespace "${ns.metadata.name}" violate the new PodSecurity enforce level "${now.enforce}:${now.versions.enforce}"`];
  const lines: string[] = [];
  for (const [reasons, pods] of byReasons) {
    pods.sort();
    const others = pods.length - 1;
    lines.push(`${pods[0]}${others === 1 ? ' (and 1 other pod)' : others > 1 ? ` (and ${others} other pods)` : ''}: ${reasons}`);
  }
  return [...out, ...lines.sort()];
}

void ((0 as unknown) as Container);
