import type { KubectlCommand, CommandContext, OutputChunk } from '../context.ts';
import { out, err } from '../context.ts';
import { str, bool, strs, int, KubectlError } from '../args.ts';
import { parseAllDocuments, YamlError, stringify } from '../../yaml.ts';
import { validateStructure, validateObject, resolveKind, ValidationError } from '../validate.ts';
import { applyDefaults } from '../../defaults.ts';
import { qualifiedName, resourceByKind } from '../../registry.ts';
import { ApiError } from '../../store.ts';
import type { Engine } from '../../engine.ts';
import type { KubeObject } from '../../types.ts';
import { parseOutputFlag, renderObjects } from '../output.ts';
import { parseResourceArgs, fetch } from '../resources.ts';
import { sortKeys } from '../../yaml.ts';
import { normalizeImage } from '../../images.ts';
import { parseCron } from '../../controllers/job.ts';
import { apiCreate, apiReplace, formatApiError, warningChunks, access } from '../api.ts';
import { crdFor, validateCustomResource } from '../../controllers/crd.ts';
import type { CustomResourceDefinition } from '../../types.ts';
import { generate, generateSecret, keyValueSources, jobFromCronJob, GENERATOR_FLAGS } from './generators.ts';
import { kustomizeBuild, KustomizeError } from '../../kustomize.ts';
import { b64encode } from '../../encoding.ts';

export const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

export interface Manifest { obj: KubeObject; source: string }

/** Read -f files from the VFS (or stdin for `-f -`) and parse every document. */
export function loadManifests(ctx: CommandContext, files: string[], recursive = false): Manifest[] {
  const out: Manifest[] = [];
  if (files.length === 0) throw new KubectlError('must specify one of -f and -k');
  for (const f of files) {
    let texts: { text: string; source: string }[] = [];
    if (f === '-') {
      if (ctx.stdin === undefined) throw new KubectlError('error reading STDIN: no input provided');
      texts = [{ text: ctx.stdin, source: 'STDIN' }];
    } else if (ctx.vfs.isDir(f)) {
      const entries = ctx.vfs.list(f).filter((e) => /\.(ya?ml|json)$/.test(e) || (recursive && e.endsWith('/')));
      if (!entries.some((e) => !e.endsWith('/'))) throw new KubectlError(`error reading ${f}: recognized file extensions are [.json .yaml .yml]`);
      for (const e of entries) if (!e.endsWith('/')) texts.push({ text: ctx.vfs.read(`${f}/${e}`) as string, source: `${f.replace(/\/$/, '')}/${e}` });
    } else {
      const text = ctx.vfs.read(f);
      if (text === undefined) throw new KubectlError(`the path "${f}" does not exist`);
      texts = [{ text, source: f }];
    }
    for (const { text, source } of texts) {
      let docs: unknown[];
      try {
        docs = source.endsWith('.json') ? [JSON.parse(text)] : parseAllDocuments(text);
      } catch (e) {
        if (e instanceof YamlError) throw new KubectlError(`error parsing ${source}: error converting YAML to JSON: ${e.message}`);
        throw new KubectlError(`error parsing ${source}: ${(e as Error).message}`);
      }
      for (const d of docs) {
        if (!d || typeof d !== 'object' || Array.isArray(d)) throw new KubectlError(`error validating "${source}": error validating data: invalid object to validate; if you choose to ignore these errors, turn validation off with --validate=false`);
        const obj = d as KubeObject;
        if ((obj as { kind?: string }).kind === 'List' && Array.isArray((obj as { items?: unknown }).items)) {
          for (const it of (obj as unknown as { items: KubeObject[] }).items) out.push({ obj: it, source });
        } else out.push({ obj, source });
      }
    }
  }
  if (out.length === 0) throw new KubectlError('no objects passed to apply');
  return out;
}

