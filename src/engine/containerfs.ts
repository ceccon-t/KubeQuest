/**
 * What a container sees as its filesystem: image files, its own writable layer (lost on restart), and volume
 * mounts — ConfigMaps/Secrets (read-only projections), emptyDir (shared within the pod, dies with it) and
 * PersistentVolumeClaims (outlive the pod).
 */
import type { Engine } from './engine.ts';
import type { Pod, Container, Volume, ConfigMap, Secret, PersistentVolumeClaim } from './types.ts';
import type { ContainerRuntime } from './runtime.ts';
import { b64decode } from './encoding.ts';

/** Where a volume's data lives in `engine.volumes` (undefined for projected volumes or unbound claims). */
export function volumeId(engine: Engine, pod: Pod, v: Volume): string | undefined {
  if (v.emptyDir !== undefined) return `emptydir:${pod.metadata.uid}:${v.name}`;
  if (v.persistentVolumeClaim) {
    const pvc = engine.store.get<PersistentVolumeClaim>('PersistentVolumeClaim', pod.metadata.namespace, v.persistentVolumeClaim.claimName);
    return pvc?.status?.phase === 'Bound' ? pvc.spec.volumeName : undefined;
  }
  return undefined;
}

function volumeData(engine: Engine, id: string): Map<string, string> {
  let m = engine.volumes.get(id);
  if (!m) { m = new Map(); engine.volumes.set(id, m); }
  return m;
}

/** Files projected from ConfigMaps and Secrets through the container's volume mounts (absolute path → content). */
export function mountedFiles(engine: Engine, pod: Pod, spec: Container): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of spec.volumeMounts ?? []) {
    const v = pod.spec.volumes?.find((x) => x.name === m.name);
    if (!v) continue;
    const id = volumeId(engine, pod, v);
    if (id !== undefined) {
      for (const [k, val] of volumeData(engine, id)) out.set(`${m.mountPath.replace(/\/$/, '')}/${k}`, val);
      continue;
    }
    let data: Record<string, string> = {};
    if (v.configMap) data = engine.store.get<ConfigMap>('ConfigMap', pod.metadata.namespace, v.configMap.name)?.data ?? {};
    if (v.secret) {
      const s = engine.store.get<Secret>('Secret', pod.metadata.namespace, v.secret.secretName)?.data ?? {};
      for (const [k, val] of Object.entries(s)) data[k] = b64decode(val) ?? val;
    }
    const items = v.configMap?.items ?? v.secret?.items;
    if (m.subPath) {
      if (data[m.subPath] !== undefined) out.set(m.mountPath, data[m.subPath] as string);
      continue;
    }
    for (const [k, val] of Object.entries(data)) {
      const p = items ? items.find((i) => i.key === k)?.path : k;
      if (!p) continue;
      out.set(`${m.mountPath.replace(/\/$/, '')}/${p}`, val);
    }
  }
  return out;
}

/** The mount (if any) that covers an absolute path, longest mountPath first. */
export function mountFor(pod: Pod, spec: Container, path: string): { mount: NonNullable<Container['volumeMounts']>[number]; volume: Volume; rel: string } | undefined {
  const mounts = [...(spec.volumeMounts ?? [])].sort((a, b) => b.mountPath.length - a.mountPath.length);
  for (const m of mounts) {
    const base = m.mountPath.replace(/\/$/, '');
    if (path !== base && !path.startsWith(base + '/')) continue;
    const volume = pod.spec.volumes?.find((x) => x.name === m.name);
    if (!volume) continue;
    return { mount: m, volume, rel: path.slice(base.length + 1) };
  }
  return undefined;
}

/** Is the path on storage that survives a container restart (a writable volume)? */
export function isVolumePath(engine: Engine, pod: Pod, spec: Container, path: string): boolean {
  const hit = mountFor(pod, spec, path);
  return !!hit && volumeId(engine, pod, hit.volume) !== undefined;
}

/** Write a file as the container process would. Returns an errno-style message when the write is refused. */
export function writeContainerFile(engine: Engine, pod: Pod, spec: Container, rt: ContainerRuntime, path: string, content: string, append = false): string | undefined {
  const hit = mountFor(pod, spec, path);
  if (hit) {
    const id = volumeId(engine, pod, hit.volume);
    if (id === undefined || hit.mount.readOnly) return 'Read-only file system';
    const data = volumeData(engine, id);
    data.set(hit.rel, append ? (data.get(hit.rel) ?? '') + content : content);
    return undefined;
  }
  if (spec.securityContext?.readOnlyRootFilesystem) return 'Read-only file system';
  rt.fs = rt.fs ?? new Map();
  rt.fs.set(path, append ? (rt.fs.get(path) ?? '') + content : content);
  return undefined;
}

/** Every file the container can read, by absolute path. */
export function containerFiles(engine: Engine, pod: Pod, spec: Container | undefined, rt: ContainerRuntime | undefined): Map<string, string> {
  const files = new Map<string, string>();
  for (const [k, v] of Object.entries(rt?.behaviour?.files ?? {})) files.set(k, v);
  for (const [k, v] of rt?.fs ?? []) files.set(k, v);
  if (spec) for (const [k, v] of mountedFiles(engine, pod, spec)) files.set(k, v);
  return files;
}

/** Drop the emptyDir volumes of a pod that is gone. */
export function releasePodVolumes(engine: Engine, pod: Pod): void {
  const prefix = `emptydir:${pod.metadata.uid}:`;
  for (const k of engine.volumes.keys()) if (k.startsWith(prefix)) engine.volumes.delete(k);
}
