/**
 * GitOps: the Argo CD application controller, reduced to what a kubectl user sees — an `Application` whose
 * `status.sync` / `status.health` follow a Git repository, automated sync with prune and self-heal.
 * It only acts while the application-controller pod is running and its CRD is installed.
 */
import type { Engine } from '../engine.ts';
import type { KubeObject, Deployment, StatefulSet, DaemonSet, Pod } from '../types.ts';
import { ApiError } from '../store.ts';
import { isPodReady } from './kubelet.ts';
import { gitRemote, type Tree } from '../git.ts';
import { Vfs } from '../vfs.ts';
import { kustomizeBuild, KustomizeError } from '../kustomize.ts';
import { parseAllDocuments, sortKeys } from '../yaml.ts';
import { resourceByKind } from '../registry.ts';
import { applyDefaults } from '../defaults.ts';
import { admit } from '../admission.ts';

const SELF_HEAL_MS = 5_000;
export const TRACKING = 'argocd.argoproj.io/tracking-id';
const REFRESH = 'argocd.argoproj.io/refresh';

interface AppSpec {
  project?: string;
  source?: { repoURL?: string; path?: string; targetRevision?: string };
  destination?: { server?: string; namespace?: string };
  syncPolicy?: { automated?: { prune?: boolean; selfHeal?: boolean }; syncOptions?: string[] };
}
interface AppState { fetchedAt: number; revision?: string; tree?: Tree; syncedRevision?: string; lastAttempt?: number; failedRevision?: string }

function controllerRunning(engine: Engine): boolean {
  for (const p of engine.store.list<Pod>('Pod')) {
    if (p.metadata.deletionTimestamp || !isPodReady(p)) continue;
    if (engine.podRuntime(p).containers.some((c) => c.behaviour?.controller === 'argocd')) return true;
  }
  return false;
}

/** Render the manifests at `path` of a commit: a kustomization if there is one, plain YAML files otherwise. */
function render(tree: Tree, path: string): KubeObject[] {
  const base = `/repo/${path.replace(/^\.?\/?/, '').replace(/\/$/, '')}`.replace(/\/$/, '');
  const vfs = new Vfs(Object.fromEntries(Object.entries(tree).map(([k, v]) => [`/repo/${k}`, v])));
  if (['kustomization.yaml', 'kustomization.yml', 'Kustomization'].some((f) => vfs.read(`${base}/${f}`) !== undefined)) return kustomizeBuild(vfs, base).objects;
  const out: KubeObject[] = [];
  const entries = vfs.list(base).filter((e) => /\.ya?ml$/.test(e));
  if (!entries.length) throw new KustomizeError(`${path}: app path does not exist`);
  for (const e of entries) for (const d of parseAllDocuments(vfs.read(`${base}/${e}`) as string)) if (d && typeof d === 'object' && (d as KubeObject).kind) out.push(d as KubeObject);
  return out;
}

/** Does the live object carry everything the desired manifest asks for? (fields set by others are not drift) */
function inSync(desired: unknown, live: unknown): boolean {
  if (Array.isArray(desired)) return Array.isArray(live) && live.length === desired.length && desired.every((d, i) => inSync(d, live[i]));
  if (desired && typeof desired === 'object') {
    if (!live || typeof live !== 'object' || Array.isArray(live)) return Object.keys(desired).length === 0;
    return Object.entries(desired as Record<string, unknown>).every(([k, v]) => v === null || inSync(v, (live as Record<string, unknown>)[k]));
  }
  return desired === live || String(desired) === String(live);
}

function overlay(live: unknown, desired: unknown): unknown {
  if (desired && typeof desired === 'object' && !Array.isArray(desired) && live && typeof live === 'object' && !Array.isArray(live)) {
    const out: Record<string, unknown> = { ...(live as Record<string, unknown>) };
    for (const [k, v] of Object.entries(desired as Record<string, unknown>)) out[k] = overlay(out[k], v);
    return out;
  }
  // lists of the same length are merged item by item (the way the diff above compares them), so fields that only the
  // live object has — defaulted ones, a port name — survive a sync, as they do with Argo CD's three-way apply
  if (Array.isArray(desired) && Array.isArray(live) && live.length === desired.length) return desired.map((d, i) => overlay(live[i], d));
  return structuredClone(desired);
}

