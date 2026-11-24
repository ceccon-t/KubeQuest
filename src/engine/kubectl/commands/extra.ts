/** Commands added with the full curriculum: auth, taint, autoscale, patch, debug, kustomize. */
import type { KubectlCommand, CommandContext, OutputChunk } from '../context.ts';
import { out, err } from '../context.ts';
import { str, bool, strs, int, KubectlError } from '../args.ts';
import { parseResourceArgs, fetch } from '../resources.ts';
import { resolveResource, qualifiedName, resourceByKind } from '../../registry.ts';
import type { KubeObject, Node, Pod, Taint, Container, PolicyRule } from '../../types.ts';
import { authorize, rulesFor } from '../../rbac.ts';
import { tabwrite } from '../tabwriter.ts';
import { access, apiCreate, apiMutate, apiReplace, formatApiError, warningChunks } from '../api.ts';
import { ApiError } from '../../store.ts';
import { admit } from './apply.ts';
import { mergePatch, strategicMergePatch, jsonPatch, PatchError } from '../../patch.ts';
import { parseDocument, YamlError, sortKeys } from '../../yaml.ts';
import { validateObject, ValidationError } from '../validate.ts';
import { applyDefaults } from '../../defaults.ts';
import { kustomizeBuild, KustomizeError } from '../../kustomize.ts';
import { interactiveShell } from '../../container-shell.ts';
import { parseOutputFlag, renderObjects } from '../output.ts';

function table(rows: string[][]): string {
  return tabwrite(rows.map((r) => r.join('\t')).join('\n') + '\n', { minwidth: 6, tabwidth: 4, padding: 3 });
}

const KNOWN_VERBS = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection', 'use', 'bind', 'impersonate', '*', 'approve', 'sign', 'escalate', 'attest'];

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