/** Admit an object: resolve kind, validate, default, namespace handling. Returns the object ready to store. */
export function admit(engine: Engine, m: Manifest, ns: string, nsExplicit: boolean, existing?: KubeObject): KubeObject {
  const { kind } = resolveKind(m.obj, m.source);
  if (!m.obj.metadata || typeof m.obj.metadata !== 'object') m.obj.metadata = { name: '' };
  try {
    validateStructure(m.obj, m.source);
  } catch (e) {
    if (e instanceof ValidationError) throw new KubectlError(`error validating "${m.source}": ${e.message}`);
    throw e;
  }
  const r = resourceByKind(kind);
  const obj = structuredClone(m.obj);
  obj.kind = kind;
  if (r?.namespaced) {
    if (obj.metadata.namespace && nsExplicit && obj.metadata.namespace !== ns) {
      throw new KubectlError(`the namespace from the provided object "${obj.metadata.namespace}" does not match the namespace "${ns}". You must pass '--namespace=${obj.metadata.namespace}' to perform this operation.`);
    }
    obj.metadata.namespace = obj.metadata.namespace ?? ns;
  } else delete obj.metadata.namespace;
  validateObject(obj, existing);
  if (kind === 'CustomResourceDefinition') {
    const c = obj as unknown as CustomResourceDefinition;
    const want = `${c.spec?.names?.plural ?? ''}.${c.spec?.group ?? ''}`;
    if (obj.metadata.name !== want) throw new ValidationError(`CustomResourceDefinition.apiextensions.k8s.io "${obj.metadata.name}" is invalid: metadata.name: Invalid value: "${obj.metadata.name}": must be spec.names.plural+"."+spec.group`);
  }
  const crd = r && engine.crdResources.includes(r) ? crdFor(engine, kind, obj.apiVersion) : undefined;
  if (crd) {
    try { validateCustomResource(crd, obj); }
    catch (e) { if (e instanceof ApiError) throw new KubectlError(formatApiError(e, m.source === 'edit' ? undefined : m.source)); throw e; }
  }
  if (r?.namespaced && !engine.store.get('Namespace', undefined, obj.metadata.namespace as string)) {
    throw new KubectlError(`Error from server (NotFound): error when creating "${m.source}": namespaces "${obj.metadata.namespace}" not found`);
  }
  if (kind === 'CronJob') {
    try { parseCron((obj.spec as { schedule: string }).schedule); } catch (e) { throw new ValidationError(`CronJob.batch "${obj.metadata.name}" is invalid: spec.schedule: Invalid value: "${(obj.spec as { schedule: string }).schedule}": ${(e as Error).message}`); }
  }
  // strip server-managed fields a user might paste from `get -o yaml`
  delete obj.metadata.uid;
  delete obj.metadata.resourceVersion;
  delete obj.metadata.creationTimestamp;
  delete obj.metadata.generation;
  delete (obj.metadata as unknown as Record<string, unknown>).managedFields;
  if (obj.status !== undefined && !existing) obj.status = undefined;
  if (obj.status === undefined) delete obj.status;
  return applyDefaults(obj, engine);
}

function stripForLastApplied(obj: KubeObject): KubeObject {
  const c = structuredClone(obj);
  delete c.status;
  delete c.metadata.uid;
  delete c.metadata.resourceVersion;
  delete c.metadata.creationTimestamp;
  delete c.metadata.generation;
  if (c.metadata.annotations) delete c.metadata.annotations[LAST_APPLIED];
  if (c.metadata.annotations && Object.keys(c.metadata.annotations).length === 0) delete c.metadata.annotations;
  return c;
}

