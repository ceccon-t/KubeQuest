/**
 * CustomResourceDefinitions: serving new resource types, validating custom resources against their structural
 * schema, and running the (mission-provided) operators that reconcile them. upstream: apiextensions-apiserver
 */
import type { Engine } from '../engine.ts';
import type { CustomResourceDefinition, JsonSchema, KubeObject, Pod, CrdVersion } from '../types.ts';
import type { ResourceInfo } from '../registry.ts';
import { ApiError } from '../store.ts';
import { isPodReady } from './kubelet.ts';
import { authorize, forbiddenMessage, serviceAccountUser } from '../rbac.ts';
import { normalizeImage } from '../images.ts';
import { resourceByKind } from '../registry.ts';
import { applyDefaults } from '../defaults.ts';
import { admit } from '../admission.ts';
import { sortKeys } from '../yaml.ts';

/** The part of `live` that `want` talks about (same shape as want, values from live). */
function subset(want: unknown, live: unknown): unknown {
  if (Array.isArray(want)) return Array.isArray(live) && live.length === want.length ? want.map((w, i) => subset(w, live[i])) : live;
  if (want && typeof want === 'object') {
    if (!live || typeof live !== 'object' || Array.isArray(live)) return live;
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(want as object)) o[k] = subset((want as Record<string, unknown>)[k], (live as Record<string, unknown>)[k]);
    return o;
  }
  return live;
}
function overlayInto(live: unknown, want: unknown): unknown {
  if (want && typeof want === 'object' && !Array.isArray(want) && live && typeof live === 'object' && !Array.isArray(live)) {
    const o: Record<string, unknown> = { ...(live as Record<string, unknown>) };
    for (const [k, v] of Object.entries(want as Record<string, unknown>)) o[k] = overlayInto(o[k], v);
    return o;
  }
  return structuredClone(want);
}

const VERBS = ['delete', 'deletecollection', 'get', 'list', 'patch', 'create', 'update', 'watch'];

function storageVersion(crd: CustomResourceDefinition): CrdVersion | undefined {
  return crd.spec.versions.find((v) => v.storage) ?? crd.spec.versions[0];
}

/** Rebuild the engine's list of custom resource types from the CRDs in the store (called whenever a CRD changes). */
export function syncCustomResources(engine: Engine): void {
  const list: ResourceInfo[] = [];
  for (const crd of engine.store.list<CustomResourceDefinition>('CustomResourceDefinition')) {
    if (crd.metadata.deletionTimestamp) continue;
    const v = storageVersion(crd);
    if (!v || !crd.spec?.names?.kind) continue;
    const n = crd.spec.names;
    list.push({
      kind: n.kind, group: crd.spec.group, version: v.name, plural: n.plural, singular: n.singular ?? n.kind.toLowerCase(), shortNames: n.shortNames ?? [],
      namespaced: crd.spec.scope !== 'Cluster', categories: n.categories ?? [], verbs: VERBS,
      // apiextensions: with no additionalPrinterColumns the server prints NAME and AGE
      columns: v.additionalPrinterColumns?.length ? v.additionalPrinterColumns.map((c) => ({ name: c.name, type: c.type, jsonPath: c.jsonPath, priority: c.priority })) : [{ name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' }],
    });
  }
  engine.crdResources.length = 0;
  engine.crdResources.push(...list);
}

export function crdFor(engine: Engine, kind: string, apiVersion?: string): CustomResourceDefinition | undefined {
  return engine.store.list<CustomResourceDefinition>('CustomResourceDefinition').find((c) => c.spec?.names?.kind === kind && (!apiVersion || c.spec.versions.some((v) => `${c.spec.group}/${v.name}` === apiVersion)));
}

function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function walk(schema: JsonSchema | undefined, value: unknown, path: string, unknown: string[], causes: string[]): void {
  if (!schema) return;
  const actual = jsonType(value);
  if (schema.type && !(schema.type === actual || (schema.type === 'number' && actual === 'integer'))) {
    causes.push(`${path}: Invalid value: "${actual}": ${path} in body must be of type ${schema.type}: "${actual}"`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) causes.push(`${path}: Unsupported value: ${JSON.stringify(value)}: supported values: ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) causes.push(`${path}: Invalid value: ${value}: ${path} in body should be greater than or equal to ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) causes.push(`${path}: Invalid value: ${value}: ${path} in body should be less than or equal to ${schema.maximum}`);
  }
  if (actual === 'array' && schema.items) (value as unknown[]).forEach((x, i) => walk(schema.items, x, `${path}[${i}]`, unknown, causes));
  if (actual === 'object') {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) if (obj[req] === undefined) causes.push(`${path ? `${path}.` : ''}${req}: Required value`);
    if (schema['x-kubernetes-preserve-unknown-fields']) return;
    const extra = schema.additionalProperties;
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k];
      const p = path ? `${path}.${k}` : k;
      if (sub) walk(sub, v, p, unknown, causes);
      else if (extra && typeof extra === 'object') walk(extra, v, p, unknown, causes);
      else if (extra !== true && schema.properties) unknown.push(p);
    }
  }
}