export const authCommand: KubectlCommand = {
  name: 'auth',
  summary: 'Inspect authorization',
  usage: 'kubectl auth can-i VERB [TYPE | TYPE/NAME | NONRESOURCEURL] [flags]  |  kubectl auth whoami',
  flags: [{ name: 'list', type: 'bool' }, { name: 'all-namespaces', short: 'A', type: 'bool' }, { name: 'quiet', short: 'q', type: 'bool' }, { name: 'subresource', type: 'string' }, { name: 'no-headers', type: 'bool' }, { name: 'output', short: 'o', type: 'string' }],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    const sub = a.positional[0];
    if (sub === 'whoami') {
      yield out(table([['ATTRIBUTE', 'VALUE'], ['Username', ctx.user.name], ['Groups', `[${ctx.user.groups.join(' ')}]`]]));
      return 0;
    }
    if (sub !== 'can-i') throw new KubectlError(sub ? `unknown command "${sub}" for "kubectl auth"` : 'You must specify a subcommand: can-i, whoami');
    const allNs = bool(a, 'all-namespaces');
    if (bool(a, 'list')) {
      // upstream: SelfSubjectRulesReview → one row per (resource, resourceName) with merged verbs
      const ns = allNs ? undefined : ctx.namespace;
      const rules: PolicyRule[] = ctx.user.groups.includes('system:masters') ? [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }, { nonResourceURLs: ['*'], verbs: ['*'] }] : rulesFor(ctx.engine, ctx.user, ns);
      const rows: string[][] = [];
      const basics = ['selfsubjectreviews.authentication.k8s.io', 'selfsubjectaccessreviews.authorization.k8s.io', 'selfsubjectrulesreviews.authorization.k8s.io'];
      for (const b of basics) rows.push([b, '[]', '[]', '[create]']);
      const merged = new Map<string, { res: string; url: string; name: string; verbs: string[] }>();
      for (const r of rules) {
        for (const u of r.nonResourceURLs ?? []) { const k = `u|${u}`; const row = merged.get(k) ?? { res: '', url: u, name: '', verbs: [] }; for (const v of r.verbs) if (!row.verbs.includes(v)) row.verbs.push(v); merged.set(k, row); }
        for (const g of r.apiGroups ?? []) for (const res of r.resources ?? []) {
          const [base, subres] = res.split('/') as [string, string | undefined];
          const full = `${base}${g ? `.${g}` : ''}${subres ? `/${subres}` : ''}`;
          for (const n of r.resourceNames?.length ? r.resourceNames : ['']) { const k = `${full}|${n}`; const row = merged.get(k) ?? { res: full, url: '', name: n, verbs: [] }; for (const v of r.verbs) if (!row.verbs.includes(v)) row.verbs.push(v); merged.set(k, row); }
        }
      }
      for (const row of [...merged.values()].sort((x, y) => (x.res < y.res ? -1 : x.res > y.res ? 1 : 0))) rows.push([row.res, `[${row.url}]`, `[${row.name}]`, `[${row.verbs.join(' ')}]`]);
      for (const u of ['/api/*', '/api', '/apis/*', '/apis', '/healthz', '/livez', '/openapi/*', '/openapi', '/readyz', '/version/', '/version']) if (!merged.has(`u|${u}`) && !merged.has('u|*')) rows.push(['', `[${u}]`, '[]', '[get]']);
      yield out(table(bool(a, 'no-headers') ? rows : [['Resources', 'Non-Resource URLs', 'Resource Names', 'Verbs'], ...rows]));
      return 0;
    }
    const verb = a.positional[1], target = a.positional[2];
    if (!verb || !target) throw new KubectlError('you must specify two arguments: verb resource or verb resource/resourceName.\nSee \'kubectl auth can-i -h\' for help and examples.');
    if (!KNOWN_VERBS.includes(verb)) yield err(`Warning: verb '${verb}' is not a known verb\n\n`);
    let allowed: boolean;
    if (target.startsWith('/')) allowed = ctx.user.groups.includes('system:masters') || rulesFor(ctx.engine, ctx.user, undefined).some((r) => (r.verbs.includes('*') || r.verbs.includes(verb)) && (r.nonResourceURLs ?? []).some((u) => u === '*' || u === target || (u.endsWith('*') && target.startsWith(u.slice(0, -1)))));
    else {
      const [typeAndSub, name] = target.split('/') as [string, string | undefined];
      const info = typeAndSub === '*' ? undefined : resolveResource(typeAndSub);
      if (typeAndSub !== '*' && !info) yield err(`Warning: the server doesn't have a resource type '${typeAndSub.split('.')[0]}'\n\n`);
      else if (info && !info.namespaced && !allNs) yield err(`Warning: resource '${info.plural}' is not namespace scoped${info.group ? ` in group '${info.group}'` : ''}\n\n`);
      allowed = authorize(ctx.engine, ctx.user, { verb, group: info?.group ?? (typeAndSub === '*' ? '*' : ''), resource: info?.plural ?? typeAndSub, subresource: str(a, 'subresource'), namespace: allNs || (info && !info.namespaced) ? undefined : ctx.namespace, name });
    }
    if (!bool(a, 'quiet')) yield out(allowed ? 'yes\n' : 'no\n');
    return allowed ? 0 : 1;
  },
};

// ---------------------------------------------------------------------------
// taint
// ---------------------------------------------------------------------------

