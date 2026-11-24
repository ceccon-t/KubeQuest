/**
 * `kubectl kustomize` / `apply -k`: a faithful subset of Kustomize v5.5 (the version built into kubectl 1.32):
 * resources and bases, generators with content-hashed names, namespace/prefix/suffix/labels/annotations,
 * images, replicas and patches, the legacy output order. Unsupported fields fail honestly.
 */
import type { Vfs } from './vfs.ts';
import type { KubeObject, PodSpec, Container } from './types.ts';
import { parseAllDocuments, parseDocument, stringify, sortKeys, YamlError } from './yaml.ts';
import { resourceByKind } from './registry.ts';
import { sha256hex, b64encode } from './encoding.ts';
import { strategicMergePatch, jsonPatch, PatchError } from './patch.ts';
import { parseSelectorString, matches } from './selector.ts';

export class KustomizeError extends Error {}

interface Res { obj: KubeObject; origName: string; origNs?: string; hash?: boolean }
interface Target { group?: string; version?: string; kind?: string; name?: string; namespace?: string; labelSelector?: string }
interface Generator { name: string; namespace?: string; behavior?: 'create' | 'merge' | 'replace'; literals?: string[]; files?: string[]; envs?: string[]; type?: string; options?: { disableNameSuffixHash?: boolean; labels?: Record<string, string>; annotations?: Record<string, string> } }
interface Kustomization {
  resources?: string[]; bases?: string[]; namespace?: string; namePrefix?: string; nameSuffix?: string;
  commonLabels?: Record<string, string>; labels?: { pairs?: Record<string, string>; includeSelectors?: boolean; includeTemplates?: boolean }[]; commonAnnotations?: Record<string, string>;
  images?: { name: string; newName?: string; newTag?: string; digest?: string }[]; replicas?: { name: string; count: number }[];
  patches?: { path?: string; patch?: string; target?: Target }[]; patchesStrategicMerge?: string[];
  configMapGenerator?: Generator[]; secretGenerator?: Generator[]; generatorOptions?: { disableNameSuffixHash?: boolean; labels?: Record<string, string>; annotations?: Record<string, string> };
  [k: string]: unknown;
}

const KNOWN = ['apiVersion', 'kind', 'metadata', 'resources', 'bases', 'namespace', 'namePrefix', 'nameSuffix', 'commonLabels', 'labels', 'commonAnnotations', 'images', 'replicas', 'patches', 'patchesStrategicMerge', 'configMapGenerator', 'secretGenerator', 'generatorOptions'];
const UNSUPPORTED = ['components', 'helmCharts', 'replacements', 'vars', 'patchesJson6902', 'transformers', 'generators', 'crds', 'configurations', 'openapi', 'sortOptions', 'buildMetadata', 'validators'];
const FILES = ['kustomization.yaml', 'kustomization.yml', 'Kustomization'];
const WORKLOADS = ['Deployment', 'ReplicaSet', 'DaemonSet', 'StatefulSet', 'Job', 'ReplicationController'];

const ORDER_FIRST = ['Namespace', 'ResourceQuota', 'StorageClass', 'CustomResourceDefinition', 'ServiceAccount', 'PodSecurityPolicy', 'Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding', 'ConfigMap', 'Secret', 'Endpoints', 'Service', 'LimitRange', 'PriorityClass', 'PersistentVolume', 'PersistentVolumeClaim', 'Deployment', 'StatefulSet', 'CronJob', 'PodDisruptionBudget'];
const ORDER_LAST = ['MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration'];

function gvkKey(o: KubeObject): string {
  const [g, v] = o.apiVersion.includes('/') ? (o.apiVersion.split('/') as [string, string]) : ['~G', o.apiVersion];
  return `${g}_${v}_${o.kind}`;
}

