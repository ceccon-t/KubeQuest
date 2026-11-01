import type { KubectlCommand, CommandContext, OutputChunk } from '../context.ts';
import { out, err } from '../context.ts';
import { str, bool, strs, int, KubectlError } from '../args.ts';
import { parseResourceArgs, fetch } from '../resources.ts';
import { qualifiedName } from '../../registry.ts';
import type { KubeObject, Deployment, ReplicaSet, DaemonSet, Container, ConfigMap, Pod, Job } from '../../types.ts';
import { replicaSetsOf, revisionOf, rollbackTo, CHANGE_CAUSE_ANNOTATION, findNewReplicaSet } from '../../controllers/deployment.ts';
import { tabwrite } from '../tabwriter.ts';
import { parseGoDuration } from '../../duration.ts';
import { describePodTemplateOnly } from './templ.ts';

function deploymentArg(ctx: CommandContext, args: string[]): Deployment {
  const refs = parseResourceArgs(args);
  if (refs.length !== 1 || refs[0]!.name === undefined) throw new KubectlError('required resource not specified');
  const ref = refs[0]!;
  if (ref.info.kind !== 'Deployment') {
    if (['DaemonSet', 'StatefulSet'].includes(ref.info.kind)) throw new KubectlError(`kubequest: rollout for ${ref.info.plural} is not supported in the simulator yet`);
    throw new KubectlError(`${ref.info.plural} "${ref.name}" is not a valid rollout target (no rollout strategy)`);
  }
  return fetch(ctx.engine, ref, ctx.namespace, false)[0] as Deployment;
}

/** upstream: pkg/polymorphichelpers/rollout_status.go DeploymentStatusViewer */
export function deploymentRolloutStatus(d: Deployment, revision?: number): { msg: string; done: boolean } {
  if (revision !== undefined) {
    // handled by caller (needs RS lookup)
  }
  if ((d.metadata.generation ?? 0) <= (d.status.observedGeneration ?? 0)) {
    const cond = d.status.conditions?.find((c) => c.type === 'Progressing');
    if (cond && cond.reason === 'ProgressDeadlineExceeded') throw new KubectlError(`deployment "${d.metadata.name}" exceeded its progress deadline`);
    const replicas = d.spec.replicas ?? 1;
    const updated = d.status.updatedReplicas ?? 0;
    const total = d.status.replicas ?? 0;
    const available = d.status.availableReplicas ?? 0;
    if (updated < replicas) return { msg: `Waiting for deployment "${d.metadata.name}" rollout to finish: ${updated} out of ${replicas} new replicas have been updated...\n`, done: false };
    if (total > updated) return { msg: `Waiting for deployment "${d.metadata.name}" rollout to finish: ${total - updated} old replicas are pending termination...\n`, done: false };
    if (available < updated) return { msg: `Waiting for deployment "${d.metadata.name}" rollout to finish: ${available} of ${updated} updated replicas are available...\n`, done: false };
    return { msg: `deployment "${d.metadata.name}" successfully rolled out\n`, done: true };
  }
  return { msg: 'Waiting for deployment spec update to be observed...\n', done: false };
}