export const taintCommand: KubectlCommand = {
  name: 'taint',
  summary: 'Update the taints on one or more nodes',
  usage: 'kubectl taint NODE NAME KEY_1=VAL_1:TAINT_EFFECT_1 ... KEY_N=VAL_N:TAINT_EFFECT_N [flags]',
  flags: [{ name: 'overwrite', type: 'bool' }, { name: 'all', type: 'bool' }, { name: 'selector', short: 'l', type: 'string' }, { name: 'dry-run', type: 'string', noOptDefault: 'client' }],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    const specs = a.positional.filter((p) => /[:=]/.test(p) || /-$/.test(p));
    const resArgs = a.positional.filter((p) => !specs.includes(p));
    if (!resArgs.length || !['node', 'nodes', 'no'].includes(resArgs[0] as string)) throw new KubectlError(resArgs.length ? `invalid resource type ${resArgs[0]}, only node(s) is supported` : 'one or more resources must be specified as <resource> <name> or <resource>/<name>');
    if (!specs.length) throw new KubectlError('at least one taint update is required');
    const names = resArgs.slice(1);
    if (!names.length && !bool(a, 'all') && !str(a, 'selector')) throw new KubectlError('one or more resources must be specified as <resource> <name> or <resource>/<name>');
    const refs = parseResourceArgs(names.length ? ['nodes', ...names] : ['nodes']);
    const nodes = refs.flatMap((r) => fetch(ctx.engine, r, ctx.namespace, true, str(a, 'selector'), undefined, access(ctx))) as Node[];
    const add: Taint[] = [], remove: { key: string; effect?: string }[] = [];
    for (const s of specs) {
      if (s.endsWith('-')) { const [key, effect] = s.slice(0, -1).split(':') as [string, string | undefined]; remove.push({ key: key.split('=')[0] as string, effect }); continue; }
      const m = /^([^=:]+)(?:=([^:]*))?:(.+)$/.exec(s);
      if (!m) throw new KubectlError(`invalid taint spec: ${s}`);
      if (!['NoSchedule', 'PreferNoSchedule', 'NoExecute'].includes(m[3] as string)) throw new KubectlError(`invalid taint effect: ${m[3]}, unsupported taint effect`);
      add.push({ key: m[1] as string, ...(m[2] ? { value: m[2] } : {}), effect: m[3] as Taint['effect'] });
    }
    for (const n of nodes) {
      let taints = [...(n.spec.taints ?? [])];
      let verb = 'tainted';
      for (const r of remove) {
        const before = taints.length;
        taints = taints.filter((t) => !(t.key === r.key && (!r.effect || t.effect === r.effect)));
        if (taints.length === before) throw new KubectlError(`taint "${r.key}${r.effect ? `:${r.effect}` : ''}" not found`);
        verb = 'untainted';
      }
      const clash = add.filter((t) => taints.some((x) => x.key === t.key && x.effect === t.effect));
      if (clash.length && !bool(a, 'overwrite')) throw new KubectlError(`node ${n.metadata.name} already has ${clash.map((t) => t.key).join(',')} taint(s) with same effect(s) and --overwrite is false`);
      for (const t of add) { taints = taints.filter((x) => !(x.key === t.key && x.effect === t.effect)); taints.push(t); }
      if (add.length) verb = clash.length ? 'modified' : remove.length ? 'modified' : 'tainted';
      const dry = str(a, 'dry-run');
      if (!(dry && dry !== 'none')) apiMutate(ctx, n, (d) => { if (taints.length) d.spec.taints = taints; else delete d.spec.taints; });
      yield out(`node/${n.metadata.name} ${verb}\n`);
    }
    return 0;
  },
};

// ---------------------------------------------------------------------------
// autoscale
// ---------------------------------------------------------------------------