/** Create or update (apply semantics). Returns the action taken. */
export function applyOne(ctx: CommandContext, m: Manifest, dryRun: boolean): { obj: KubeObject; action: 'created' | 'configured' | 'unchanged'; warnings: string[] } {
  const engine = ctx.engine, ns = ctx.namespace, nsExplicit = ctx.namespaceExplicit;
  const { kind } = resolveKind(m.obj, m.source);
  const r = resourceByKind(kind);
  const name = m.obj.metadata?.name;
  const targetNs = r?.namespaced ? (m.obj.metadata?.namespace ?? ns) : undefined;
  const existing = name ? engine.store.get(kind, targetNs, name) : undefined;
  const lastApplied = JSON.stringify(sortKeys(stripForLastApplied(m.obj)));
  if (!existing) {
    const obj = admit(engine, m, ns, nsExplicit);
    obj.metadata.annotations = { ...(obj.metadata.annotations ?? {}), [LAST_APPLIED]: lastApplied + '\n' };
    const warnings = dryRun ? [] : apiCreate(ctx, obj);
    return { obj, action: 'created', warnings };
  }
  const prevApplied = existing.metadata.annotations?.[LAST_APPLIED]?.trim();
  if (prevApplied === lastApplied) return { obj: existing, action: 'unchanged', warnings: [] };
  const incoming = admit(engine, m, ns, nsExplicit, existing);
  // three-way-ish merge: fields in the manifest win; fields previously applied but now absent are dropped; others kept
  const merged = structuredClone(existing);
  const prevObj = prevApplied ? (JSON.parse(prevApplied) as KubeObject) : undefined;
  for (const key of Object.keys(incoming)) {
    if (key === 'metadata' || key === 'kind' || key === 'apiVersion' || key === 'status') continue;
    const inc = incoming[key];
    if (inc && typeof inc === 'object' && !Array.isArray(inc) && merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
      const target = merged[key] as Record<string, unknown>;
      const src = inc as Record<string, unknown>;
      const prev = (prevObj?.[key] ?? {}) as Record<string, unknown>;
      const manifestSection = ((m.obj as Record<string, unknown>)[key] ?? {}) as Record<string, unknown>;
      for (const k of Object.keys(src)) if (manifestSection[k] !== undefined || target[k] === undefined) target[k] = src[k];
      for (const k of Object.keys(prev)) if (manifestSection[k] === undefined) delete target[k];
      // defaults for fields neither in manifest nor previously applied stay as they are
    } else merged[key] = inc;
  }
  merged.metadata.labels = incoming.metadata.labels;
  merged.metadata.annotations = { ...(incoming.metadata.annotations ?? {}), [LAST_APPLIED]: lastApplied + '\n' };
  for (const k of Object.keys(existing.metadata.annotations ?? {})) {
    if (k !== LAST_APPLIED && !(prevObj?.metadata.annotations ?? {})[k] && !merged.metadata.annotations[k]) merged.metadata.annotations[k] = existing.metadata.annotations![k] as string;
  }
  if (merged.metadata.labels === undefined) delete merged.metadata.labels;
  const specChanged = JSON.stringify(sortKeys(merged.spec)) !== JSON.stringify(sortKeys(existing.spec)) || JSON.stringify(merged.data) !== JSON.stringify(existing.data);
  let warnings: string[] = [];
  if (!dryRun) {
    applyDefaults(merged, engine);
    warnings = apiReplace(ctx, merged, existing, { specChanged });
  }
  return { obj: merged, action: 'configured', warnings };
}

function dryRunFlag(ctx: CommandContext): 'none' | 'client' | 'server' {
  const v = str(ctx.args, 'dry-run');
  if (v === undefined || v === 'none' || v === 'false') return 'none';
  if (v === 'client' || v === 'true' || v === '') return 'client';
  if (v === 'server') return 'server';
  throw new KubectlError(`invalid argument "${v}" for "--dry-run" flag: must be "none", "server", or "client"`);
}

export const applyCommand: KubectlCommand = {
  name: 'apply',
  summary: 'Apply a configuration to a resource by file name or stdin',
  usage: 'kubectl apply (-f FILENAME | -k DIRECTORY) [flags]',
  flags: [
    { name: 'filename', short: 'f', type: 'strings' },
    { name: 'kustomize', short: 'k', type: 'string' },
    { name: 'recursive', short: 'R', type: 'bool' },
    { name: 'dry-run', type: 'string', noOptDefault: 'client' },
    { name: 'output', short: 'o', type: 'string' },
    { name: 'server-side', type: 'bool' },
    { name: 'force', type: 'bool' },
    { name: 'validate', type: 'string', noOptDefault: 'strict' },
    { name: 'prune', type: 'bool' },
    { name: 'record', type: 'bool' },
    { name: 'selector', short: 'l', type: 'string' },
    { name: 'wait', type: 'bool' },
  ],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    if (bool(ctx.args, 'prune')) throw new KubectlError('kubequest: `apply --prune` is not supported in the simulator yet');
    if (ctx.args.positional.length) throw new KubectlError(`Unexpected args: [${ctx.args.positional.join(' ')}]`);
    let manifests: Manifest[];
    const kdir = str(ctx.args, 'kustomize');
    if (kdir !== undefined) {
      if (strs(ctx.args, 'filename').length) throw new KubectlError('only one of -f or -k can be specified');
      try {
        const built = kustomizeBuild(ctx.vfs, kdir);
        for (const w of built.warnings) yield err(w + '\n');
        manifests = built.objects.map((obj) => ({ obj, source: kdir }));
      } catch (e) { if (e instanceof KustomizeError) throw new KubectlError(e.message); throw e; }
      if (!manifests.length) throw new KubectlError('no objects passed to apply');
    } else manifests = loadManifests(ctx, strs(ctx.args, 'filename'), bool(ctx.args, 'recursive'));
    const dry = dryRunFlag(ctx);
    const fmt = parseOutputFlag(str(ctx.args, 'output'));
    let code = 0;
    for (const m of manifests) {
      try {
        const { obj, action, warnings } = applyOne(ctx, m, dry !== 'none');
        yield* warningChunks(warnings);
        if (bool(ctx.args, 'record') && !dry) {
          obj.metadata.annotations = { ...(obj.metadata.annotations ?? {}), 'kubernetes.io/change-cause': ctx.cmdline };
          ctx.engine.store.update(obj);
        }
        if (fmt.kind === 'table') yield out(`${qualifiedName(obj.kind, obj.metadata.name)} ${action}${dry === 'client' ? ' (dry run)' : dry === 'server' ? ' (server dry run)' : ''}\n`);
        else yield out(renderObjects(fmt, [obj], true));
      } catch (e) {
        if (e instanceof ValidationError) { yield err(`The ${e.message}\n`); code = 1; continue; }
        if (e instanceof KubectlError) { yield err((/^(Error from server|The |kubequest:)/.test(e.message) ? e.message : `error: ${e.message}`) + '\n'); code = 1; continue; }
        if (e instanceof ApiError) { yield err(formatApiError(e, m.source, 'creating') + '\n'); code = 1; continue; }
        throw e;
      }
    }
    return code;
  },
};

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