/** Validate a custom resource the way the API server does with `fieldValidation=Strict` (kubectl's default). */
export function validateCustomResource(crd: CustomResourceDefinition, obj: KubeObject): void {
  const version = crd.spec.versions.find((v) => `${crd.spec.group}/${v.name}` === obj.apiVersion) ?? storageVersion(crd);
  const schema = version?.schema?.openAPIV3Schema;
  if (!schema) return;
  const unknown: string[] = [], causes: string[] = [];
  const body: Record<string, unknown> = { ...obj };
  delete body.apiVersion; delete body.kind; delete body.metadata;
  walk({ ...schema, type: 'object', required: (schema.required ?? []).filter((r) => !['apiVersion', 'kind', 'metadata'].includes(r)) }, body, '', unknown, causes);
  const kind = crd.spec.names.kind;
  if (unknown.length) throw new ApiError('BadRequest', `${kind} in version "${version?.name}" cannot be handled as a ${kind}: strict decoding error: ${unknown.map((u) => `unknown field "${u}"`).join(', ')}`);
  if (causes.length) {
    const e = new ApiError('Invalid', `${kind} "${obj.metadata.name}" is invalid: ${causes.join(', ')}`);
    e.display = causes.length === 1 ? `The ${kind} "${obj.metadata.name}" is invalid: ${causes[0]}` : `The ${kind} "${obj.metadata.name}" is invalid: \n${causes.map((c) => `* ${c}`).join('\n')}`;
    throw e;
  }
}

