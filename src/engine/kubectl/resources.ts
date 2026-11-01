/** Resolution of `TYPE NAME`, `TYPE/NAME`, `TYPE1,TYPE2` arguments and namespace handling, with kubectl's errors. */
import type { Engine } from '../engine.ts';
import type { KubeObject } from '../types.ts';
import { resolveResource, allResources, type ResourceInfo } from '../registry.ts';
import { KubectlError } from './args.ts';
import { parseSelectorString, matches, SelectorParseError } from '../selector.ts';

export interface ResourceRef {
  info: ResourceInfo;
  /** undefined ⇒ all objects of this kind */
  name?: string;
}

export function resourceTypeError(name: string): KubectlError {
  return new KubectlError(`the server doesn't have a resource type "${name}"`);
}

/** Parse kubectl resource arguments. `allowAll` enables the `all` category. */
export function parseResourceArgs(args: string[], opts: { allowAll?: boolean } = {}): ResourceRef[] {
  if (args.length === 0) return [];
  const first = args[0] as string;
  const refs: ResourceRef[] = [];
  const typesOf = (t: string): ResourceInfo[] => {
    if (t === 'all' && opts.allowAll) return allResources().filter((r) => r.categories.includes('all'));
    const r = resolveResource(t);
    if (!r) throw resourceTypeError(t);
    return [r];
  };
  if (first.includes('/')) {
    // TYPE/NAME form for every arg
    for (const a of args) {
      const slash = a.indexOf('/');
      if (slash < 0) throw new KubectlError(`there is no need to specify a resource type as a separate argument when passing arguments in resource/name form (e.g. 'kubectl get resource/<resource_name>' instead of 'kubectl get resource resource/<resource_name>')`);
      const t = a.slice(0, slash), n = a.slice(slash + 1);
      const infos = typesOf(t);
      if (infos.length !== 1) throw new KubectlError(`arguments in resource/name form must have a single resource and name`);
      refs.push({ info: infos[0] as ResourceInfo, name: n });
    }
    return refs;
  }
  const types = first.split(',').flatMap(typesOf);
  const names = args.slice(1);
  if (names.some((n) => n.includes('/'))) throw new KubectlError(`there is no need to specify a resource type as a separate argument when passing arguments in resource/name form (e.g. 'kubectl get resource/<resource_name>' instead of 'kubectl get resource resource/<resource_name>')`);
  if (types.length > 1 && names.length > 0) throw new KubectlError(`there is no need to specify a resource type as a separate argument when passing arguments in resource/name form (e.g. 'kubectl get resource/<resource_name>' instead of 'kubectl get resource resource/<resource_name>')`);
  for (const t of types) {
    if (names.length === 0) refs.push({ info: t });
    else for (const n of names) refs.push({ info: t, name: n });
  }
  return refs;
}

export function notFound(info: ResourceInfo, name: string): KubectlError {
  return new KubectlError(`Error from server (NotFound): ${info.plural} "${name}" not found`);
}

/** Fetch the objects for a ref, applying namespace, label selector and field selector. */
export function fetch(engine: Engine, ref: ResourceRef, ns: string, allNs: boolean, selector?: string, fieldSelector?: string): KubeObject[] {
  const { info } = ref;
  const scopeNs = info.namespaced ? (allNs ? undefined : ns) : undefined;
  if (info.namespaced && !allNs && ref.name !== undefined && !engine.store.get('Namespace', undefined, ns)) {
    throw new KubectlError(`Error from server (NotFound): namespaces "${ns}" not found`);
  }
  let objs: KubeObject[];
  if (ref.name !== undefined) {
    const o = engine.store.get(info.kind, scopeNs, ref.name);
    if (!o) throw notFound(info, ref.name);
    objs = [o];
  } else objs = engine.store.list(info.kind, scopeNs);
  if (selector !== undefined) {
    let reqs;
    try { reqs = parseSelectorString(selector); } catch (e) { if (e instanceof SelectorParseError) throw new KubectlError(e.message); throw e; }
    objs = objs.filter((o) => matches(reqs, o.metadata.labels));
  }
  if (fieldSelector) {
    for (const part of fieldSelector.split(',')) {
      const m = /^([^=!]+)(==|!=|=)(.*)$/.exec(part.trim());
      if (!m) throw new KubectlError(`field label not supported: ${part}`);
      const path = m[1] as string, op = m[2], val = m[3] as string;
      objs = objs.filter((o) => {
        const v = String(getPath(o, path) ?? '');
        return op === '!=' ? v !== val : v === val;
      });
    }
  }
  return objs;
}

export function getPath(o: unknown, path: string): unknown {
  let cur: unknown = o;
  for (const seg of path.replace(/^\./, '').split('.')) {
    if (cur === null || cur === undefined) return undefined;
    const m = /^([^\[]+)\[(\d+)\]$/.exec(seg);
    if (m) {
      cur = (cur as Record<string, unknown>)[m[1] as string];
      cur = Array.isArray(cur) ? cur[parseInt(m[2] as string, 10)] : undefined;
    } else cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