export const autoscaleCommand: KubectlCommand = {
  name: 'autoscale',
  summary: 'Auto-scale a deployment, replica set, stateful set, or replication controller',
  usage: 'kubectl autoscale (-f FILENAME | TYPE NAME | TYPE/NAME) [--min=MINPODS] --max=MAXPODS [--cpu-percent=CPU] [flags]',
  flags: [{ name: 'min', type: 'int' }, { name: 'max', type: 'int' }, { name: 'cpu-percent', type: 'int' }, { name: 'name', type: 'string' }, { name: 'dry-run', type: 'string', noOptDefault: 'client' }, { name: 'output', short: 'o', type: 'string' }],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    const max = int(a, 'max'), min = int(a, 'min');
    if (max === undefined) throw new KubectlError('required flag(s) "max" not set');
    if (max < 1) throw new KubectlError(`--max=MAXPODS is required and must be at least 1, max: ${max}`);
    if (min !== undefined && max < min) throw new KubectlError(`--max=MAXPODS must be larger or equal to --min=MINPODS, max: ${max}, min: ${min}`);
    const refs = parseResourceArgs(a.positional);
    const ref = refs[0];
    if (refs.length !== 1 || ref === undefined || ref.name === undefined) throw new KubectlError('resource(s) were provided, but no name was specified');
    if (!['Deployment', 'ReplicaSet', 'StatefulSet'].includes(ref.info.kind)) throw new KubectlError(`cannot autoscale a ${ref.info.kind}`);
    const target = fetch(ctx.engine, ref, ctx.namespace, false, undefined, undefined, access(ctx))[0] as KubeObject;
    const cpu = int(a, 'cpu-percent');
    const hpa: KubeObject = {
      apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler',
      metadata: { creationTimestamp: null as unknown as string, name: str(a, 'name') ?? target.metadata.name, namespace: target.metadata.namespace },
      spec: { maxReplicas: max, ...(cpu !== undefined && cpu >= 0 ? { metrics: [{ resource: { name: 'cpu', target: { averageUtilization: cpu, type: 'Utilization' } }, type: 'Resource' }] } : {}), ...(min !== undefined ? { minReplicas: min } : {}), scaleTargetRef: { apiVersion: target.apiVersion, kind: target.kind, name: target.metadata.name } },
      status: { currentMetrics: null, desiredReplicas: 0 },
    } as KubeObject;
    const dry = str(a, 'dry-run');
    const fmt = parseOutputFlag(str(a, 'output'));
    if (dry && dry !== 'none') {
      yield out(fmt.kind === 'table' ? `${qualifiedName('HorizontalPodAutoscaler', hpa.metadata.name)} autoscaled (dry run)\n` : renderObjects(fmt, [hpa], true));
      return 0;
    }
    delete hpa.metadata.creationTimestamp;
    hpa.status = {};
    try { yield* warningChunks(apiCreate(ctx, admit(ctx.engine, { obj: hpa, source: 'kubectl autoscale' }, ctx.namespace, ctx.namespaceExplicit))); }
    catch (e) { if (e instanceof ApiError) throw new KubectlError(formatApiError(e)); if (e instanceof ValidationError) throw new KubectlError(`The ${e.message}`); throw e; }
    yield out(`${qualifiedName('HorizontalPodAutoscaler', hpa.metadata.name)} autoscaled\n`);
    return 0;
  },
};

// ---------------------------------------------------------------------------
// patch
// ---------------------------------------------------------------------------

