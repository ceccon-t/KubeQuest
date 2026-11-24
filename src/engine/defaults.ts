/** API-server defaulting for objects as they are admitted (so `-o yaml` shows real defaults). */
import type { Engine } from './engine.ts';
import type { KubeObject, Pod, PodSpec, Deployment, ReplicaSet, Service, Job, CronJob, DaemonSet, Probe, Container, StatefulSet, PersistentVolumeClaim, PersistentVolume, StorageClass, NetworkPolicy, HorizontalPodAutoscaler, PodDisruptionBudget, PriorityClass, Secret, Ingress } from './types.ts';
import { b64encode } from './encoding.ts';
import { normalizeImage } from './images.ts';

export function defaultProbe(p: Probe | undefined): Probe | undefined {
  if (!p) return undefined;
  const out: Probe = { ...p };
  if (out.httpGet) out.httpGet = { path: '/', scheme: 'HTTP', ...out.httpGet };
  out.initialDelaySeconds = out.initialDelaySeconds ?? 0;
  out.periodSeconds = out.periodSeconds ?? 10;
  out.timeoutSeconds = out.timeoutSeconds ?? 1;
  out.successThreshold = out.successThreshold ?? 1;
  out.failureThreshold = out.failureThreshold ?? 3;
  if (out.initialDelaySeconds === 0) delete out.initialDelaySeconds;
  return out;
}

export function defaultContainer(c: Container): Container {
  const out: Container = { ...c };
  const img = normalizeImage(c.image);
  out.imagePullPolicy = out.imagePullPolicy ?? (img.tag === 'latest' ? 'Always' : 'IfNotPresent');
  out.resources = out.resources ?? {};
  // API defaulting: a container with a limit and no request gets request = limit
  if (out.resources.limits) {
    const req = { ...(out.resources.requests ?? {}) };
    let changed = false;
    for (const k of Object.keys(out.resources.limits)) if (req[k] === undefined) { req[k] = out.resources.limits[k] as string | number; changed = true; }
    if (changed) out.resources = { ...out.resources, requests: req };
  }
  if (out.ports) out.ports = out.ports.map((p) => ({ ...p, protocol: p.protocol ?? 'TCP' }));
  if (out.livenessProbe) out.livenessProbe = defaultProbe(out.livenessProbe);
  if (out.readinessProbe) out.readinessProbe = defaultProbe(out.readinessProbe);
  if (out.startupProbe) out.startupProbe = defaultProbe(out.startupProbe);
  out.terminationMessagePath = out.terminationMessagePath ?? '/dev/termination-log';
  out.terminationMessagePolicy = out.terminationMessagePolicy ?? 'File';
  return out;
}

export function defaultPodSpec(spec: PodSpec, opts: { restartPolicy?: PodSpec['restartPolicy'] } = {}): PodSpec {
  const out: PodSpec = { ...spec };
  out.containers = spec.containers.map(defaultContainer);
  if (spec.initContainers) out.initContainers = spec.initContainers.map(defaultContainer);
  if (spec.ephemeralContainers) out.ephemeralContainers = spec.ephemeralContainers.map(defaultContainer);
  out.restartPolicy = out.restartPolicy ?? opts.restartPolicy ?? 'Always';
  out.terminationGracePeriodSeconds = out.terminationGracePeriodSeconds ?? 30;
  out.dnsPolicy = out.dnsPolicy ?? 'ClusterFirst';
  out.schedulerName = out.schedulerName ?? 'default-scheduler';
  out.securityContext = out.securityContext ?? {};
  out.serviceAccountName = out.serviceAccountName ?? 'default';
  out.serviceAccount = out.serviceAccountName;
  out.enableServiceLinks = out.enableServiceLinks ?? true;
  out.preemptionPolicy = out.preemptionPolicy ?? 'PreemptLowerPriority';
  out.priority = out.priority ?? 0;
  if (out.volumes) out.volumes = out.volumes.map((v) => (v.emptyDir !== undefined ? { ...v, emptyDir: v.emptyDir ?? {} } : v.configMap ? { ...v, configMap: { defaultMode: 420, ...v.configMap } } : v));
  return out;
}