function health(engine: Engine, o: KubeObject | undefined): 'Healthy' | 'Progressing' | 'Degraded' | 'Missing' {
  if (!o) return 'Missing';
  if (o.kind === 'Deployment') {
    const d = o as Deployment;
    if (d.status.conditions?.some((c) => c.type === 'Progressing' && c.reason === 'ProgressDeadlineExceeded')) return 'Degraded';
    const want = d.spec.replicas ?? 1;
    return (d.metadata.generation ?? 0) <= (d.status.observedGeneration ?? 0) && (d.status.updatedReplicas ?? 0) >= want && (d.status.availableReplicas ?? 0) >= want && (d.status.replicas ?? 0) <= want ? 'Healthy' : 'Progressing';
  }
  if (o.kind === 'StatefulSet') { const s = o as StatefulSet; return (s.status.readyReplicas ?? 0) >= (s.spec.replicas ?? 1) && (s.status.updatedReplicas ?? 0) >= (s.spec.replicas ?? 1) ? 'Healthy' : 'Progressing'; }
  if (o.kind === 'DaemonSet') { const d = o as DaemonSet; return (d.status.numberAvailable ?? 0) >= d.status.desiredNumberScheduled ? 'Healthy' : 'Progressing'; }
  if (o.kind === 'Pod') { const p = o as Pod; return isPodReady(p) || p.status.phase === 'Succeeded' ? 'Healthy' : p.status.phase === 'Failed' ? 'Degraded' : 'Progressing'; }
  void engine;
  return 'Healthy';
}