function containerNameFromImage(image: string): string {
  const { repo } = normalizeImage(image);
  const base = repo.split('/').pop() as string;
  return base.replace(/[^a-z0-9-]/gi, '-').toLowerCase().replace(/^-+|-+$/g, '') || 'container';
}

function parseKv(items: string[], flag: string): Record<string, string> {
  const outMap: Record<string, string> = {};
  for (const it of items) {
    const eq = it.indexOf('=');
    if (eq <= 0) throw new KubectlError(`invalid literal source ${it}, expected key=value`);
    outMap[it.slice(0, eq)] = it.slice(eq + 1);
  }
  void flag;
  return outMap;
}

function generatedDeployment(name: string, images: string[], replicas: number, port?: number, command?: string[]): KubeObject {
  const containers = images.map((img) => {
    const c: Record<string, unknown> = { image: img, name: containerNameFromImage(img), resources: {} };
    if (port) c.ports = [{ containerPort: port }];
    if (command?.length) c.command = command;
    return c;
  });
  return {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { creationTimestamp: null as unknown as string, labels: { app: name }, name },
    spec: { replicas, selector: { matchLabels: { app: name } }, strategy: {}, template: { metadata: { creationTimestamp: null, labels: { app: name } }, spec: { containers } } },
    status: {},
  } as KubeObject;
}

