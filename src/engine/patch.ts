/** Patch algorithms shared by `kubectl patch` and Kustomize: JSON merge, strategic merge (subset) and JSON 6902. */

export class PatchError extends Error {}

type Json = unknown;
const isObj = (v: Json): v is Record<string, Json> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** RFC 7386 JSON merge patch: objects merge, `null` deletes, everything else (lists included) replaces. */
export function mergePatch(target: Json, patch: Json): Json {
  if (!isObj(patch)) return structuredClone(patch);
  const out: Record<string, Json> = isObj(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

/** Lists that strategic merge patches by key instead of replacing (patchMergeKey in the API types). */
const MERGE_KEYS: Record<string, string[]> = {
  containers: ['name'], initContainers: ['name'], ephemeralContainers: ['name'], env: ['name'], volumes: ['name'], volumeMounts: ['mountPath'],
  ports: ['containerPort', 'port'], imagePullSecrets: ['name'], conditions: ['type'], subjects: [], rules: [], tolerations: [], volumeClaimTemplates: [],
};

/** Strategic merge patch for the built-in workload types (the subset of merge keys and directives people actually use). */
export function strategicMergePatch(target: Json, patch: Json, field = ''): Json {
  if (Array.isArray(patch)) {
    const keys = MERGE_KEYS[field];
    const key = keys?.find((k) => patch.some((x) => isObj(x) && x[k] !== undefined));
    if (!key || !Array.isArray(target)) return structuredClone(patch.filter((x) => !(isObj(x) && x.$patch === 'delete')));
    const out = [...target];
    for (const item of patch) {
      if (!isObj(item)) continue;
      const idx = out.findIndex((x) => isObj(x) && x[key] === item[key]);
      if (item.$patch === 'delete') { if (idx >= 0) out.splice(idx, 1); continue; }
      if (idx >= 0) out[idx] = strategicMergePatch(out[idx], item);
      else out.push(structuredClone(item));
    }
    return out;
  }
  if (!isObj(patch)) return structuredClone(patch);
  if (patch.$patch === 'replace') { const c = structuredClone(patch); delete c.$patch; return c; }
  const out: Record<string, Json> = isObj(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === '$patch') continue;
    if (v === null) delete out[k];
    else out[k] = strategicMergePatch(out[k], v, k);
  }
  return out;
}

function pointer(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new PatchError(`JSON pointer must start with '/': ${path}`);
  return path.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** RFC 6902 JSON patch (add, remove, replace, test, copy, move). */
export function jsonPatch(target: Json, ops: { op: string; path: string; value?: Json; from?: string }[]): Json {
  let doc: Json = structuredClone(target);
  const get = (segs: string[]): Json => {
    let cur: Json = doc;
    for (const s of segs) {
      if (Array.isArray(cur)) cur = cur[parseInt(s, 10)];
      else if (isObj(cur)) cur = cur[s];
      else return undefined;
    }
    return cur;
  };
  const parentOf = (segs: string[], what: string): { parent: Json; last: string } => {
    const parent = get(segs.slice(0, -1));
    if (parent === undefined || parent === null) throw new PatchError(`${what} operation does not apply: doc is missing path: "/${segs.join('/')}": missing value`);
    return { parent, last: segs[segs.length - 1] as string };
  };
  const add = (segs: string[], value: Json): void => {
    if (!segs.length) { doc = value; return; }
    const { parent, last } = parentOf(segs, 'add');
    if (Array.isArray(parent)) { if (last === '-') parent.push(value); else parent.splice(parseInt(last, 10), 0, value); }
    else if (isObj(parent)) parent[last] = value;
  };
  const remove = (segs: string[], what: string): Json => {
    const { parent, last } = parentOf(segs, what);
    if (Array.isArray(parent)) { const i = parseInt(last, 10); if (i >= parent.length) throw new PatchError(`${what} operation does not apply: doc is missing path: "/${segs.join('/')}": missing value`); return parent.splice(i, 1)[0]; }
    if (isObj(parent)) { if (!(last in parent)) throw new PatchError(`${what} operation does not apply: doc is missing path: "/${segs.join('/')}": missing value`); const v = parent[last]; delete parent[last]; return v; }
    return undefined;
  };
  for (const op of ops) {
    const segs = pointer(op.path);
    switch (op.op) {
      case 'add': add(segs, structuredClone(op.value)); break;
      case 'remove': remove(segs, 'remove'); break;
      case 'replace': { const { parent, last } = parentOf(segs, 'replace'); if (Array.isArray(parent)) parent[parseInt(last, 10)] = structuredClone(op.value); else if (isObj(parent)) { if (!(last in parent)) throw new PatchError(`replace operation does not apply: doc is missing key: ${op.path}: missing value`); parent[last] = structuredClone(op.value); } break; }
      case 'test': if (JSON.stringify(get(segs)) !== JSON.stringify(op.value)) throw new PatchError(`testing value ${op.path} failed: test failed`); break;
      case 'copy': add(segs, structuredClone(get(pointer(op.from ?? '')))); break;
      case 'move': add(segs, remove(pointer(op.from ?? ''), 'move')); break;
      default: throw new PatchError(`Unexpected kind: ${op.op}`);
    }
  }
  return doc;
}