export function runCrdController(engine: Engine): void {
  const crds = engine.store.list<CustomResourceDefinition>('CustomResourceDefinition');
  for (const crd of crds) {
    if (crd.status?.conditions?.some((c) => c.type === 'Established')) continue;
    const t = engine.clock.iso();
    crd.status = { acceptedNames: { ...crd.spec.names }, conditions: [{ type: 'NamesAccepted', status: 'True', reason: 'NoConflicts', message: 'no conflicts found', lastTransitionTime: t }, { type: 'Established', status: 'True', reason: 'InitialNamesAccepted', message: 'the initial names have been accepted', lastTransitionTime: t }], storedVersions: [storageVersion(crd)?.name ?? 'v1'] };
    engine.store.update(crd);
  }
  runOperators(engine);
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

export interface OperatorApi {
  engine: Engine;
  /** The operator pod that is running this reconcile loop. */
  pod: Pod;
  /** Append a line to the operator container's log. */
  log(line: string): void;
  /** RBAC check as the pod's ServiceAccount; logs the API server's Forbidden error (once per request kind) when denied. */
  can(verb: string, group: string, resource: string, namespace?: string): boolean;
  /**
   * Create the object, or update it when it exists and differs (owner references, defaults and admission included).
   * Returns false when RBAC or admission refuses — the reason is logged like a real controller would.
   */
  apply(obj: KubeObject, owner?: KubeObject): boolean;
  /** Write the status of a custom resource (the `/status` subresource). */
  setStatus(obj: KubeObject, status: Record<string, unknown>): void;
}

export interface OperatorSpec {
  /** Image repository the controller runs as (tag ignored), e.g. `registry.orbital.local/platform/route-operator`. */
  image: string;
  /** How often the loop runs (default 1s). */
  everyMs?: number;
  reconcile(api: OperatorApi): void;
}

/** A ready pod running the given controller image, if any (operators only work while their pod does). */
export function controllerPod(engine: Engine, repo: string): Pod | undefined {
  for (const p of engine.store.list<Pod>('Pod')) {
    if (p.metadata.deletionTimestamp || !isPodReady(p)) continue;
    if (p.spec.containers.some((c) => normalizeImage(c.image).repo === repo)) return p;
  }
  return undefined;
}

/** klog's line prefix: severity, MMDD, wall time with microseconds, pid (`E1005 09:00:07.100000       1`). */
function klogHeader(nowMs: number): string {
  const d = new Date(nowMs);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `E${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}000       1`;
}

export function runOperators(engine: Engine): void {
  if (!engine.operators.length) return;
  const now = engine.clock.nowMs;
  for (const op of engine.operators) {
    const key = `operator:${op.image}`;
    const last = engine.scratch.get(key) as number | undefined;
    if (last !== undefined && now - last < (op.everyMs ?? 1000)) continue;
    const pod = controllerPod(engine, op.image);
    if (!pod) continue;
    engine.scratch.set(key, now);
    const rt = engine.podRuntime(pod).containers.find((c) => normalizeImage(c.image).repo === op.image);
    const log = (line: string): void => { rt?.logs.push(`${engine.clock.iso()} ${line}`); if (rt && rt.logs.length > 400) rt.logs.splice(0, rt.logs.length - 400); };
    const user = serviceAccountUser(pod.metadata.namespace as string, pod.spec.serviceAccountName ?? 'default');
    const denied = (engine.scratch.get(`${key}:denied`) as Map<string, number> | undefined) ?? new Map<string, number>();
    engine.scratch.set(`${key}:denied`, denied);
    const can = (verb: string, group: string, resource: string, namespace?: string): boolean => {
      const req = { verb, group, resource, namespace };
      if (authorize(engine, user, req)) return true;
      const k = `${verb}|${group}|${resource}|${namespace ?? ''}`;
      if (now - (denied.get(k) ?? -Infinity) >= 10_000) { denied.set(k, now); log(`${klogHeader(now)} reflector.go:158] "Unhandled Error" err="k8s.io/client-go@v0.32.3/tools/cache/reflector.go:251: failed to ${verb} ${resource}${group ? `.${group}` : ''}: ${forbiddenMessage(user, req).replace(/"/g, '\\"')}" logger="UnhandledError"`); }
      return false;
    };
    op.reconcile({
      engine, pod, log, can,
      apply(obj, owner) {
        const info = resourceByKind(obj.kind);
        if (!info) { log(`E no matches for kind "${obj.kind}" in version "${obj.apiVersion}"`); return false; }
        const want = structuredClone(obj);
        if (info.namespaced) want.metadata.namespace = want.metadata.namespace ?? owner?.metadata.namespace ?? (pod.metadata.namespace as string);
        if (owner) want.metadata.ownerReferences = [engine.store.ownerRef(owner)];
        const live = engine.store.get(want.kind, want.metadata.namespace, want.metadata.name);
        if (!can(live ? 'update' : 'create', info.group, info.plural, want.metadata.namespace)) return false;
        try {
          if (!live) { const d = applyDefaults(want, engine); admit(engine, d, 'CREATE', { user }); engine.store.create(d); return true; }
          const merged = structuredClone(live);
          let changed = false;
          for (const k of Object.keys(want)) {
            if (k === 'metadata' || k === 'status' || k === 'apiVersion' || k === 'kind') continue;
            if (JSON.stringify(sortKeys(subset(want[k], merged[k]))) !== JSON.stringify(sortKeys(want[k]))) { merged[k] = overlayInto(merged[k], want[k]); changed = true; }
          }
          if (!changed) return true;
          applyDefaults(merged, engine);
          admit(engine, merged, 'UPDATE', { user, old: live });
          engine.store.update(merged, { specChanged: true });
          return true;
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          const k = `apply|${want.kind}|${want.metadata.name}`;
          if (now - (denied.get(k) ?? -Infinity) >= 10_000) { denied.set(k, now); log(`E controller.go:324] "Reconciler error" err="${e.message}"`); }
          return false;
        }
      },
      setStatus(obj, status) {
        if (JSON.stringify(sortKeys(obj.status ?? null)) === JSON.stringify(sortKeys(status))) return;
        obj.status = status;
        engine.store.update(obj);
      },
    });
  }
}
