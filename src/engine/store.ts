/** In-memory object store with the API-server behaviours that matter for fidelity. */
import type { KubeObject, Event, OwnerReference } from './types.ts';
import type { Clock } from './clock.ts';
import { resourceByKind } from './registry.ts';

export class ApiError extends Error {
  reason: 'NotFound' | 'AlreadyExists' | 'Invalid' | 'Conflict' | 'BadRequest' | 'Forbidden';
  constructor(reason: ApiError['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

export type StoreListener = (type: 'ADDED' | 'MODIFIED' | 'DELETED', obj: KubeObject) => void;

export interface EventInput {
  type: 'Normal' | 'Warning';
  reason: string;
  message: string;
  involved: KubeObject | { kind: string; name: string; namespace?: string; uid?: string };
  component: string; // e.g. 'kubelet', 'default-scheduler', 'deployment-controller'
  host?: string;
}

export function objectKey(kind: string, namespace: string | undefined, name: string): string {
  return `${kind}|${namespace ?? ''}|${name}`;
}

export class ClusterStore {
  private objects = new Map<string, KubeObject>();
  private byUid = new Map<string, KubeObject>();
  private rv = 1000;
  private uidCounter = 0;
  private listeners: StoreListener[] = [];
  clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  subscribe(fn: StoreListener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(type: 'ADDED' | 'MODIFIED' | 'DELETED', obj: KubeObject): void {
    for (const l of this.listeners) l(type, obj);
  }

  nextUid(): string {
    this.uidCounter++;
    const h = (n: number, w: number) => n.toString(16).padStart(w, '0');
    const c = this.uidCounter;
    return `${h(0x1a2b0000 + c * 7919, 8)}-${h(0x4c00 + c, 4)}-${h(0x4000 + (c * 31) % 4096, 4)}-${h(0x8000 + (c * 17) % 4096, 4)}-${h(0x5a5a00000000 + c * 104729, 12)}`;
  }

  nextRv(): string {
    this.rv += 1 + (this.rv % 3);
    return String(this.rv);
  }

  get<T extends KubeObject = KubeObject>(kind: string, namespace: string | undefined, name: string): T | undefined {
    const r = resourceByKind(kind);
    const ns = r && !r.namespaced ? '' : namespace;
    return this.objects.get(objectKey(kind, ns, name)) as T | undefined;
  }

  getByUid<T extends KubeObject = KubeObject>(uid: string): T | undefined {
    return this.byUid.get(uid) as T | undefined;
  }

  list<T extends KubeObject = KubeObject>(kind: string, namespace?: string): T[] {
    const out: T[] = [];
    for (const o of this.objects.values()) {
      if (o.kind !== kind) continue;
      if (namespace !== undefined && (o.metadata.namespace ?? '') !== namespace) continue;
      out.push(o as T);
    }
    out.sort((a, b) => {
      const na = `${a.metadata.namespace ?? ''}/${a.metadata.name}`;
      const nb = `${b.metadata.namespace ?? ''}/${b.metadata.name}`;
      return na < nb ? -1 : na > nb ? 1 : 0;
    });
    return out;
  }

  all(): KubeObject[] {
    return [...this.objects.values()];
  }

  /** Create with API-server defaults for metadata. Throws AlreadyExists. */
  create<T extends KubeObject>(obj: T, opts: { preserveMeta?: boolean } = {}): T {
    const r = resourceByKind(obj.kind);
    if (r && !r.namespaced) delete obj.metadata.namespace;
    if (r && r.namespaced && !obj.metadata.namespace) obj.metadata.namespace = 'default';
    if (obj.metadata.generateName && !obj.metadata.name) {
      throw new Error('generateName must be resolved by the caller');
    }
    const key = objectKey(obj.kind, obj.metadata.namespace, obj.metadata.name);
    if (this.objects.has(key)) {
      throw new ApiError('AlreadyExists', `${r?.plural ?? obj.kind.toLowerCase() + 's'} "${obj.metadata.name}" already exists`);
    }
    if (!opts.preserveMeta || !obj.metadata.uid) obj.metadata.uid = this.nextUid();
    if (!opts.preserveMeta || !obj.metadata.creationTimestamp) obj.metadata.creationTimestamp = this.clock.iso();
    obj.metadata.resourceVersion = this.nextRv();
    if (obj.spec !== undefined && obj.metadata.generation === undefined) obj.metadata.generation = 1;
    delete obj.metadata.generateName;
    this.objects.set(key, obj);
    this.byUid.set(obj.metadata.uid, obj);
    this.emit('ADDED', obj);
    return obj;
  }

  /** Persist a modification. `specChanged` bumps metadata.generation. */
  update<T extends KubeObject>(obj: T, opts: { specChanged?: boolean } = {}): T {
    const key = objectKey(obj.kind, obj.metadata.namespace, obj.metadata.name);
    const existing = this.objects.get(key);
    if (!existing) throw new ApiError('NotFound', `${pluralOf(obj.kind)} "${obj.metadata.name}" not found`);
    if (existing !== obj) {
      // replace instance (e.g. from apply): keep server-managed metadata
      obj.metadata.uid = existing.metadata.uid;
      obj.metadata.creationTimestamp = existing.metadata.creationTimestamp;
      obj.metadata.generation = existing.metadata.generation;
      if (existing.metadata.deletionTimestamp) obj.metadata.deletionTimestamp = existing.metadata.deletionTimestamp;
      this.objects.set(key, obj);
      this.byUid.set(obj.metadata.uid as string, obj);
    }
    obj.metadata.resourceVersion = this.nextRv();
    if (opts.specChanged) obj.metadata.generation = (obj.metadata.generation ?? 0) + 1;
    this.emit('MODIFIED', obj);
    return obj;
  }

  /** Remove immediately (the kubelet/controllers decide when a graceful deletion finishes). */
  remove(obj: KubeObject): void {
    const key = objectKey(obj.kind, obj.metadata.namespace, obj.metadata.name);
    if (this.objects.get(key) !== obj) return;
    this.objects.delete(key);
    if (obj.metadata.uid) this.byUid.delete(obj.metadata.uid);
    this.emit('DELETED', obj);
  }

  /** Mark for graceful deletion. */
  markDeleting(obj: KubeObject, graceSeconds: number): void {
    if (obj.metadata.deletionTimestamp) {
      // a shorter grace period can override a longer one, like the API server does
      if ((obj.metadata.deletionGracePeriodSeconds ?? 0) > graceSeconds) {
        obj.metadata.deletionGracePeriodSeconds = graceSeconds;
        obj.metadata.deletionTimestamp = this.clock.iso(this.clock.nowMs + graceSeconds * 1000);
        this.update(obj);
      }
      return;
    }
    obj.metadata.deletionTimestamp = this.clock.iso(this.clock.nowMs + graceSeconds * 1000);
    obj.metadata.deletionGracePeriodSeconds = graceSeconds;
    this.update(obj);
  }

  // --- owner references -----------------------------------------------------

  ownerRef(owner: KubeObject, controller = true): OwnerReference {
    return {
      apiVersion: owner.apiVersion,
      kind: owner.kind,
      name: owner.metadata.name,
      uid: owner.metadata.uid as string,
      controller,
      blockOwnerDeletion: true,
    };
  }

  controllerOf(obj: KubeObject): KubeObject | undefined {
    const ref = obj.metadata.ownerReferences?.find((r) => r.controller);
    return ref ? this.byUid.get(ref.uid) : undefined;
  }

  ownedBy<T extends KubeObject = KubeObject>(owner: KubeObject, kind: string): T[] {
    const uid = owner.metadata.uid;
    return this.list<T>(kind, owner.metadata.namespace).filter((o) => o.metadata.ownerReferences?.some((r) => r.uid === uid && r.controller));
  }

  // --- events ----------------------------------------------------------------

  /** Record an event, de-duplicating like the event recorder (same object/reason/message → count++). */
  event(e: EventInput): Event {
    const inv = e.involved;
    const ns = (inv as KubeObject).metadata ? (inv as KubeObject).metadata.namespace : (inv as { namespace?: string }).namespace;
    const name = (inv as KubeObject).metadata ? (inv as KubeObject).metadata.name : (inv as { name: string }).name;
    const uid = (inv as KubeObject).metadata ? (inv as KubeObject).metadata.uid : (inv as { uid?: string }).uid;
    const evNs = ns ?? 'default';
    const now = this.clock.iso();
    for (const o of this.objects.values()) {
      if (o.kind !== 'Event') continue;
      const ev = o as Event;
      if (
        ev.metadata.namespace === evNs &&
        ev.involvedObject.name === name &&
        ev.involvedObject.kind === inv.kind &&
        (ev.involvedObject.uid ?? '') === (uid ?? '') &&
        ev.reason === e.reason &&
        ev.message === e.message &&
        ev.type === e.type
      ) {
        ev.count += 1;
        ev.lastTimestamp = now;
        this.update(ev);
        return ev;
      }
    }
    const ev: Event = {
      apiVersion: 'v1',
      kind: 'Event',
      metadata: { name: `${name}.${(0x17a0000000000000n + BigInt(this.rv) * 7919n).toString(16)}`, namespace: evNs },
      involvedObject: { kind: inv.kind, namespace: ns, name, uid, apiVersion: (inv as KubeObject).apiVersion },
      reason: e.reason,
      message: e.message,
      source: e.host ? { component: e.component, host: e.host } : { component: e.component },
      firstTimestamp: now,
      lastTimestamp: now,
      count: 1,
      type: e.type,
      reportingComponent: e.component,
      reportingInstance: e.host ?? '',
    };
    this.create(ev);
    return ev;
  }

  eventsFor(obj: KubeObject): Event[] {
    return this.list<Event>('Event', obj.metadata.namespace ?? 'default')
      .filter((e) => e.involvedObject.name === obj.metadata.name && e.involvedObject.kind === obj.kind && (e.involvedObject.uid ?? obj.metadata.uid) === obj.metadata.uid)
      .sort((a, b) => (a.lastTimestamp < b.lastTimestamp ? -1 : a.lastTimestamp > b.lastTimestamp ? 1 : 0));
  }
}

export function pluralOf(kind: string): string {
  return resourceByKind(kind)?.plural ?? kind.toLowerCase() + 's';
}