export const rolloutCommand: KubectlCommand = {
  name: 'rollout',
  summary: 'Manage the rollout of a resource',
  usage: 'kubectl rollout SUBCOMMAND (history|pause|restart|resume|status|undo) [flags]',
  flags: [
    { name: 'revision', type: 'int' },
    { name: 'to-revision', type: 'int' },
    { name: 'timeout', type: 'string' },
    { name: 'watch', short: 'w', type: 'bool', def: true },
    { name: 'filename', short: 'f', type: 'strings' },
    { name: 'selector', short: 'l', type: 'string' },
    { name: 'dry-run', type: 'string', noOptDefault: 'client' },
    { name: 'output', short: 'o', type: 'string' },
  ],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    const sub = a.positional[0];
    const rest = a.positional.slice(1);
    if (!sub) throw new KubectlError('You must specify a subcommand: history, pause, restart, resume, status, undo');
    switch (sub) {
      case 'status': {
        const d0 = deploymentArg(ctx, rest);
        const timeout = str(a, 'timeout') ? (parseGoDuration(str(a, 'timeout')!) ?? undefined) : undefined;
        const start = ctx.engine.clock.nowMs;
        let last = '';
        const rev = int(a, 'revision');
        while (true) {
          const d = ctx.engine.store.get<Deployment>('Deployment', d0.metadata.namespace, d0.metadata.name);
          if (!d) throw new KubectlError(`Error from server (NotFound): deployments.apps "${d0.metadata.name}" not found`);
          if (rev !== undefined) {
            const rs = replicaSetsOf(ctx.engine, d).find((r) => revisionOf(r) === rev);
            if (!rs) throw new KubectlError(`unable to find specified revision ${rev} in history`);
            const newRs = findNewReplicaSet(ctx.engine, d);
            if (!newRs || newRs.metadata.uid !== rs.metadata.uid) throw new KubectlError(`desired revision (${rev}) is different from the running revision (${newRs ? revisionOf(newRs) : 0})`);
          }
          const { msg, done } = deploymentRolloutStatus(d);
          if (msg !== last) { yield out(msg); last = msg; }
          if (done || !bool(a, 'watch')) return 0;
          if (timeout !== undefined && timeout > 0 && ctx.engine.clock.nowMs - start >= timeout) { yield err('error: timed out waiting for the condition\n'); return 1; }
          if (ctx.host.aborted()) return 130;
          await ctx.host.sleep(250);
        }
      }
      case 'history': {
        const d = deploymentArg(ctx, rest);
        const rss = replicaSetsOf(ctx.engine, d).sort((x, y) => revisionOf(x) - revisionOf(y));
        const rev = int(a, 'revision');
        if (rev !== undefined) {
          const rs = rss.find((r) => revisionOf(r) === rev);
          if (!rs) throw new KubectlError(`unable to find the specified revision`);
          yield out(`${qualifiedName('Deployment', d.metadata.name)} with revision #${rev}\n`);
          yield out(describePodTemplateOnly(rs.spec.template));
          return 0;
        }
        if (!rss.length) throw new KubectlError(`No rollout history found.`);
        let text = 'REVISION\tCHANGE-CAUSE\n';
        for (const rs of rss) text += `${revisionOf(rs)}\t${rs.metadata.annotations?.[CHANGE_CAUSE_ANNOTATION] ?? '<none>'}\n`;
        yield out(`${qualifiedName('Deployment', d.metadata.name)} \n` + tabwrite(text, { minwidth: 0, tabwidth: 8, padding: 2 }));
        return 0;
      }
      case 'undo': {
        const d = deploymentArg(ctx, rest);
        const rss = replicaSetsOf(ctx.engine, d).sort((x, y) => revisionOf(x) - revisionOf(y));
        const to = int(a, 'to-revision') ?? 0;
        const current = findNewReplicaSet(ctx.engine, d);
        let target: ReplicaSet | undefined;
        if (to === 0) {
          const candidates = rss.filter((r) => r !== current);
          target = candidates[candidates.length - 1];
          if (!target) throw new KubectlError(`no rollout history found for deployment "${d.metadata.name}"`);
        } else {
          target = rss.find((r) => revisionOf(r) === to);
          if (!target) throw new KubectlError(`unable to find specified revision ${to} in history`);
          if (current && target.metadata.uid === current.metadata.uid) { yield out(`${qualifiedName('Deployment', d.metadata.name)} skipped rollback (current template already matches revision ${to})\n`); return 0; }
        }
        const dry = str(a, 'dry-run');
        if (!(dry && dry !== 'none')) rollbackTo(ctx.engine, d, target);
        yield out(`${qualifiedName('Deployment', d.metadata.name)} rolled back${dry && dry !== 'none' ? ' (dry run)' : ''}\n`);
        return 0;
      }
      case 'restart': {
        const d = deploymentArg(ctx, rest);
        d.spec.template.metadata.annotations = { ...(d.spec.template.metadata.annotations ?? {}), 'kubectl.kubernetes.io/restartedAt': ctx.engine.clock.iso().replace('Z', '+00:00') };
        ctx.engine.store.update(d, { specChanged: true });
        yield out(`${qualifiedName('Deployment', d.metadata.name)} restarted\n`);
        return 0;
      }
      case 'pause': {
        const d = deploymentArg(ctx, rest);
        if (d.spec.paused) throw new KubectlError('is already paused');
        d.spec.paused = true;
        ctx.engine.store.update(d, { specChanged: true });
        yield out(`${qualifiedName('Deployment', d.metadata.name)} paused\n`);
        return 0;
      }
      case 'resume': {
        const d = deploymentArg(ctx, rest);
        if (!d.spec.paused) throw new KubectlError('is not paused');
        d.spec.paused = false;
        ctx.engine.store.update(d, { specChanged: true });
        yield out(`${qualifiedName('Deployment', d.metadata.name)} resumed\n`);
        return 0;
      }
      default:
        throw new KubectlError(`unknown command "${sub}" for "kubectl rollout"`);
    }
  },
};