export const createCommand: KubectlCommand = {
  name: 'create',
  summary: 'Create a resource from a file or from stdin',
  usage: 'kubectl create -f FILENAME [flags]  |  kubectl create (namespace|deployment|configmap|secret|job|cronjob|service) NAME [flags]',
  flags: [
    { name: 'filename', short: 'f', type: 'strings' },
    { name: 'recursive', short: 'R', type: 'bool' },
    { name: 'dry-run', type: 'string', noOptDefault: 'client' },
    { name: 'output', short: 'o', type: 'string' },
    { name: 'save-config', type: 'bool' },
    { name: 'validate', type: 'string', noOptDefault: 'strict' },
    { name: 'image', type: 'strings' },
    { name: 'replicas', short: 'r', type: 'int' },
    { name: 'port', type: 'int' },
    { name: 'from-literal', type: 'strings' },
    { name: 'from-file', type: 'strings' },
    { name: 'from-env-file', type: 'strings' },
    { name: 'schedule', type: 'string' },
    { name: 'restart', type: 'string' },
    { name: 'tcp', type: 'strings' },
    { name: 'type', type: 'string' },
    { name: 'from', type: 'string' },
    { name: 'clusterip', type: 'string' },
    ...GENERATOR_FLAGS,
  ],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    const dry = dryRunFlag(ctx);
    const fmt = parseOutputFlag(str(a, 'output'));
    const files = strs(a, 'filename');
    const emit = async function* (obj: KubeObject, source: string): AsyncGenerator<OutputChunk, void> {
      if (dry !== 'none') {
        if (fmt.kind === 'table') yield out(`${qualifiedName(obj.kind, obj.metadata.name)} created (${dry === 'client' ? 'dry run' : 'server dry run'})\n`);
        else yield out(renderObjects(fmt, [obj], true));
        return;
      }
      const admitted = admit(ctx.engine, { obj, source }, ctx.namespace, ctx.namespaceExplicit);
      try { yield* warningChunks(apiCreate(ctx, admitted)); }
      catch (e) {
        // generators wrap API errors: `error: failed to create deployment: deployments.apps "web" is forbidden: …`
        if (e instanceof ApiError) throw new KubectlError(source === 'kubectl create' ? (e.reason === 'AlreadyExists' ? `failed to create ${admitted.kind.toLowerCase()}: ${e.message}` : `failed to create ${admitted.kind.toLowerCase()}: ${e.message}`) : formatApiError(e, source));
        throw e;
      }
      if (fmt.kind === 'table') yield out(`${qualifiedName(admitted.kind, admitted.metadata.name)} created\n`);
      else yield out(renderObjects(fmt, [admitted], true));
    };
    if (files.length) {
      if (a.positional.length) throw new KubectlError(`Unexpected args: [${a.positional.join(' ')}]`);
      const manifests = loadManifests(ctx, files, bool(a, 'recursive'));
      let code = 0;
      for (const m of manifests) {
        try {
          if (dry === 'none') {
            const admitted = admit(ctx.engine, m, ctx.namespace, ctx.namespaceExplicit);
            if (bool(a, 'save-config')) admitted.metadata.annotations = { ...(admitted.metadata.annotations ?? {}), [LAST_APPLIED]: JSON.stringify(sortKeys(stripForLastApplied(m.obj))) + '\n' };
            try { yield* warningChunks(apiCreate(ctx, admitted)); }
            catch (e) { if (e instanceof ApiError) throw new KubectlError(formatApiError(e, m.source)); throw e; }
            if (fmt.kind === 'table') yield out(`${qualifiedName(admitted.kind, admitted.metadata.name)} created\n`);
            else yield out(renderObjects(fmt, [admitted], true));
          } else yield* emit(m.obj, m.source);
        } catch (e) {
          if (e instanceof ValidationError) { yield err(`The ${e.message}\n`); code = 1; continue; }
          if (e instanceof KubectlError) { yield err((/^(Error from server|The |kubequest:)/.test(e.message) ? e.message : `error: ${e.message}`) + '\n'); code = 1; continue; }
          throw e;
        }
      }
      return code;
    }
    const sub = a.positional[0];
    if (!sub) throw new KubectlError('must specify one of -f and -k');
    const name = a.positional[1];
    const need = (): string => { if (!name) throw new KubectlError(`NAME is required`); return name; };
    let obj: KubeObject;
    switch (sub) {
      case 'namespace': case 'ns':
        obj = { apiVersion: 'v1', kind: 'Namespace', metadata: { creationTimestamp: null as unknown as string, name: need() }, spec: {}, status: {} };
        break;
      case 'deployment': case 'deploy': {
        const images = strs(a, 'image');
        if (!images.length) throw new KubectlError('required flag(s) "image" not set');
        obj = generatedDeployment(need(), images, int(a, 'replicas') ?? 1, int(a, 'port'), a.rest);
        break;
      }
      case 'configmap': case 'cm': {
        const data = keyValueSources(ctx);
        obj = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { creationTimestamp: null as unknown as string, name: need() }, ...(Object.keys(data).length ? { data } : {}) };
        break;
      }
      case 'secret': {
        const kind = a.positional[1];
        const sname = a.positional[2];
        if (!kind || !['generic', 'tls', 'docker-registry'].includes(kind)) throw new KubectlError(kind ? `unknown command "${kind}" for "kubectl create secret"` : 'You must specify the secret type (generic, tls or docker-registry)');
        if (!sname || a.positional.length !== 3) throw new KubectlError(`exactly one NAME is required, got ${Math.max(0, a.positional.length - 2)}\nSee 'kubectl create secret ${kind} -h' for help and examples`);
        const special = generateSecret(ctx, kind, sname);
        if (special) { obj = special; break; }
        const data: Record<string, string> = {};
        for (const [k, v] of Object.entries(keyValueSources(ctx))) data[k] = b64encode(v);
        obj = { apiVersion: 'v1', kind: 'Secret', metadata: { creationTimestamp: null as unknown as string, name: sname }, ...(str(a, 'type') ? { type: str(a, 'type') } : {}), ...(Object.keys(data).length ? { data } : {}) };
        break;
      }
      case 'job': {
        const image = strs(a, 'image')[0];
        if (!image && !str(a, 'from')) throw new KubectlError('required flag(s) "image" not set');
        if (str(a, 'from')) { obj = jobFromCronJob(ctx, need(), str(a, 'from') as string); break; }
        const c: Record<string, unknown> = { image, name: need(), resources: {} };
        if (a.rest.length) c.command = a.rest;
        obj = { apiVersion: 'batch/v1', kind: 'Job', metadata: { creationTimestamp: null as unknown as string, name: need() }, spec: { template: { metadata: { creationTimestamp: null }, spec: { containers: [c], restartPolicy: 'Never' } } }, status: {} };
        break;
      }
      case 'cronjob': case 'cj': {
        const image = strs(a, 'image')[0];
        const schedule = str(a, 'schedule');
        if (!image) throw new KubectlError('required flag(s) "image" not set');
        if (!schedule) throw new KubectlError('required flag(s) "schedule" not set');
        const c: Record<string, unknown> = { image, name: need(), resources: {} };
        if (a.rest.length) c.command = a.rest;
        obj = { apiVersion: 'batch/v1', kind: 'CronJob', metadata: { creationTimestamp: null as unknown as string, name: need() }, spec: { jobTemplate: { metadata: { creationTimestamp: null, name: need() }, spec: { template: { metadata: { creationTimestamp: null }, spec: { containers: [c], restartPolicy: str(a, 'restart') ?? 'OnFailure' } } } }, schedule }, status: {} };
        break;
      }
      case 'service': case 'svc': {
        const type = a.positional[1];
        const sname = a.positional[2];
        const typeMap: Record<string, string> = { clusterip: 'ClusterIP', nodeport: 'NodePort', loadbalancer: 'LoadBalancer' };
        if (!type || !typeMap[type]) throw new KubectlError(type ? `kubequest: "create service ${type}" is not supported in the simulator yet` : 'You must specify the service type (clusterip, nodeport, loadbalancer)');
        if (!sname) throw new KubectlError('NAME is required');
        const ports = strs(a, 'tcp').map((t) => { const [p, tp] = t.split(':'); const port = parseInt(p as string, 10); return { name: `${port}-${tp ?? port}`, port, protocol: 'TCP', targetPort: tp ? (/^\d+$/.test(tp) ? parseInt(tp, 10) : tp) : port }; });
        const headless = str(a, 'clusterip');
        if (!ports.length && headless !== 'None') throw new KubectlError('at least one tcp port specifier must be provided');
        obj = { apiVersion: 'v1', kind: 'Service', metadata: { creationTimestamp: null as unknown as string, labels: { app: sname }, name: sname }, spec: { ...(headless ? { clusterIP: headless } : {}), ...(ports.length ? { ports } : {}), selector: { app: sname }, type: typeMap[type] }, status: { loadBalancer: {} } };
        break;
      }
      case 'token': {
        const sa = need();
        if (!ctx.engine.store.get('ServiceAccount', ctx.namespace, sa)) throw new KubectlError(`failed to create token: serviceaccounts "${sa}" not found`);
        // a signed JWT in reality; the simulator has no signing key, so the payload is the only meaningful part
        yield out(`eyJhbGciOiJSUzI1NiIsImtpZCI6IkpIeTh4In0.${b64encode(JSON.stringify({ aud: ['https://kubernetes.default.svc.cluster.local'], iss: 'https://kubernetes.default.svc.cluster.local', sub: `system:serviceaccount:${ctx.namespace}:${sa}` })).replace(/=+$/, '')}.c2ltdWxhdGVkLXNpZ25hdHVyZQ\n`);
        return 0;
      }
      default: {
        const generated = generate(ctx, sub);
        if (!generated) throw new KubectlError(`kubequest: "create ${sub}" is not supported in the simulator yet`);
        obj = generated;
      }
    }
    if (dry === 'none') { delete obj.metadata.creationTimestamp; }
    // upstream: an explicit --namespace is enforced on generated objects (EnforceNamespace)
    if (ctx.namespaceExplicit && resourceByKind(obj.kind)?.namespaced) obj.metadata.namespace = ctx.namespace;
    yield* emit(obj, 'kubectl create');
    return 0;
  },
};

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

