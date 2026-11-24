/**
 * PersistentVolume controller + a simulated external CSI provisioner: binds claims to volumes, provisions
 * dynamically from StorageClasses, reclaims on delete. upstream: pkg/controller/volume/persistentvolume
 */
import type { Engine } from '../engine.ts';
import type { PersistentVolumeClaim, PersistentVolume, StorageClass, Pod } from '../types.ts';
import { parseQuantity } from '../duration.ts';

const PROVISION_MS = 2000;
export const PVC_PROTECTION = 'kubernetes.io/pvc-protection';
export const PV_PROTECTION = 'kubernetes.io/pv-protection';
export const SELECTED_NODE = 'volume.kubernetes.io/selected-node';

export function defaultStorageClass(engine: Engine): StorageClass | undefined {
  return engine.store.list<StorageClass>('StorageClass').find((s) => s.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true');
}

/** Pods (not terminated) that mount the claim. */
export function podsUsingClaim(engine: Engine, pvc: PersistentVolumeClaim): Pod[] {
  return engine.store.list<Pod>('Pod', pvc.metadata.namespace).filter((p) => p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed' && p.spec.volumes?.some((v) => v.persistentVolumeClaim?.claimName === pvc.metadata.name));
}

function bind(engine: Engine, pvc: PersistentVolumeClaim, pv: PersistentVolume): void {
  pv.spec.claimRef = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', namespace: pvc.metadata.namespace as string, name: pvc.metadata.name, uid: pvc.metadata.uid };
  pv.status = { phase: 'Bound' };
  engine.store.update(pv);
  pvc.spec.volumeName = pv.metadata.name;
  pvc.metadata.annotations = { ...(pvc.metadata.annotations ?? {}), 'pv.kubernetes.io/bind-completed': 'yes', 'pv.kubernetes.io/bound-by-controller': 'yes' };
  pvc.status = { phase: 'Bound', accessModes: pv.spec.accessModes, capacity: { storage: pv.spec.capacity?.storage ?? '' } };
  engine.store.update(pvc);
}

export function runStorageController(engine: Engine): void {
  const claims = engine.store.list<PersistentVolumeClaim>('PersistentVolumeClaim');
  const volumes = engine.store.list<PersistentVolume>('PersistentVolume');
  if (!claims.length && !volumes.length) return;
  const now = engine.clock.nowMs;
  // the real controller resyncs pending claims every ~15s; repeat events at that pace, not every tick
  const ev = (pvc: PersistentVolumeClaim, type: 'Normal' | 'Warning', reason: string, message: string, component = 'persistentvolume-controller') => {
    const key = `pvc-event:${pvc.metadata.uid}:${reason}`;
    const last = engine.scratch.get(key) as number | undefined;
    if (last !== undefined && now - last < 15_000) return;
    engine.scratch.set(key, now);
    engine.store.event({ type, reason, message, involved: pvc, component });
  };
  for (const pvc of claims) {
    // deletion protection: a claim in use stays Terminating until its pods are gone
    if (pvc.metadata.deletionTimestamp) {
      if (podsUsingClaim(engine, pvc).length === 0) { pvc.metadata.finalizers = undefined; delete pvc.metadata.finalizers; engine.store.remove(pvc); }
      continue;
    }
    if (!pvc.metadata.finalizers?.includes(PVC_PROTECTION)) { pvc.metadata.finalizers = [...(pvc.metadata.finalizers ?? []), PVC_PROTECTION]; engine.store.update(pvc); }
    if (pvc.status?.phase === 'Bound') continue;
    pvc.status = pvc.status ?? { phase: 'Pending' };
    const want = parseQuantity(pvc.spec.resources?.requests?.storage ?? '0');
    const className = pvc.spec.storageClassName;
    // static binding: a pre-created Available volume that satisfies the claim
    const fits = (pv: PersistentVolume): boolean => (pv.status?.phase ?? 'Available') === 'Available' && !pv.spec.claimRef && (pv.spec.storageClassName ?? '') === (className ?? '') && parseQuantity(pv.spec.capacity?.storage ?? '0') >= want && (pvc.spec.accessModes ?? []).every((m) => (pv.spec.accessModes ?? []).includes(m));
    const named = pvc.spec.volumeName ? volumes.find((v) => v.metadata.name === pvc.spec.volumeName) : undefined;
    const candidate = named ?? volumes.filter(fits).sort((a, b) => parseQuantity(a.spec.capacity?.storage ?? '0') - parseQuantity(b.spec.capacity?.storage ?? '0'))[0];
    if (candidate && (!named || (candidate.status?.phase ?? 'Available') === 'Available')) { bind(engine, pvc, candidate); continue; }
    if (className === undefined || className === '') {
      ev(pvc, 'Normal', 'FailedBinding', 'no persistent volumes available for this claim and no storage class is set');
      continue;
    }
    const sc = engine.store.get<StorageClass>('StorageClass', undefined, className);
    if (!sc) { ev(pvc, 'Warning', 'ProvisioningFailed', `storageclass.storage.k8s.io "${className}" not found`); continue; }
    if ((sc.volumeBindingMode ?? 'Immediate') === 'WaitForFirstConsumer' && !pvc.metadata.annotations?.[SELECTED_NODE]) {
      ev(pvc, 'Normal', 'WaitForFirstConsumer', 'waiting for first consumer to be created before binding');
      continue;
    }
    if (sc.provisioner === 'kubernetes.io/no-provisioner') { ev(pvc, 'Normal', 'FailedBinding', 'no persistent volumes available for this claim and no storage class is set'); continue; }
    // dynamic provisioning through the (simulated) external provisioner
    const key = `provision:${pvc.metadata.uid}`;
    const startedAt = engine.scratch.get(key) as number | undefined;
    if (startedAt === undefined) {
      engine.scratch.set(key, now);
      pvc.metadata.annotations = { ...(pvc.metadata.annotations ?? {}), 'volume.beta.kubernetes.io/storage-provisioner': sc.provisioner, 'volume.kubernetes.io/storage-provisioner': sc.provisioner };
      engine.store.update(pvc);
      ev(pvc, 'Normal', 'ExternalProvisioning', `Waiting for a volume to be created either by the external provisioner '${sc.provisioner}' or manually by the system administrator. If volume creation is delayed, please verify that the provisioner is running and correctly registered.`);
      ev(pvc, 'Normal', 'Provisioning', `External provisioner is provisioning volume for claim "${pvc.metadata.namespace}/${pvc.metadata.name}"`, `${sc.provisioner}_csi-provisioner-0`);
      continue;
    }
    if (now - startedAt < PROVISION_MS) continue;
    engine.scratch.delete(key);
    const name = `pvc-${pvc.metadata.uid}`;
    const pv: PersistentVolume = {
      apiVersion: 'v1', kind: 'PersistentVolume',
      metadata: { name, annotations: { 'pv.kubernetes.io/provisioned-by': sc.provisioner }, finalizers: [PV_PROTECTION] },
      spec: { accessModes: pvc.spec.accessModes ?? ['ReadWriteOnce'], capacity: { storage: pvc.spec.resources?.requests?.storage ?? '1Gi' }, csi: { driver: sc.provisioner, fsType: 'ext4', volumeHandle: name }, persistentVolumeReclaimPolicy: sc.reclaimPolicy ?? 'Delete', storageClassName: sc.metadata.name, volumeMode: 'Filesystem' },
      status: { phase: 'Pending' },
    };
    engine.store.create(pv);
    bind(engine, pvc, pv);
    ev(pvc, 'Normal', 'ProvisioningSucceeded', `Successfully provisioned volume ${name}`, `${sc.provisioner}_csi-provisioner-0`);
  }
  // reclaim volumes whose claim is gone
  for (const pv of engine.store.list<PersistentVolume>('PersistentVolume')) {
    if (pv.metadata.deletionTimestamp) { if ((pv.status?.phase ?? '') !== 'Bound') { delete pv.metadata.finalizers; engine.store.remove(pv); engine.volumes.delete(pv.metadata.name); } continue; }
    const ref = pv.spec.claimRef;
    if (!ref) { if (!pv.status?.phase || pv.status.phase === 'Pending') { pv.status = { phase: 'Available' }; engine.store.update(pv); } continue; }
    const claim = engine.store.get<PersistentVolumeClaim>('PersistentVolumeClaim', ref.namespace, ref.name);
    if (claim && (!ref.uid || claim.metadata.uid === ref.uid)) continue;
    if ((pv.spec.persistentVolumeReclaimPolicy ?? 'Retain') === 'Delete') { delete pv.metadata.finalizers; engine.store.remove(pv); engine.volumes.delete(pv.metadata.name); }
    else if (pv.status?.phase !== 'Released') { pv.status = { phase: 'Released' }; engine.store.update(pv); }
  }
}