// ---------------------------------------------------------------------------
// set image / env / resources
// ---------------------------------------------------------------------------

function templateOf(o: KubeObject): { containers: Container[]; initContainers?: Container[] } {
  switch (o.kind) {
    case 'Pod': return (o as Pod).spec;
    case 'Deployment': return (o as Deployment).spec.template.spec;
    case 'ReplicaSet': return (o as ReplicaSet).spec.template.spec;
    case 'DaemonSet': return (o as DaemonSet).spec.template.spec;
    case 'Job': return (o as Job).spec.template.spec;
    default: throw new KubectlError(`the object ${o.kind.toLowerCase()}s/${o.metadata.name} does not have a pod template`);
  }
}

function setTargets(ctx: CommandContext, args: string[], all: boolean, selector: string | undefined): KubeObject[] {
  if (!args.length) throw new KubectlError('one or more resources must be specified as <resource> <name> or <resource>/<name>');
  const refs = parseResourceArgs(args, { allowAll: true });
  const objs: KubeObject[] = [];
  for (const r of refs) {
    if (r.name === undefined && !all && !selector) throw new KubectlError('resource(s) were provided, but no name was specified');
    objs.push(...fetch(ctx.engine, r, ctx.namespace, false, selector));
  }
  return objs;
}

export const setCommand: KubectlCommand = {
  name: 'set',
  summary: 'Set specific features on objects',
  usage: 'kubectl set SUBCOMMAND (image|env|resources) [flags]',
  flags: [
    { name: 'all', type: 'bool' },
    { name: 'selector', short: 'l', type: 'string' },
    { name: 'containers', short: 'c', type: 'string', def: '*' },
    { name: 'env', short: 'e', type: 'strings' },
    { name: 'from', type: 'string' },
    { name: 'list', type: 'bool' },
    { name: 'resolve', type: 'bool' },
    { name: 'limits', type: 'string' },
    { name: 'requests', type: 'string' },
    { name: 'dry-run', type: 'string', noOptDefault: 'client' },
    { name: 'output', short: 'o', type: 'string' },
    { name: 'filename', short: 'f', type: 'strings' },
    { name: 'local', type: 'bool' },
    { name: 'record', type: 'bool' },
    { name: 'keys', type: 'strings' },
    { name: 'overwrite', type: 'bool', def: true },
  ],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    const sub = a.positional[0];
    if (!sub) throw new KubectlError('You must specify a subcommand: env, image, resources, selector, serviceaccount, subject');
    const dry = str(a, 'dry-run');
    const isDry = !!dry && dry !== 'none';
    const record = bool(a, 'record');
    const finish = (o: KubeObject, what: string): OutputChunk => {
      if (!isDry) {
        if (record) o.metadata.annotations = { ...(o.metadata.annotations ?? {}), [CHANGE_CAUSE_ANNOTATION]: ctx.cmdline };
        ctx.engine.store.update(o, { specChanged: true });
      }
      return out(`${qualifiedName(o.kind, o.metadata.name)} ${what}${isDry ? ' (dry run)' : ''}\n`);
    };
    switch (sub) {
      case 'image': {
        const resArgs: string[] = [], pairs: string[] = [];
        for (const p of a.positional.slice(1)) (p.includes('=') ? pairs : resArgs).push(p);
        if (!pairs.length) throw new KubectlError('at least one image update is required');
        const objs = setTargets(ctx, resArgs, bool(a, 'all'), str(a, 'selector'));
        const updates = pairs.map((p) => { const i = p.indexOf('='); return { name: p.slice(0, i), image: p.slice(i + 1) }; });
        for (const o of objs) {
          const tpl = templateOf(o);
          const all = [...tpl.containers, ...(tpl.initContainers ?? [])];
          for (const u of updates) {
            const matched = all.filter((c) => u.name === '*' || c.name === u.name);
            if (!matched.length) throw new KubectlError(`unable to find container named "${u.name}"`);
            for (const c of matched) c.image = u.image;
          }
          yield finish(o, 'image updated');
        }
        return 0;
      }
      case 'env': {
        const resArgs: string[] = [], pairs: string[] = [];
        for (const p of a.positional.slice(1)) ((p.includes('=') || /[^=]-$/.test(p)) && resArgs.length ? pairs : resArgs).push(p);
        pairs.push(...strs(a, 'env'));
        const from = str(a, 'from');
        if (!pairs.length && !from && !bool(a, 'list')) throw new KubectlError('at least one environment variable must be provided');
        const objs = setTargets(ctx, resArgs, bool(a, 'all'), str(a, 'selector'));
        const cSel = str(a, 'containers') ?? '*';
        for (const o of objs) {
          const tpl = templateOf(o);
          const targets = tpl.containers.filter((c) => cSel === '*' || c.name === cSel || (cSel.endsWith('*') && c.name.startsWith(cSel.slice(0, -1))));
          if (!targets.length) throw new KubectlError(`unable to find container named "${cSel}"`);
          if (bool(a, 'list')) {
            for (const c of targets) {
              yield out(`# ${o.kind} ${o.metadata.name}, container ${c.name}\n`);
              for (const e of c.env ?? []) yield out(e.value !== undefined ? `${e.name}=${e.value}\n` : `# ${e.name} from ${e.valueFrom?.configMapKeyRef ? `configmap ${e.valueFrom.configMapKeyRef.name}, key ${e.valueFrom.configMapKeyRef.key}` : e.valueFrom?.secretKeyRef ? `secret ${e.valueFrom.secretKeyRef.name}, key ${e.valueFrom.secretKeyRef.key}` : 'field'}\n`);
            }
            continue;
          }
          for (const c of targets) {
            const env = [...(c.env ?? [])];
            for (const p of pairs) {
              if (/[^=]-$/.test(p) && !p.includes('=')) { const k = p.slice(0, -1); const idx = env.findIndex((e) => e.name === k); if (idx >= 0) env.splice(idx, 1); continue; }
              const i = p.indexOf('=');
              const k = p.slice(0, i), v = p.slice(i + 1);
              const idx = env.findIndex((e) => e.name === k);
              if (idx >= 0) { if (!bool(a, 'overwrite')) throw new KubectlError(`'${k}' already has a value (${env[idx]!.value}), and --overwrite is false`); env[idx] = { name: k, value: v }; }
              else env.push({ name: k, value: v });
            }
            if (from) {
              const m = /^(configmap|secret)\/(.+)$/.exec(from);
              if (!m) throw new KubectlError(`unsupported resource specified in --from`);
              const kind = m[1] === 'configmap' ? 'ConfigMap' : 'Secret';
              const src = ctx.engine.store.get<ConfigMap>(kind, ctx.namespace, m[2] as string);
              if (!src) throw new KubectlError(`Error from server (NotFound): ${m[1]}s "${m[2]}" not found`);
              const keys = strs(a, 'keys');
              for (const k of Object.keys(src.data ?? {})) {
                if (keys.length && !keys.includes(k)) continue;
                const ref = kind === 'ConfigMap' ? { configMapKeyRef: { name: src.metadata.name, key: k } } : { secretKeyRef: { name: src.metadata.name, key: k } };
                const idx = env.findIndex((e) => e.name === k);
                if (idx >= 0) env[idx] = { name: k, valueFrom: ref }; else env.push({ name: k, valueFrom: ref });
              }
            }
            if (env.length) c.env = env; else delete c.env;
          }
          yield finish(o, 'env updated');
        }
        return 0;
      }
      case 'resources': {
        const objs = setTargets(ctx, a.positional.slice(1), bool(a, 'all'), str(a, 'selector'));
        const lim = str(a, 'limits'), req = str(a, 'requests');
        if (!lim && !req) throw new KubectlError('you must specify an update to requests or limits (in the form of --requests/--limits)');
        const parse = (s: string | undefined) => (s ? Object.fromEntries(s.split(',').map((kv) => { const i = kv.indexOf('='); if (i <= 0) throw new KubectlError(`invalid resource "${kv}": must be key=value`); return [kv.slice(0, i), kv.slice(i + 1)]; })) : undefined);
        const cSel = str(a, 'containers') ?? '*';
        for (const o of objs) {
          const tpl = templateOf(o);
          const targets = tpl.containers.filter((c) => cSel === '*' || c.name === cSel);
          if (!targets.length) throw new KubectlError(`unable to find container named "${cSel}"`);
          for (const c of targets) {
            c.resources = c.resources ?? {};
            const l = parse(lim), r = parse(req);
            if (l) c.resources.limits = { ...(c.resources.limits ?? {}), ...l };
            if (r) c.resources.requests = { ...(c.resources.requests ?? {}), ...r };
          }
          yield finish(o, 'resource requirements updated');
        }
        return 0;
      }
      default:
        throw new KubectlError(`kubequest: "set ${sub}" is not supported in the simulator yet`);
    }
  },
};
