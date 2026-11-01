/** Garbage collector: delete dependents whose controller owner is gone (background cascade); finish graceful deletions of non-pod objects. */
import type { Engine } from '../engine.ts';
import type { KubeObject, Pod } from '../types.ts';

export function runGarbageCollector(engine: Engine): void {
  for (const obj of engine.store.all()) {
    if (obj.kind === 'Event') continue;
    // objects marked for deletion that are not pods are removed immediately (no finalizers in the sim)
    if (obj.metadata.deletionTimestamp && obj.kind !== 'Pod') {
      engine.store.remove(obj);
      continue;
    }
    const refs = obj.metadata.ownerReferences ?? [];
    if (refs.length === 0) continue;
    const alive = refs.filter((r) => engine.store.getByUid(r.uid));
    if (alive.length === refs.length) continue;
    if (alive.length === 0) {
      // owner gone ⇒ dependent is deleted (background propagation)
      if (obj.kind === 'Pod') {
        const p = obj as Pod;
        if (!p.metadata.deletionTimestamp) engine.store.markDeleting(p, p.spec.terminationGracePeriodSeconds ?? 30);
      } else engine.store.remove(obj);
    } else {
      obj.metadata.ownerReferences = alive;
      engine.store.update(obj);
    }
  }
  // pods on nodes that no longer exist
  for (const p of engine.store.list<Pod>('Pod')) {
    if (p.spec.nodeName && !engine.store.get('Node', undefined, p.spec.nodeName)) engine.store.remove(p);
  }
  void (0 as unknown as KubeObject);
}