/** upstream: api/internal/builtins/SortOrderTransformer.go (legacy order). */
function legacySort(list: Res[]): Res[] {
  const rank = (k: string): number => { const f = ORDER_FIRST.indexOf(k); if (f >= 0) return f - ORDER_FIRST.length; const l = ORDER_LAST.indexOf(k); return l >= 0 ? 1 + l : 0; };
  const id = (r: Res): string => `${gvkKey(r.obj)}|${r.obj.metadata.namespace ?? '~X'}|${r.obj.metadata.name || '~N'}`;
  return [...list].sort((a, b) => rank(a.obj.kind) - rank(b.obj.kind) || (gvkKey(a.obj) < gvkKey(b.obj) ? -1 : gvkKey(a.obj) > gvkKey(b.obj) ? 1 : id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0));
}

/** upstream: api/hasher — 10 hex chars of the SHA-256 of the canonical JSON, with a few characters remapped. */
export function generatorHash(obj: KubeObject): string {
  const m: Record<string, unknown> = { data: (obj.data as unknown) ?? '', kind: obj.kind, name: obj.metadata.name };
  if (obj.kind === 'ConfigMap') { if (obj.binaryData && typeof obj.binaryData === 'object') m.binaryData = obj.binaryData; }
  else { m.type = (obj.type as string | undefined) ?? ''; if (obj.stringData && typeof obj.stringData === 'object') m.stringData = obj.stringData; }
  // Go's json.Marshal: sorted keys, compact, HTML-escaped
  const json = JSON.stringify(sortKeys(m)).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const map: Record<string, string> = { '0': 'g', '1': 'h', '3': 'k', a: 'm', e: 't' };
  return sha256hex(json).slice(0, 10).replace(/[013ae]/g, (c) => map[c] as string);
}

function podSpecs(o: KubeObject): PodSpec[] {
  const s = o.spec as { template?: { spec?: PodSpec }; jobTemplate?: { spec?: { template?: { spec?: PodSpec } } } } | undefined;
  if (o.kind === 'Pod') return o.spec ? [o.spec as unknown as PodSpec] : [];
  if (o.kind === 'CronJob') return s?.jobTemplate?.spec?.template?.spec ? [s.jobTemplate.spec.template.spec] : [];
  return s?.template?.spec ? [s.template.spec] : [];
}

function targetMatches(t: Target, r: Res): boolean {
  const o = r.obj;
  const [g, v] = o.apiVersion.includes('/') ? (o.apiVersion.split('/') as [string, string]) : ['', o.apiVersion];
  const re = (p: string | undefined, val: string): boolean => p === undefined || p === '' || new RegExp(`^(?:${p})$`).test(val);
  if (!re(t.group, g) || !re(t.version, v) || !re(t.kind, o.kind) || !re(t.namespace, o.metadata.namespace ?? '')) return false;
  if (!(re(t.name, o.metadata.name) || re(t.name, r.origName))) return false;
  return !t.labelSelector || matches(parseSelectorString(t.labelSelector), o.metadata.labels);
}

function parseYaml(text: string, where: string): unknown[] {
  try { return parseAllDocuments(text).filter((d) => d !== null && d !== undefined); }
  catch (e) { if (e instanceof YamlError) throw new KustomizeError(`accumulating resources: accumulation err='accumulating resources from '${where}': MalformedYAMLError: ${e.message} in File: ${where}'`); throw e; }
}