export const patchCommand: KubectlCommand = {
  name: 'patch',
  summary: 'Update fields of a resource',
  usage: 'kubectl patch (-f FILENAME | TYPE NAME) [-p PATCH|--patch-file FILE] [--type strategic|merge|json] [flags]',
  flags: [{ name: 'patch', short: 'p', type: 'string' }, { name: 'patch-file', type: 'string' }, { name: 'type', type: 'string', def: 'strategic' }, { name: 'dry-run', type: 'string', noOptDefault: 'client' }, { name: 'output', short: 'o', type: 'string' }, { name: 'subresource', type: 'string' }],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    let text = str(a, 'patch');
    const file = str(a, 'patch-file');
    if (text === undefined && file === undefined) throw new KubectlError('must specify --patch or --patch-file containing the contents of the patch');
    if (file !== undefined) { text = ctx.vfs.read(file); if (text === undefined) throw new KubectlError(`unable to read patch file: open ${file}: no such file or directory`); }
    const type = str(a, 'type') ?? 'strategic';
    if (!['strategic', 'merge', 'json'].includes(type)) throw new KubectlError(`--type must be one of [json merge strategic], not "${type}"`);
    const refs = parseResourceArgs(a.positional);
    const ref = refs[0];
    if (refs.length !== 1 || ref === undefined || ref.name === undefined) throw new KubectlError('resource(s) were provided, but no name was specified');
    const live = fetch(ctx.engine, ref, ctx.namespace, false, undefined, undefined, access(ctx))[0] as KubeObject;
    let patch: unknown;
    try { patch = parseDocument(text as string); } catch (e) { if (e instanceof YamlError) throw new KubectlError(`unable to parse "${text}": ${e.message}`); throw e; }
    // custom resources have no strategic-merge schema: the API server refuses that media type
    if (type === 'strategic' && ctx.engine.crdResources.some((r) => r.kind === live.kind)) throw new KubectlError('Error from server (UnsupportedMediaType): the body of the request was in an unknown format - accepted media types include: application/json-patch+json, application/merge-patch+json, application/apply-patch+yaml');
    let next: KubeObject;
    try {
      next = (type === 'json' ? jsonPatch(live, patch as { op: string; path: string }[]) : type === 'merge' ? mergePatch(live, patch) : strategicMergePatch(live, patch)) as KubeObject;
    } catch (e) { if (e instanceof PatchError) throw new KubectlError(`The request is invalid: ${e.message}`); throw e; }
    next.metadata.uid = live.metadata.uid; next.metadata.creationTimestamp = live.metadata.creationTimestamp; next.metadata.resourceVersion = live.metadata.resourceVersion;
    const qn = qualifiedName(live.kind, live.metadata.name);
    if (JSON.stringify(sortKeys(next)) === JSON.stringify(sortKeys(live))) { yield out(`${qn} patched (no change)\n`); return 0; }
    try {
      if (next.kind !== live.kind || next.metadata.name !== live.metadata.name) throw new KubectlError('the name of the object (' + next.metadata.name + ') does not match the name on the URL (' + live.metadata.name + ')');
      validateObject(next, live);
      applyDefaults(next, ctx.engine);
      const dry = str(a, 'dry-run');
      const specChanged = JSON.stringify(sortKeys(next.spec ?? next.data ?? null)) !== JSON.stringify(sortKeys(live.spec ?? live.data ?? null));
      if (!(dry && dry !== 'none')) yield* warningChunks(apiReplace(ctx, next, live, { specChanged, subresource: str(a, 'subresource') }));
    } catch (e) {
      if (e instanceof ValidationError) throw new KubectlError(`The ${e.message}`);
      if (e instanceof ApiError) throw new KubectlError(formatApiError(e));
      throw e;
    }
    yield out(`${qn} patched\n`);
    return 0;
  },
};

// ---------------------------------------------------------------------------
// debug
// ---------------------------------------------------------------------------