export const editCommand: KubectlCommand = {
  name: 'edit',
  summary: 'Edit a resource on the server',
  usage: 'kubectl edit (RESOURCE/NAME | -f FILENAME) [flags]',
  flags: [
    { name: 'filename', short: 'f', type: 'strings' },
    { name: 'output', short: 'o', type: 'string' },
    { name: 'save-config', type: 'bool' },
  ],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    if (strs(ctx.args, 'filename').length) throw new KubectlError('kubequest: `edit -f` is not supported in the simulator yet');
    const refs = parseResourceArgs(ctx.args.positional);
    if (refs.length !== 1 || refs[0]!.name === undefined) throw new KubectlError('kubequest: edit one resource at a time (TYPE NAME or TYPE/NAME)');
    const obj = fetch(ctx.engine, refs[0]!, ctx.namespace, false, undefined, undefined, access(ctx))[0] as KubeObject;
    const header = `# Please edit the object below. Lines beginning with a '#' will be ignored,\n# and an empty file will abort the edit. If an error occurs while saving this file will be\n# reopened with the relevant failures.\n#\n`;
    const text = header + stringify(sortKeys(obj) as never);
    const edited = await ctx.host.editor(text, `${obj.kind.toLowerCase()}-${obj.metadata.name}.yaml`);
    if (edited === null || edited.trim() === '' || edited.split('\n').every((l) => l.trim() === '' || l.startsWith('#'))) { yield out('Edit cancelled, no changes made.\n'); return 0; }
    const body = edited.split('\n').filter((l) => !l.startsWith('#')).join('\n');
    if (body.trim() === text.split('\n').filter((l) => !l.startsWith('#')).join('\n').trim()) { yield out('Edit cancelled, no changes made.\n'); return 0; }
    let docs: unknown[];
    try { docs = parseAllDocuments(body); } catch (e) { yield err(`error: ${(e as Error).message}\nEdit cancelled, no valid changes were saved.\n`); return 1; }
    const doc = docs[0] as KubeObject | undefined;
    if (!doc) { yield out('Edit cancelled, no changes made.\n'); return 0; }
    try {
      validateStructure(doc, 'edit');
      if (doc.kind !== obj.kind || doc.metadata?.name !== obj.metadata.name) throw new KubectlError('kubequest: kind and metadata.name cannot be changed in an edit');
      const incoming = structuredClone(doc);
      delete incoming.status;
      incoming.metadata.namespace = obj.metadata.namespace;
      validateObject(incoming, obj);
      const merged = structuredClone(obj);
      for (const k of Object.keys(incoming)) if (k !== 'status') merged[k] = incoming[k];
      for (const k of Object.keys(merged)) if (k !== 'status' && incoming[k] === undefined && k !== 'kind' && k !== 'apiVersion') delete merged[k];
      merged.metadata.uid = obj.metadata.uid;
      merged.metadata.resourceVersion = obj.metadata.resourceVersion;
      merged.metadata.creationTimestamp = obj.metadata.creationTimestamp;
      const specChanged = JSON.stringify(sortKeys(merged.spec ?? merged.data)) !== JSON.stringify(sortKeys(obj.spec ?? obj.data)) || JSON.stringify(merged.data) !== JSON.stringify(obj.data);
      applyDefaults(merged, ctx.engine);
      yield* warningChunks(apiReplace(ctx, merged, obj, { specChanged }));
      yield out(`${qualifiedName(obj.kind, obj.metadata.name)} edited\n`);
      return 0;
    } catch (e) {
      if (e instanceof ValidationError) { yield err(`error: ${obj.kind.toLowerCase()}s "${obj.metadata.name}" could not be patched: ${e.message}\nYou can run \`kubectl replace -f /tmp/kubectl-edit.yaml\` to try this update again.\n`); return 1; }
      if (e instanceof KubectlError) { yield err((/^(Error from server|The )/.test(e.message) ? e.message : `error: ${e.message}`) + '\n'); return 1; }
      if (e instanceof ApiError) { yield err(`error: ${resourceByKind(obj.kind)?.plural ?? obj.kind.toLowerCase()} "${obj.metadata.name}" could not be patched: ${e.message}\nYou can run \`kubectl replace -f /tmp/kubectl-edit.yaml\` to try this update again.\n`); return 1; }
      throw e;
    }
  },
};