/** Default tolerations the admission controller adds to every pod. */
export function defaultTolerations(engine: Engine): NonNullable<PodSpec['tolerations']> {
  const s = engine.evictionSeconds;
  return [
    { key: 'node.kubernetes.io/not-ready', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: s },
    { key: 'node.kubernetes.io/unreachable', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: s },
  ];
}

export function applyDefaults<T extends KubeObject>(obj: T, engine: Engine): T {
  // a pod template may omit `metadata` altogether (typical for Jobs); the API server stores an empty one
  const withTemplate = (spec: unknown): void => {
    const t = (spec as { template?: { metadata?: unknown; spec?: unknown } } | undefined)?.template;
    if (t && typeof t === 'object' && t.spec !== undefined && t.metadata === undefined) t.metadata = {};
  };
  withTemplate(obj.spec);
  withTemplate((obj.spec as { jobTemplate?: { spec?: unknown } } | undefined)?.jobTemplate?.spec);
  switch (obj.kind) {
    case 'Pod': {
      const p = obj as unknown as Pod;
      p.spec = defaultPodSpec(p.spec);
      const tol = [...(p.spec.tolerations ?? [])];
      for (const t of defaultTolerations(engine)) if (!tol.some((x) => x.key === t.key && x.effect === t.effect)) tol.push(t);
      p.spec.tolerations = tol;
      p.status = p.status ?? { phase: 'Pending' };
      p.status.phase = p.status.phase ?? 'Pending';
      p.status.qosClass = qosClass(p.spec);
      break;
    }
    case 'Deployment': {
      const d = obj as unknown as Deployment;
      d.spec.replicas = d.spec.replicas ?? 1;
      d.spec.revisionHistoryLimit = d.spec.revisionHistoryLimit ?? 10;
      d.spec.progressDeadlineSeconds = d.spec.progressDeadlineSeconds ?? 600;
      const strat = d.spec.strategy ?? {};
      strat.type = strat.type ?? 'RollingUpdate';
      if (strat.type === 'RollingUpdate') strat.rollingUpdate = { maxSurge: '25%', maxUnavailable: '25%', ...(strat.rollingUpdate ?? {}) };
      else delete strat.rollingUpdate;
      d.spec.strategy = strat;
      d.spec.template.metadata = d.spec.template.metadata ?? {};
      d.spec.template.spec = defaultPodSpec(d.spec.template.spec);
      d.status = d.status ?? {};
      break;
    }
    case 'ReplicaSet': {
      const r = obj as unknown as ReplicaSet;
      r.spec.replicas = r.spec.replicas ?? 1;
      r.spec.template.spec = defaultPodSpec(r.spec.template.spec);
      r.status = r.status ?? { replicas: 0 };
      break;
    }
    case 'DaemonSet': {
      const d = obj as unknown as DaemonSet;
      d.spec.updateStrategy = d.spec.updateStrategy ?? { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1 } };
      d.spec.revisionHistoryLimit = d.spec.revisionHistoryLimit ?? 10;
      d.spec.template.spec = defaultPodSpec(d.spec.template.spec);
      d.status = d.status ?? { currentNumberScheduled: 0, desiredNumberScheduled: 0, numberMisscheduled: 0, numberReady: 0 };
      break;
    }
    case 'Job': {
      const j = obj as unknown as Job;
      j.spec.parallelism = j.spec.parallelism ?? 1;
      j.spec.completions = j.spec.completions ?? 1;
      j.spec.backoffLimit = j.spec.backoffLimit ?? 6;
      j.spec.completionMode = j.spec.completionMode ?? 'NonIndexed';
      j.spec.suspend = j.spec.suspend ?? false;
      j.spec.template.spec = defaultPodSpec(j.spec.template.spec, { restartPolicy: 'Never' });
      j.status = j.status ?? {};
      break;
    }
    case 'CronJob': {
      const c = obj as unknown as CronJob;
      c.spec.concurrencyPolicy = c.spec.concurrencyPolicy ?? 'Allow';
      c.spec.suspend = c.spec.suspend ?? false;
      c.spec.successfulJobsHistoryLimit = c.spec.successfulJobsHistoryLimit ?? 3;
      c.spec.failedJobsHistoryLimit = c.spec.failedJobsHistoryLimit ?? 1;
      c.spec.jobTemplate.spec.template.spec = defaultPodSpec(c.spec.jobTemplate.spec.template.spec, { restartPolicy: 'Never' });
      c.status = c.status ?? {};
      break;
    }
    case 'Service': {
      const s = obj as unknown as Service;
      s.spec.type = s.spec.type ?? 'ClusterIP';
      s.spec.sessionAffinity = s.spec.sessionAffinity ?? 'None';
      if (s.spec.type !== 'ExternalName') {
        s.spec.ipFamilies = s.spec.ipFamilies ?? ['IPv4'];
        s.spec.ipFamilyPolicy = s.spec.ipFamilyPolicy ?? 'SingleStack';
        s.spec.internalTrafficPolicy = s.spec.internalTrafficPolicy ?? 'Cluster';
      }
      if (s.spec.type === 'NodePort' || s.spec.type === 'LoadBalancer') s.spec.externalTrafficPolicy = s.spec.externalTrafficPolicy ?? 'Cluster';
      s.spec.ports = (s.spec.ports ?? []).map((p) => ({ protocol: 'TCP', ...p, targetPort: p.targetPort ?? p.port }));
      s.status = s.status ?? { loadBalancer: {} };
      break;
    }
    case 'Namespace': {
      const ns = obj as KubeObject;
      // the API server stamps every namespace with its own name as a label (handy for namespaceSelectors)
      ns.metadata.labels = { ...(ns.metadata.labels ?? {}), 'kubernetes.io/metadata.name': ns.metadata.name };
      ns.spec = ns.spec ?? { finalizers: ['kubernetes'] };
      ns.status = ns.status ?? { phase: 'Active' };
      break;
    }
    case 'StatefulSet': {
      const st = obj as unknown as StatefulSet;
      st.spec.replicas = st.spec.replicas ?? 1;
      st.spec.podManagementPolicy = st.spec.podManagementPolicy ?? 'OrderedReady';
      st.spec.revisionHistoryLimit = st.spec.revisionHistoryLimit ?? 10;
      const us = st.spec.updateStrategy ?? {};
      us.type = us.type ?? 'RollingUpdate';
      if (us.type === 'RollingUpdate') us.rollingUpdate = { partition: 0, ...(us.rollingUpdate ?? {}) };
      st.spec.updateStrategy = us;
      st.spec.persistentVolumeClaimRetentionPolicy = st.spec.persistentVolumeClaimRetentionPolicy ?? { whenDeleted: 'Retain', whenScaled: 'Retain' };
      st.spec.template.metadata = st.spec.template.metadata ?? {};
      st.spec.template.spec = defaultPodSpec(st.spec.template.spec);
      for (const t of st.spec.volumeClaimTemplates ?? []) { t.apiVersion = 'v1'; t.kind = 'PersistentVolumeClaim'; t.spec.volumeMode = t.spec.volumeMode ?? 'Filesystem'; t.status = t.status ?? { phase: 'Pending' }; }
      st.status = st.status ?? { replicas: 0 };
      break;
    }
    case 'PersistentVolumeClaim': {
      const c = obj as unknown as PersistentVolumeClaim;
      c.spec.volumeMode = c.spec.volumeMode ?? 'Filesystem';
      // DefaultStorageClass admission: a claim without a class gets the cluster default, if there is one
      if (c.spec.storageClassName === undefined && !c.spec.volumeName) {
        const def = engine.store.list<StorageClass>('StorageClass').find((x) => x.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true');
        if (def) c.spec.storageClassName = def.metadata.name;
      }
      c.status = c.status ?? { phase: 'Pending' };
      break;
    }
    case 'PersistentVolume': {
      const v = obj as unknown as PersistentVolume;
      v.spec.persistentVolumeReclaimPolicy = v.spec.persistentVolumeReclaimPolicy ?? 'Retain';
      v.spec.volumeMode = v.spec.volumeMode ?? 'Filesystem';
      v.status = v.status ?? { phase: 'Pending' };
      break;
    }
    case 'StorageClass': {
      const c = obj as unknown as StorageClass;
      c.reclaimPolicy = c.reclaimPolicy ?? 'Delete';
      c.volumeBindingMode = c.volumeBindingMode ?? 'Immediate';
      break;
    }
    case 'NetworkPolicy': {
      const n = obj as unknown as NetworkPolicy;
      n.spec.podSelector = n.spec.podSelector ?? {};
      n.spec.policyTypes = n.spec.policyTypes ?? (n.spec.egress ? ['Ingress', 'Egress'] : ['Ingress']);
      break;
    }
    case 'Ingress': {
      const i = obj as unknown as Ingress;
      i.status = i.status ?? { loadBalancer: {} };
      break;
    }
    case 'HorizontalPodAutoscaler': {
      const h = obj as unknown as HorizontalPodAutoscaler;
      h.spec.minReplicas = h.spec.minReplicas ?? 1;
      h.spec.metrics = h.spec.metrics ?? [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 80 } } }];
      h.status = h.status ?? {};
      break;
    }
    case 'PodDisruptionBudget': {
      const p = obj as unknown as PodDisruptionBudget;
      p.status = p.status ?? { currentHealthy: 0, desiredHealthy: 0, disruptionsAllowed: 0, expectedPods: 0 };
      break;
    }
    case 'PriorityClass': {
      const p = obj as unknown as PriorityClass;
      p.preemptionPolicy = p.preemptionPolicy ?? 'PreemptLowerPriority';
      break;
    }
    case 'Secret': {
      const sec = obj as unknown as Secret;
      sec.type = sec.type ?? 'Opaque';
      // stringData is write-only: the API server merges it into data (base64) and drops it
      if (sec.stringData) { sec.data = { ...(sec.data ?? {}) }; for (const [k, v] of Object.entries(sec.stringData)) sec.data[k] = b64encode(String(v)); delete sec.stringData; }
      break;
    }
    case 'Gateway': case 'GatewayClass': {
      // the Gateway API CRDs default status to "Waiting for controller" until an implementation takes over
      const g = obj as KubeObject;
      if (!g.status) {
        const c = (type: string) => ({ lastTransitionTime: '1970-01-01T00:00:00Z', message: 'Waiting for controller', reason: 'Pending', status: 'Unknown', type });
        g.status = { conditions: g.kind === 'Gateway' ? [c('Accepted'), c('Programmed')] : [c('Accepted')] };
      }
      break;
    }
    default:
      break;
  }
  return obj;
}

export function qosClass(spec: PodSpec): 'Guaranteed' | 'Burstable' | 'BestEffort' {
  let hasReq = false, hasLim = false, guaranteed = true;
  for (const c of [...spec.containers, ...(spec.initContainers ?? [])]) {
    const req = c.resources?.requests ?? {};
    const lim = c.resources?.limits ?? {};
    for (const r of ['cpu', 'memory']) {
      if (req[r] !== undefined) hasReq = true;
      if (lim[r] !== undefined) hasLim = true;
      if (lim[r] === undefined || (req[r] !== undefined && String(req[r]) !== String(lim[r]))) guaranteed = false;
    }
  }
  if (!hasReq && !hasLim) return 'BestEffort';
  return guaranteed ? 'Guaranteed' : 'Burstable';
}