function build(vfs: Vfs, dirIn: string, warnings: string[]): Res[] {
  const dir = vfs.resolve(dirIn);
  const file = FILES.find((f) => vfs.read(`${dir}/${f}`) !== undefined);
  if (!file) throw new KustomizeError(`unable to find one of 'kustomization.yaml', 'kustomization.yml' or 'Kustomization' in directory '${dir}'`);
  let k: Kustomization;
  try { k = (parseDocument(vfs.read(`${dir}/${file}`) as string) ?? {}) as Kustomization; }
  catch (e) { throw new KustomizeError(`invalid Kustomization: ${(e as Error).message}`); }
  for (const key of Object.keys(k)) {
    if (UNSUPPORTED.includes(key)) throw new KustomizeError(`kubequest: the kustomization field "${key}" is not supported in the simulator yet`);
    if (!KNOWN.includes(key)) throw new KustomizeError(`invalid Kustomization: json: unknown field "${key}"`);
  }
  const warn = (old: string, now: string): void => { warnings.push(`# Warning: '${old}' is deprecated. Please use '${now}' instead. Run 'kustomize edit fix' to update your Kustomization automatically.`); };
  if (k.commonLabels) warn('commonLabels', 'labels');
  if (k.patchesStrategicMerge) warn('patchesStrategicMerge', 'patches');
  if (k.bases) warn('bases', 'resources');
  // 1. accumulate resources
  let all: Res[] = [];
  for (const entry of [...(k.resources ?? []), ...(k.bases ?? [])]) {
    const path = `${dir}/${entry}`;
    const text = vfs.read(path);
    if (text !== undefined) {
      for (const d of parseYaml(text, entry)) {
        const o = d as KubeObject;
        if (!o.kind || !o.metadata) throw new KustomizeError(`accumulating resources: accumulation err='accumulating resources from '${entry}': missing metadata.name in object'`);
        all.push({ obj: o, origName: o.metadata.name, origNs: o.metadata.namespace });
      }
    } else if (vfs.isDir(path) && FILES.some((f) => vfs.read(`${vfs.resolve(path)}/${f}`) !== undefined)) all.push(...build(vfs, path, warnings));
    else {
      const abs = vfs.resolve(path);
      const why = `evalsymlink failure on '${abs}' : lstat ${abs}: no such file or directory`;
      throw new KustomizeError(`accumulating resources: accumulation err='accumulating resources from '${entry}': ${why}': must build at directory: not a valid directory: ${why}`);
    }
  }
  // 2. generators
  const gen = (g: Generator, kind: 'ConfigMap' | 'Secret'): void => {
    const data: Record<string, string> = {};
    const put = (key: string, value: string): void => { data[key] = kind === 'Secret' ? b64encode(value) : value; };
    for (const lit of g.literals ?? []) { const i = lit.indexOf('='); if (i <= 0) throw new KustomizeError(`invalid literal source ${lit}, expected key=value`); put(lit.slice(0, i), lit.slice(i + 1)); }
    for (const f of g.files ?? []) {
      const i = f.indexOf('=');
      const [key, path] = i > 0 ? [f.slice(0, i), f.slice(i + 1)] : [f.split('/').pop() as string, f];
      const content = vfs.read(`${dir}/${path}`);
      if (content === undefined) throw new KustomizeError(`loading KV pairs: file sources: [${f}]: evalsymlink failure on '${vfs.resolve(`${dir}/${path}`)}' : lstat ${vfs.resolve(`${dir}/${path}`)}: no such file or directory`);
      put(key, content);
    }
    for (const f of g.envs ?? []) {
      const content = vfs.read(`${dir}/${f}`);
      if (content === undefined) throw new KustomizeError(`loading KV pairs: env source files: [${f}]: evalsymlink failure on '${vfs.resolve(`${dir}/${f}`)}' : lstat ${vfs.resolve(`${dir}/${f}`)}: no such file or directory`);
      for (const line of content.split('\n')) { const t = line.trim(); if (!t || t.startsWith('#')) continue; const i = t.indexOf('='); if (i > 0) put(t.slice(0, i), t.slice(i + 1)); }
    }
    const opts = { ...(k.generatorOptions ?? {}), ...(g.options ?? {}) };
    const meta: KubeObject['metadata'] = { name: g.name };
    if (g.namespace) meta.namespace = g.namespace;
    if (opts.labels) meta.labels = { ...opts.labels };
    if (opts.annotations) meta.annotations = { ...opts.annotations };
    const obj: KubeObject = kind === 'ConfigMap' ? { apiVersion: 'v1', kind, metadata: meta, data } : { apiVersion: 'v1', kind, metadata: meta, type: g.type ?? 'Opaque', data };
    // upstream: api/resmap AbsorbAll / resource.Merge — an overlay generator may merge into or replace the base's
    const id = `${kind === 'ConfigMap' ? '~G_v1_ConfigMap' : '~G_v1_Secret'}|~X|${g.name}`;
    const prior = all.find((r) => r.obj.kind === kind && r.origName === g.name);
    const behavior = g.behavior ?? 'create';
    if (behavior === 'merge' || behavior === 'replace') {
      if (!prior) throw new KustomizeError(`merging from generator ${g.name}: id ${id} does not exist; cannot merge or replace`);
      const target = prior.obj as KubeObject & { data?: Record<string, string> };
      target.data = behavior === 'merge' ? { ...(target.data ?? {}), ...data } : data;
      prior.hash = !opts.disableNameSuffixHash;
      return;
    }
    if (prior) throw new KustomizeError(`merging from generator ${g.name}: id ${id} exists; behavior must be merge or replace`);
    all.push({ obj, origName: g.name, origNs: g.namespace, hash: !opts.disableNameSuffixHash });
  };
  for (const g of k.configMapGenerator ?? []) gen(g, 'ConfigMap');
  for (const g of k.secretGenerator ?? []) gen(g, 'Secret');
  // 3. patches
  const applySm = (patchObj: KubeObject, targets: Res[], label: string): void => {
    if (!targets.length) throw new KustomizeError(`no resource matches strategic merge patch "${label}": no matches for Id ${gvkKey(patchObj)}|${patchObj.metadata?.namespace ?? '~X'}|${patchObj.metadata?.name ?? '~N'}; failed to find unique target for patch ${gvkKey(patchObj)}|${patchObj.metadata?.name ?? '~N'}`);
    for (const r of targets) {
      const keepName = r.obj.metadata.name, keepKind = r.obj.kind, keepApi = r.obj.apiVersion;
      const next = strategicMergePatch(r.obj, patchObj) as KubeObject;
      next.metadata.name = keepName; next.kind = keepKind; next.apiVersion = keepApi; // name/kind changes need explicit options
      r.obj = next;
    }
  };
  for (const p of k.patchesStrategicMerge ?? []) {
    const text = vfs.read(`${dir}/${p}`) ?? (p.includes('\n') ? p : undefined);
    if (text === undefined) throw new KustomizeError(`trouble configuring builtin PatchStrategicMergeTransformer with config: \`\npaths:\n- ${p}\n\`: failed to get the patch file from path(${p}): evalsymlink failure on '${vfs.resolve(`${dir}/${p}`)}' : lstat ${vfs.resolve(`${dir}/${p}`)}: no such file or directory`);
    for (const d of parseYaml(text, p)) { const po = d as KubeObject; applySm(po, all.filter((r) => r.obj.kind === po.kind && r.obj.apiVersion === po.apiVersion && (r.obj.metadata.name === po.metadata?.name || r.origName === po.metadata?.name)), po.metadata?.name ?? p); }
  }
  for (const p of k.patches ?? []) {
    if (p.path !== undefined && p.patch !== undefined) throw new KustomizeError("patch and path can't be set at the same time");
    if (p.path === undefined && p.patch === undefined) throw new KustomizeError('must specify one of patch and path in');
    const text = p.path !== undefined ? vfs.read(`${dir}/${p.path}`) : p.patch;
    if (text === undefined) throw new KustomizeError(`failed to get the patch file from path(${p.path}): evalsymlink failure on '${vfs.resolve(`${dir}/${p.path}`)}' : lstat ${vfs.resolve(`${dir}/${p.path}`)}: no such file or directory`);
    const docs = parseYaml(text, p.path ?? 'patch');
    const first = docs[0];
    if (Array.isArray(first)) {
      if (!p.target) throw new KustomizeError(`must specify a target for JSON patch ${text.trim()}`);
      for (const r of all.filter((x) => targetMatches(p.target as Target, x))) {
        try { r.obj = jsonPatch(r.obj, first as { op: string; path: string; value?: unknown }[]) as KubeObject; }
        catch (e) { if (e instanceof PatchError) throw new KustomizeError(e.message); throw e; }
      }
    } else for (const d of docs) {
      const po = d as KubeObject;
      applySm(po, p.target ? all.filter((x) => targetMatches(p.target as Target, x)) : all.filter((r) => r.obj.kind === po.kind && r.obj.apiVersion === po.apiVersion && (r.obj.metadata.name === po.metadata?.name || r.origName === po.metadata?.name)), po.metadata?.name ?? '');
    }
  }
  // 4. namespace, prefix, suffix
  if (k.namespace) for (const r of all) {
    const info = resourceByKind(r.obj.kind);
    if (r.obj.kind === 'Namespace') r.obj.metadata.name = k.namespace;
    else if (!info || info.namespaced) r.obj.metadata.namespace = k.namespace;
    if (r.obj.kind === 'RoleBinding' || r.obj.kind === 'ClusterRoleBinding') for (const s of (r.obj.subjects as { kind: string; name: string; namespace?: string }[] | undefined) ?? []) if (s.kind === 'ServiceAccount' && s.name === 'default') s.namespace = k.namespace;
  }
  if (k.namePrefix || k.nameSuffix) for (const r of all) {
    if (r.obj.kind === 'CustomResourceDefinition' || r.obj.kind === 'Namespace') continue;
    r.obj.metadata.name = `${k.namePrefix ?? ''}${r.obj.metadata.name}${k.nameSuffix ?? ''}`;
  }
  // 5. labels and annotations
  const addLabels = (pairs: Record<string, string>, selectors: boolean, templates: boolean): void => {
    for (const r of all) {
      const o = r.obj;
      o.metadata.labels = { ...(o.metadata.labels ?? {}), ...pairs };
      const spec = o.spec as { selector?: Record<string, unknown>; template?: { metadata?: { labels?: Record<string, string> } }; jobTemplate?: { metadata?: { labels?: Record<string, string> }; spec?: { template?: { metadata?: { labels?: Record<string, string> } } } }; volumeClaimTemplates?: KubeObject[] } | undefined;
      if (!spec) continue;
      if (templates || selectors) {
        if (WORKLOADS.includes(o.kind) && spec.template) { spec.template.metadata = spec.template.metadata ?? {}; spec.template.metadata.labels = { ...(spec.template.metadata.labels ?? {}), ...pairs }; }
        if (o.kind === 'CronJob' && spec.jobTemplate) {
          spec.jobTemplate.metadata = spec.jobTemplate.metadata ?? {}; spec.jobTemplate.metadata.labels = { ...(spec.jobTemplate.metadata.labels ?? {}), ...pairs };
          const t = spec.jobTemplate.spec?.template; if (t) { t.metadata = t.metadata ?? {}; t.metadata.labels = { ...(t.metadata.labels ?? {}), ...pairs }; }
        }
        if (o.kind === 'StatefulSet') for (const t of spec.volumeClaimTemplates ?? []) t.metadata.labels = { ...(t.metadata.labels ?? {}), ...pairs };
      }
      if (selectors) {
        if (o.kind === 'Service' || o.kind === 'ReplicationController') spec.selector = { ...(spec.selector ?? {}), ...pairs };
        else if (['Deployment', 'ReplicaSet', 'DaemonSet', 'StatefulSet'].includes(o.kind)) { const sel = (spec.selector ??= {}) as { matchLabels?: Record<string, string> }; sel.matchLabels = { ...(sel.matchLabels ?? {}), ...pairs }; }
        else if (['Job', 'CronJob', 'PodDisruptionBudget', 'NetworkPolicy'].includes(o.kind)) { const sel = (o.kind === 'NetworkPolicy' ? (spec as { podSelector?: { matchLabels?: Record<string, string> } }).podSelector : spec.selector) as { matchLabels?: Record<string, string> } | undefined; if (sel?.matchLabels) sel.matchLabels = { ...sel.matchLabels, ...pairs }; }
      }
    }
  };
  for (const l of k.labels ?? []) addLabels(l.pairs ?? {}, !!l.includeSelectors, !!l.includeTemplates || !!l.includeSelectors);
  if (k.commonLabels) addLabels(k.commonLabels, true, true);
  if (k.commonAnnotations) for (const r of all) {
    r.obj.metadata.annotations = { ...(r.obj.metadata.annotations ?? {}), ...k.commonAnnotations };
    const t = (r.obj.spec as { template?: { metadata?: { annotations?: Record<string, string> } } } | undefined)?.template;
    if (t && WORKLOADS.includes(r.obj.kind)) { t.metadata = t.metadata ?? {}; t.metadata.annotations = { ...(t.metadata.annotations ?? {}), ...k.commonAnnotations }; }
  }
  // 6. replicas and images
  for (const rep of k.replicas ?? []) {
    const hits = all.filter((r) => ['Deployment', 'ReplicationController', 'ReplicaSet', 'StatefulSet'].includes(r.obj.kind) && (r.origName === rep.name || r.obj.metadata.name === rep.name));
    if (!hits.length) throw new KustomizeError(`resource with name ${rep.name} does not match a config with the following GVK [apps_v1_Deployment ~G_v1_ReplicationController apps_v1_ReplicaSet apps_v1_StatefulSet]`);
    for (const r of hits) (r.obj.spec as { replicas?: number }).replicas = rep.count;
  }
  for (const img of k.images ?? []) for (const r of all) for (const ps of podSpecs(r.obj)) for (const c of [...(ps.containers ?? []), ...(ps.initContainers ?? [])] as Container[]) {
    const at = c.image.indexOf('@');
    const noDigest = at >= 0 ? c.image.slice(0, at) : c.image;
    const colon = noDigest.lastIndexOf(':');
    const hasTag = colon > noDigest.lastIndexOf('/');
    const name = hasTag ? noDigest.slice(0, colon) : noDigest;
    if (name !== img.name) continue;
    const tag = img.newTag ?? (img.digest ? undefined : hasTag ? noDigest.slice(colon + 1) : undefined);
    c.image = `${img.newName ?? name}${tag !== undefined ? `:${tag}` : ''}${img.digest ? `@${img.digest}` : at >= 0 && !img.newTag ? c.image.slice(at) : ''}`;
  }
  return all;
}