export const debugCommand: KubectlCommand = {
  name: 'debug',
  summary: 'Create debugging sessions for troubleshooting workloads and nodes',
  usage: 'kubectl debug (POD | TYPE[[.VERSION].GROUP]/NAME) [ -- COMMAND [args...] ] [flags]',
  stopAtFirstPositional: false,
  flags: [{ name: 'image', type: 'string' }, { name: 'target', type: 'string' }, { name: 'container', short: 'c', type: 'string' }, { name: 'stdin', short: 'i', type: 'bool' }, { name: 'tty', short: 't', type: 'bool' }, { name: 'profile', type: 'string', def: 'legacy' }, { name: 'copy-to', type: 'string' }, { name: 'share-processes', type: 'bool' }, { name: 'attach', type: 'bool' }, { name: 'quiet', short: 'q', type: 'bool' }, { name: 'image-pull-policy', type: 'string' }, { name: 'env', type: 'strings' }],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    const name = a.positional[0];
    if (!name) throw new KubectlError('you must specify at least one pod or node name');
    if (a.positional.length > 1) throw new KubectlError(`exactly one NAME is required, got ${a.positional.length}`);
    if (/^nodes?\//.test(name)) throw new KubectlError('kubequest: `kubectl debug node/NAME` is not supported in the simulator yet');
    if (str(a, 'copy-to')) throw new KubectlError(str(a, 'target') ? '--target is incompatible with --copy-to. Use --share-processes instead.' : 'kubequest: `kubectl debug --copy-to` is not supported in the simulator yet');
    const image = str(a, 'image');
    if (!image) throw new KubectlError('you must specify image when creating new debug container');
    const ref = parseResourceArgs(name.includes('/') ? [name] : ['pod', name])[0];
    if (ref === undefined || ref.info.kind !== 'Pod') throw new KubectlError(`kubequest: \`kubectl debug\` supports pods only in the simulator`);
    const pod = fetch(ctx.engine, ref, ctx.namespace, false, undefined, undefined, access(ctx))[0] as Pod;
    const target = str(a, 'target');
    if (target && !pod.spec.containers.some((c) => c.name === target)) throw new KubectlError(`Error from server (BadRequest): container ${target} not found in pod ${pod.metadata.name}`);
    const interactive = bool(a, 'stdin') && bool(a, 'tty');
    const profile = str(a, 'profile') ?? 'legacy';
    if (target) yield out(`Targeting container "${target}". If you don't see processes from this container it may be because the container runtime doesn't support this feature.\n`);
    if (profile === 'legacy') yield err('--profile=legacy is deprecated and will be removed in the future. It is recommended to explicitly specify a profile, for example "--profile=general".\n');
    const cname = str(a, 'container') ?? `debugger-${ctx.engine.rng.suffix()}`;
    if (!str(a, 'container')) yield err(`Defaulting debug container name to ${cname}.\n`);
    if ((pod.spec.ephemeralContainers ?? []).some((c) => c.name === cname) || pod.spec.containers.some((c) => c.name === cname)) throw new KubectlError(`Error from server (Invalid): Pod "${pod.metadata.name}" is invalid: spec.ephemeralContainers[0].name: Duplicate value: "${cname}"`);
    const container: Container = { image, name: cname, resources: {}, terminationMessagePolicy: 'File', ...(a.rest.length ? { command: a.rest } : {}), ...(bool(a, 'stdin') ? { stdin: true } : {}), ...(bool(a, 'tty') ? { tty: true } : {}), ...(target ? { targetContainerName: target } : {}) };
    try { apiMutate(ctx, pod, (d) => { d.spec.ephemeralContainers = [...(d.spec.ephemeralContainers ?? []), container]; }, { subresource: 'ephemeralcontainers' }); }
    catch (e) { if (e instanceof ApiError) throw new KubectlError(formatApiError(e)); throw e; }
    if (!interactive) return 0;
    const deadline = ctx.engine.clock.nowMs + 60_000;
    const state = (): string | undefined => { const p = ctx.engine.store.getByUid<Pod>(pod.metadata.uid as string); const st = p?.status.ephemeralContainerStatuses?.find((c) => c.name === cname)?.state; return st?.running ? 'running' : st?.terminated ? 'terminated' : st?.waiting?.reason; };
    while (state() !== 'running' && state() !== 'terminated' && ctx.engine.clock.nowMs < deadline && !ctx.host.aborted()) await ctx.host.sleep(300);
    if (state() !== 'running') { yield err(`error: timed out waiting for the condition${state() ? ` (container ${cname}: ${state()})` : ''}\n`); return 1; }
    yield err("If you don't see a command prompt, try pressing enter.\n");
    const live = ctx.engine.store.getByUid<Pod>(pod.metadata.uid as string) as Pod;
    const code = yield* interactiveShell(ctx.engine, ctx.host, live, cname, a.rest.length ? a.rest : ['sh']);
    yield err(`Session ended, the ephemeral container will not be restarted but may be reattached using 'kubectl attach ${pod.metadata.name} -c ${cname} -i -t' if it is still running\n`);
    return code;
  },
};

// ---------------------------------------------------------------------------
// kustomize
// ---------------------------------------------------------------------------

export const kustomizeCommand: KubectlCommand = {
  name: 'kustomize',
  summary: 'Build a kustomization target from a directory or URL',
  usage: 'kubectl kustomize DIR [flags]',
  flags: [{ name: 'output', short: 'o', type: 'string' }, { name: 'enable-helm', type: 'bool' }],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const dir = ctx.args.positional[0] ?? '.';
    try {
      const r = kustomizeBuild(ctx.vfs, dir);
      for (const w of r.warnings) yield err(w + '\n');
      const file = str(ctx.args, 'output');
      if (file) ctx.vfs.write(file, r.yaml); else yield out(r.yaml);
      return 0;
    } catch (e) { if (e instanceof KustomizeError) throw new KubectlError(e.message); throw e; }
  },
};

void strs; void resourceByKind;