export function runGitOpsController(engine: Engine): void {
  const apps = engine.store.list('Application');
  if (!apps.length || !controllerRunning(engine)) return;
  const now = engine.clock.nowMs;
  for (const app of apps) {
    const spec = (app.spec ?? {}) as AppSpec;
    const key = `argocd:${app.metadata.uid}`;
    const st = (engine.scratch.get(key) as AppState | undefined) ?? { fetchedAt: -Infinity };
    engine.scratch.set(key, st);
    const ev = (reason: string, message: string, type: 'Normal' | 'Warning' = 'Normal') => engine.store.event({ type, reason, message, involved: app, component: 'argocd-application-controller' });
    const prev = (app.status ?? {}) as { sync?: { status?: string; revision?: string }; health?: { status?: string }; operationState?: unknown; history?: unknown[]; conditions?: unknown[]; reconciledAt?: string };
    const status: Record<string, unknown> = { ...prev };
    const write = (): void => {
      const sync = status.sync as { status?: string } | undefined, h = status.health as { status?: string } | undefined;
      if (sync?.status !== prev.sync?.status && prev.sync?.status) ev('ResourceUpdated', `Updated sync status: ${prev.sync.status} -> ${sync?.status}`);
      if (h?.status !== prev.health?.status && prev.health?.status) ev('ResourceUpdated', `Updated health status: ${prev.health.status} -> ${h?.status}`);
      if (JSON.stringify(sortKeys(status)) !== JSON.stringify(sortKeys(app.status ?? {}))) { app.status = status; engine.store.update(app); }
    };
    // 1. fetch: poll the repository (or refresh right away when asked through the annotation)
    const refresh = app.metadata.annotations?.[REFRESH] !== undefined;
    if (refresh || now - st.fetchedAt >= engine.gitPollSeconds * 1000) {
      st.fetchedAt = now;
      const remote = gitRemote(engine, spec.source?.repoURL ?? '');
      if (refresh) { const a = { ...(app.metadata.annotations ?? {}) }; delete a[REFRESH]; if (Object.keys(a).length) app.metadata.annotations = a; else delete app.metadata.annotations; engine.store.update(app); }
      if (!remote) {
        // an unreachable repository is retried soon, not a full poll interval later
        st.fetchedAt = now - engine.gitPollSeconds * 1000 + 1000;
        status.sync = { status: 'Unknown' }; status.health = { status: 'Unknown' };
        const message = `Failed to load target state: failed to generate manifest for source 1 of 1: rpc error: code = Unknown desc = failed to list refs: repository not found: ${spec.source?.repoURL ?? ''}`;
        const before = (prev.conditions as { type: string; message: string; lastTransitionTime?: string }[] | undefined)?.find((x) => x.type === 'ComparisonError' && x.message === message);
        status.conditions = [{ type: 'ComparisonError', message, lastTransitionTime: before?.lastTransitionTime ?? engine.clock.iso() }];
        write();
        continue;
      }
      const tip = remote.commits[remote.commits.length - 1];
      if (tip) { st.revision = tip.sha; st.tree = tip.tree; }
    }
    if (!st.tree || !st.revision) continue;
    // 2. compare desired (Git) with live (cluster)
    const destNs = spec.destination?.namespace ?? 'default';
    let desired: KubeObject[];
    try { desired = render(st.tree, spec.source?.path ?? '.'); }
    catch (e) {
      if (!(e instanceof KustomizeError) && !(e instanceof Error)) throw e;
      status.sync = { status: 'Unknown', revision: st.revision };
      status.conditions = [{ type: 'ComparisonError', message: `Failed to load target state: failed to generate manifest for source 1 of 1: rpc error: code = Unknown desc = ${(e as Error).message}`, lastTransitionTime: engine.clock.iso() }];
      write();
      continue;
    }
    const idOf = (o: KubeObject): string => `${app.metadata.name}:${o.apiVersion.includes('/') ? o.apiVersion.split('/')[0] : ''}/${o.kind}:${o.metadata.namespace ?? ''}/${o.metadata.name}`;
    const items = desired.map((d) => {
      const o = structuredClone(d);
      const info = resourceByKind(o.kind);
      if (!info || info.namespaced) o.metadata.namespace = o.metadata.namespace ?? destNs; else delete o.metadata.namespace;
      o.metadata.annotations = { ...(o.metadata.annotations ?? {}), [TRACKING]: idOf(o) };
      const live = engine.store.get(o.kind, o.metadata.namespace, o.metadata.name);
      const body: Record<string, unknown> = { ...o }; delete body.status; delete body.apiVersion; delete body.kind;
      return { want: o, live, synced: !!live && inSync(body, live) };
    });
    const wantedIds = new Set(items.map((i) => i.want.metadata.annotations?.[TRACKING]));
    const orphans = engine.store.all().filter((o) => o.metadata.annotations?.[TRACKING]?.startsWith(`${app.metadata.name}:`) && !wantedIds.has(o.metadata.annotations[TRACKING]) && !o.metadata.deletionTimestamp);
    const prune = !!spec.syncPolicy?.automated?.prune;
    const outOfSync = items.some((i) => !i.synced) || orphans.length > 0;
    // 3. automated sync: a new revision is always synced; live drift only with selfHeal
    const auto = spec.syncPolicy?.automated;
    const newRevision = st.syncedRevision !== st.revision && st.failedRevision !== st.revision;
    const heal = !!auto?.selfHeal && st.syncedRevision === st.revision && now - (st.lastAttempt ?? -Infinity) >= SELF_HEAL_MS;
    if (auto && outOfSync && (newRevision || heal)) {
      st.lastAttempt = now;
      const startedAt = engine.clock.iso();
      ev('OperationStarted', `Initiated automated sync to '${st.revision}'`);
      let failure: string | undefined;
      try {
        if (!engine.store.get('Namespace', undefined, destNs)) {
          if ((spec.syncPolicy?.syncOptions ?? []).includes('CreateNamespace=true')) engine.ensureNamespace(destNs);
          else throw new ApiError('NotFound', `namespaces "${destNs}" not found`);
        }
        for (const i of items) {
          if (i.synced) continue;
          if (!i.live) { const o = applyDefaults(structuredClone(i.want), engine); admit(engine, o, 'CREATE'); engine.store.create(o); continue; }
          const merged = overlay(i.live, { ...i.want, status: undefined, apiVersion: undefined, kind: undefined }) as KubeObject;
          merged.apiVersion = i.live.apiVersion; merged.kind = i.live.kind; merged.status = i.live.status;
          if (merged.status === undefined) delete merged.status;
          applyDefaults(merged, engine);
          admit(engine, merged, 'UPDATE', { old: i.live });
          engine.store.update(merged, { specChanged: JSON.stringify(sortKeys(merged.spec ?? null)) !== JSON.stringify(sortKeys(i.live.spec ?? null)) });
        }
        if (prune) for (const o of orphans) { if (o.kind === 'Pod') engine.store.markDeleting(o, (o as Pod).spec.terminationGracePeriodSeconds ?? 30); else engine.store.remove(o); }
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        failure = e.message;
      }
      if (failure) {
        st.failedRevision = st.revision;
        status.operationState = { phase: 'Failed', message: `one or more objects failed to apply, reason: ${failure}`, startedAt, finishedAt: engine.clock.iso(), syncResult: { revision: st.revision } };
        status.conditions = [{ type: 'SyncError', message: `Failed sync attempt to ${st.revision}: one or more objects failed to apply, reason: ${failure}`, lastTransitionTime: engine.clock.iso() }];
        ev('OperationCompleted', `Sync operation to ${st.revision} failed: one or more objects failed to apply, reason: ${failure}`, 'Warning');
      } else {
        st.syncedRevision = st.revision;
        status.operationState = { phase: 'Succeeded', message: 'successfully synced (all tasks run)', startedAt, finishedAt: engine.clock.iso(), syncResult: { revision: st.revision } };
        status.conditions = undefined; delete status.conditions;
        status.history = [...((prev.history as unknown[] | undefined) ?? []), { id: ((prev.history as unknown[] | undefined) ?? []).length, revision: st.revision, deployedAt: engine.clock.iso() }].slice(-10);
        ev('OperationCompleted', `Sync operation to ${st.revision} succeeded`);
      }
      // status is recomputed on the next pass with the live objects as they now are
      status.reconciledAt = engine.clock.iso();
      write();
      continue;
    }
    if (!outOfSync && st.syncedRevision === undefined) st.syncedRevision = st.revision;
    const healths = items.map((i) => health(engine, engine.store.get(i.want.kind, i.want.metadata.namespace, i.want.metadata.name)));
    const worst = healths.includes('Missing') ? 'Missing' : healths.includes('Degraded') ? 'Degraded' : healths.includes('Progressing') ? 'Progressing' : 'Healthy';
    status.sync = { status: outOfSync ? 'OutOfSync' : 'Synced', revision: st.revision };
    status.health = { status: worst };
    status.sourceType = Object.keys(st.tree).some((k) => /(^|\/)kustomization\.ya?ml$/.test(k) && k.startsWith((spec.source?.path ?? '').replace(/\/$/, ''))) ? 'Kustomize' : 'Directory';
    write();
  }
}
