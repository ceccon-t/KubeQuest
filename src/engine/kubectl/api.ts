/** Write path shared by kubectl commands: RBAC (when impersonating), admission, persistence, API-style errors. */
import type { CommandContext, OutputChunk } from './context.ts';
import { err } from './context.ts';
import type { KubeObject } from '../types.ts';
import { ApiError } from '../store.ts';
import { admit } from '../admission.ts';
import { resourceByKind } from '../registry.ts';
import { authorizeAccess, type Access } from './resources.ts';
import { KubectlError } from './args.ts';

/** The line kubectl prints for an API error (`source` is the manifest file for apply/create -f). */
export function formatApiError(e: ApiError, source?: string, verb = 'creating'): string {
  if (e.display) return e.display;
  return `Error from server (${e.reason}): ${source ? `error when ${verb} "${source}": ` : ''}${e.message}`;
}

export function access(ctx: CommandContext, verb?: string, subresource?: string): Access | undefined {
  return ctx.user.groups.includes('system:masters') ? undefined : { user: ctx.user, verb, subresource };
}

/** RBAC check for a write on an object (no-op for the cluster-admin kubeconfig user). */
export function authorizeWrite(ctx: CommandContext, verb: string, obj: KubeObject, subresource?: string): void {
  const info = resourceByKind(obj.kind);
  if (!info) return;
  authorizeAccess(ctx.engine, access(ctx), info, verb, obj.metadata.namespace, verb === 'create' ? undefined : obj.metadata.name, subresource);
}

export function warningChunks(warnings: string[]): OutputChunk[] {
  return warnings.map((w) => err(`Warning: ${w}\n`));
}

/** Create through the API: authorize, admit, persist. Returns admission warnings. */
export function apiCreate(ctx: CommandContext, obj: KubeObject): string[] {
  authorizeWrite(ctx, 'create', obj);
  const warnings = admit(ctx.engine, obj, 'CREATE', { user: ctx.user });
  ctx.engine.store.create(obj);
  return warnings;
}

/** Replace a stored object with an updated copy: authorize, admit, persist. */
export function apiReplace(ctx: CommandContext, updated: KubeObject, old: KubeObject, opts: { specChanged?: boolean; verb?: string; subresource?: string } = {}): string[] {
  authorizeWrite(ctx, opts.verb ?? 'patch', old, opts.subresource);
  const warnings = admit(ctx.engine, updated, 'UPDATE', { user: ctx.user, old });
  ctx.engine.store.update(updated, { specChanged: opts.specChanged });
  return warnings;
}

/**
 * Change a live object in place, the way `scale`/`set`/`label`/`patch` do: the change is made on a copy, the copy
 * goes through admission, and only then is the stored object updated (so a rejected change leaves no trace).
 */
export function apiMutate<T extends KubeObject>(ctx: CommandContext, live: T, change: (draft: T) => void, opts: { specChanged?: boolean; verb?: string; subresource?: string } = {}): string[] {
  authorizeWrite(ctx, opts.verb ?? 'patch', live, opts.subresource);
  const draft = structuredClone(live);
  change(draft);
  const warnings = admit(ctx.engine, draft, 'UPDATE', { user: ctx.user, old: live });
  const target = live as Record<string, unknown>;
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, draft);
  ctx.engine.store.update(live, { specChanged: opts.specChanged });
  return warnings;
}

/** Convert an ApiError thrown by the helpers above into kubectl's error. */
export function asKubectlError(e: unknown, source?: string, verb?: string): unknown {
  return e instanceof ApiError ? new KubectlError(formatApiError(e, source, verb)) : e;
}