function fixReferences(all: Res[]): void {
  const renamed = (kind: string, name: string | undefined, ns: string | undefined): string | undefined => {
    if (!name) return undefined;
    const hit = all.find((r) => r.obj.kind === kind && r.origName === name && r.obj.metadata.name !== name && (r.origNs === undefined || ns === undefined || r.origNs === ns || r.obj.metadata.namespace === ns));
    return hit?.obj.metadata.name;
  };
  for (const r of all) {
    const o = r.obj, ns = r.origNs ?? o.metadata.namespace;
    const fix = <T extends Record<string, unknown>>(holder: T | undefined, field: keyof T & string, kind: string): void => { if (!holder) return; const n = renamed(kind, holder[field] as string | undefined, ns); if (n) (holder as Record<string, unknown>)[field] = n; };
    for (const ps of podSpecs(o)) {
      for (const v of ps.volumes ?? []) {
        fix(v.configMap as Record<string, unknown> | undefined, 'name', 'ConfigMap');
        fix(v.secret as Record<string, unknown> | undefined, 'secretName', 'Secret');
        fix(v.persistentVolumeClaim as Record<string, unknown> | undefined, 'claimName', 'PersistentVolumeClaim');
        for (const src of ((v.projected as { sources?: { configMap?: Record<string, unknown>; secret?: Record<string, unknown> }[] } | undefined)?.sources) ?? []) { fix(src.configMap, 'name', 'ConfigMap'); fix(src.secret, 'name', 'Secret'); }
      }
      for (const c of [...(ps.containers ?? []), ...(ps.initContainers ?? [])]) {
        for (const e of c.env ?? []) { fix(e.valueFrom?.configMapKeyRef as Record<string, unknown> | undefined, 'name', 'ConfigMap'); fix(e.valueFrom?.secretKeyRef as Record<string, unknown> | undefined, 'name', 'Secret'); }
        for (const e of c.envFrom ?? []) { fix(e.configMapRef as Record<string, unknown> | undefined, 'name', 'ConfigMap'); fix(e.secretRef as Record<string, unknown> | undefined, 'name', 'Secret'); }
      }
      for (const s of ps.imagePullSecrets ?? []) fix(s as Record<string, unknown>, 'name', 'Secret');
      fix(ps as unknown as Record<string, unknown>, 'serviceAccountName', 'ServiceAccount');
    }
    const spec = o.spec as Record<string, unknown> | undefined;
    if (o.kind === 'StatefulSet') fix(spec, 'serviceName', 'Service');
    if (o.kind === 'HorizontalPodAutoscaler') { const ref = spec?.scaleTargetRef as { kind?: string } & Record<string, unknown> | undefined; fix(ref, 'name', ref?.kind ?? 'Deployment'); }
    if (o.kind === 'Ingress') {
      const s = spec as { tls?: Record<string, unknown>[]; defaultBackend?: { service?: Record<string, unknown> }; rules?: { http?: { paths?: { backend?: { service?: Record<string, unknown> } }[] } }[] } | undefined;
      for (const t of s?.tls ?? []) fix(t, 'secretName', 'Secret');
      fix(s?.defaultBackend?.service, 'name', 'Service');
      for (const rule of s?.rules ?? []) for (const p of rule.http?.paths ?? []) fix(p.backend?.service, 'name', 'Service');
    }
    if (o.kind === 'RoleBinding' || o.kind === 'ClusterRoleBinding') {
      const ref = o.roleRef as ({ kind?: string } & Record<string, unknown>) | undefined;
      fix(ref, 'name', ref?.kind ?? 'Role');
      for (const s of (o.subjects as ({ kind?: string } & Record<string, unknown>)[] | undefined) ?? []) if (s.kind === 'ServiceAccount') fix(s, 'name', 'ServiceAccount');
    }
    if (o.kind === 'ServiceAccount') for (const s of (o.imagePullSecrets as Record<string, unknown>[] | undefined) ?? []) fix(s, 'name', 'Secret');
  }
}

export interface KustomizeResult { objects: KubeObject[]; yaml: string; warnings: string[] }

/** Build the kustomization rooted at `dir` (as `kubectl kustomize DIR` does). */
export function kustomizeBuild(vfs: Vfs, dir: string): KustomizeResult {
  const warnings: string[] = [];
  const all = build(vfs, dir, warnings);
  // hash suffixes come last, once, at the top: the name hashed already carries every prefix/suffix
  for (const r of all) if (r.hash) r.obj.metadata.name = `${r.obj.metadata.name}-${generatorHash(r.obj)}`;
  // then every reference to a renamed object follows it
  fixReferences(all);
  const objects = legacySort(all).map((r) => r.obj);
  const seen = new Set<string>();
  for (const o of objects) {
    const id = `${gvkKey(o)}|${o.metadata.namespace ?? '~X'}|${o.metadata.name}`;
    if (seen.has(id)) throw new KustomizeError(`accumulating resources: accumulation err='merging resources: may not add resource with an already registered id: ${id.replace(/\|/g, '.').replace(/_/g, '.')}'`);
    seen.add(id);
  }
  return { objects, yaml: objects.map((o) => stringify(sortKeys(o) as never)).join('---\n'), warnings };
}
