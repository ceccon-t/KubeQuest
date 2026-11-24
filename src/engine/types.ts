/** Kubernetes object shapes (subset) stored as plain JSON. Field names mirror the API exactly. */

export interface OwnerReference {
  apiVersion: string;
  kind: string;
  name: string;
  uid: string;
  controller?: boolean;
  blockOwnerDeletion?: boolean;
}

export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  creationTimestamp?: string;
  deletionTimestamp?: string;
  deletionGracePeriodSeconds?: number;
  generation?: number;
  generateName?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: OwnerReference[];
  finalizers?: string[];
}

export interface KubeObject {
  apiVersion: string;
  kind: string;
  metadata: ObjectMeta;
  [key: string]: unknown;
}

export interface ResourceRequirements {
  requests?: Record<string, string | number>;
  limits?: Record<string, string | number>;
}

export interface Probe {
  httpGet?: { path?: string; port: number | string; scheme?: string; host?: string };
  tcpSocket?: { port: number | string };
  exec?: { command: string[] };
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  successThreshold?: number;
  failureThreshold?: number;
}

export interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: {
    configMapKeyRef?: { name: string; key: string; optional?: boolean };
    secretKeyRef?: { name: string; key: string; optional?: boolean };
    fieldRef?: { fieldPath: string };
  };
}

export interface Container {
  name: string;
  image: string;
  imagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
  command?: string[];
  args?: string[];
  env?: EnvVar[];
  envFrom?: { configMapRef?: { name: string; optional?: boolean }; secretRef?: { name: string; optional?: boolean } }[];
  ports?: { name?: string; containerPort: number; protocol?: string; hostPort?: number }[];
  resources?: ResourceRequirements;
  livenessProbe?: Probe;
  readinessProbe?: Probe;
  startupProbe?: Probe;
  volumeMounts?: { name: string; mountPath: string; readOnly?: boolean; subPath?: string }[];
  securityContext?: SecurityContext;
  workingDir?: string;
  /** Ephemeral containers only: the container whose namespaces are shared (`kubectl debug --target`). */
  targetContainerName?: string;
  terminationMessagePath?: string;
  terminationMessagePolicy?: string;
  tty?: boolean;
  stdin?: boolean;
}

export interface Toleration {
  key?: string;
  operator?: 'Equal' | 'Exists';
  value?: string;
  effect?: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
  tolerationSeconds?: number;
}

export interface Taint {
  key: string;
  value?: string;
  effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
  timeAdded?: string;
}

export interface SecurityContext {
  runAsUser?: number;
  runAsGroup?: number;
  runAsNonRoot?: boolean;
  fsGroup?: number;
  privileged?: boolean;
  allowPrivilegeEscalation?: boolean;
  readOnlyRootFilesystem?: boolean;
  capabilities?: { add?: string[]; drop?: string[] };
  seccompProfile?: { type?: string; localhostProfile?: string };
  [extra: string]: unknown;
}

export interface TopologySpreadConstraint {
  maxSkew: number;
  topologyKey: string;
  whenUnsatisfiable: 'DoNotSchedule' | 'ScheduleAnyway';
  labelSelector?: LabelSelector;
  matchLabelKeys?: string[];
  minDomains?: number;
}

export interface Volume {
  name: string;
  emptyDir?: Record<string, unknown>;
  projected?: Record<string, unknown>;
  configMap?: { name: string; items?: { key: string; path: string }[]; optional?: boolean };
  secret?: { secretName: string; items?: { key: string; path: string }[]; optional?: boolean };
  hostPath?: { path: string; type?: string };
  persistentVolumeClaim?: { claimName: string };
}

export interface PodSpec {
  containers: Container[];
  initContainers?: Container[];
  ephemeralContainers?: Container[];
  volumes?: Volume[];
  restartPolicy?: 'Always' | 'OnFailure' | 'Never';
  terminationGracePeriodSeconds?: number;
  nodeName?: string;
  nodeSelector?: Record<string, string>;
  tolerations?: Toleration[];
  affinity?: Record<string, unknown>;
  topologySpreadConstraints?: TopologySpreadConstraint[];
  imagePullSecrets?: { name: string }[];
  hostNetwork?: boolean;
  hostPID?: boolean;
  hostIPC?: boolean;
  automountServiceAccountToken?: boolean;
  serviceAccountName?: string;
  serviceAccount?: string;
  dnsPolicy?: string;
  schedulerName?: string;
  priority?: number;
  priorityClassName?: string;
  securityContext?: SecurityContext;
  hostname?: string;
  subdomain?: string;
  enableServiceLinks?: boolean;
  preemptionPolicy?: string;
}

export interface ContainerStateWaiting { reason?: string; message?: string }
export interface ContainerStateRunning { startedAt: string }
export interface ContainerStateTerminated {
  exitCode: number;
  reason?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  containerID?: string;
}
export interface ContainerState {
  waiting?: ContainerStateWaiting;
  running?: ContainerStateRunning;
  terminated?: ContainerStateTerminated;
}

export interface ContainerStatus {
  name: string;
  image: string;
  imageID: string;
  containerID?: string;
  ready: boolean;
  started?: boolean;
  restartCount: number;
  state: ContainerState;
  lastState: ContainerState;
}

export interface Condition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
  lastProbeTime?: string | null;
  lastUpdateTime?: string;
}

export interface PodStatus {
  phase?: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown';
  conditions?: Condition[];
  message?: string;
  reason?: string;
  hostIP?: string;
  podIP?: string;
  podIPs?: { ip: string }[];
  startTime?: string;
  containerStatuses?: ContainerStatus[];
  initContainerStatuses?: ContainerStatus[];
  ephemeralContainerStatuses?: ContainerStatus[];
  qosClass?: 'Guaranteed' | 'Burstable' | 'BestEffort';
  nominatedNodeName?: string;
}

export interface Pod extends KubeObject {
  kind: 'Pod';
  spec: PodSpec;
  status: PodStatus;
}

export interface PodTemplateSpec {
  metadata: { labels?: Record<string, string>; annotations?: Record<string, string>; name?: string };
  spec: PodSpec;
}

export interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: { key: string; operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist'; values?: string[] }[];
}

export interface ReplicaSet extends KubeObject {
  kind: 'ReplicaSet';
  spec: { replicas?: number; selector: LabelSelector; template: PodTemplateSpec; minReadySeconds?: number };
  status: {
    replicas: number;
    fullyLabeledReplicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    observedGeneration?: number;
    conditions?: Condition[];
  };
}

export interface DeploymentStrategy {
  type?: 'RollingUpdate' | 'Recreate';
  rollingUpdate?: { maxSurge?: number | string; maxUnavailable?: number | string };
}

export interface Deployment extends KubeObject {
  kind: 'Deployment';
  spec: {
    replicas?: number;
    selector: LabelSelector;
    template: PodTemplateSpec;
    strategy?: DeploymentStrategy;
    minReadySeconds?: number;
    revisionHistoryLimit?: number;
    progressDeadlineSeconds?: number;
    paused?: boolean;
  };
  status: {
    observedGeneration?: number;
    replicas?: number;
    updatedReplicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    unavailableReplicas?: number;
    conditions?: Condition[];
  };
}

export interface DaemonSet extends KubeObject {
  kind: 'DaemonSet';
  spec: { selector: LabelSelector; template: PodTemplateSpec; updateStrategy?: { type?: string; rollingUpdate?: { maxUnavailable?: number | string } }; minReadySeconds?: number; revisionHistoryLimit?: number };
  status: {
    currentNumberScheduled: number;
    desiredNumberScheduled: number;
    numberMisscheduled: number;
    numberReady: number;
    numberAvailable?: number;
    numberUnavailable?: number;
    updatedNumberScheduled?: number;
    observedGeneration?: number;
  };
}

export interface Job extends KubeObject {
  kind: 'Job';
  spec: {
    template: PodTemplateSpec;
    completions?: number;
    parallelism?: number;
    backoffLimit?: number;
    activeDeadlineSeconds?: number;
    ttlSecondsAfterFinished?: number;
    completionMode?: 'NonIndexed' | 'Indexed';
    selector?: LabelSelector;
    manualSelector?: boolean;
    suspend?: boolean;
  };
  status: {
    active?: number;
    succeeded?: number;
    failed?: number;
    ready?: number;
    startTime?: string;
    completionTime?: string;
    conditions?: Condition[];
  };
}

export interface CronJob extends KubeObject {
  kind: 'CronJob';
  spec: {
    schedule: string;
    jobTemplate: { metadata?: Record<string, unknown>; spec: Job['spec'] };
    concurrencyPolicy?: 'Allow' | 'Forbid' | 'Replace';
    suspend?: boolean;
    successfulJobsHistoryLimit?: number;
    failedJobsHistoryLimit?: number;
    startingDeadlineSeconds?: number;
    timeZone?: string;
  };
  status: { active?: { name: string; namespace: string; uid?: string }[]; lastScheduleTime?: string; lastSuccessfulTime?: string };
}

export interface ServicePort {
  name?: string;
  protocol?: string;
  port: number;
  targetPort?: number | string;
  nodePort?: number;
  appProtocol?: string;
}

export interface Service extends KubeObject {
  kind: 'Service';
  spec: {
    type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer' | 'ExternalName';
    selector?: Record<string, string>;
    ports?: ServicePort[];
    clusterIP?: string;
    clusterIPs?: string[];
    externalName?: string;
    sessionAffinity?: string;
    ipFamilies?: string[];
    ipFamilyPolicy?: string;
    internalTrafficPolicy?: string;
    externalTrafficPolicy?: string;
    publishNotReadyAddresses?: boolean;
  };
  status: { loadBalancer?: { ingress?: { ip?: string; hostname?: string }[] } };
}

export interface Endpoints extends KubeObject {
  kind: 'Endpoints';
  subsets?: {
    addresses?: { ip: string; nodeName?: string; targetRef?: { kind: string; name: string; namespace: string; uid?: string } }[];
    notReadyAddresses?: { ip: string; nodeName?: string; targetRef?: { kind: string; name: string; namespace: string; uid?: string } }[];
    ports?: { name?: string; port: number; protocol?: string }[];
  }[];
}

export interface Node extends KubeObject {
  kind: 'Node';
  spec: { podCIDR?: string; podCIDRs?: string[]; taints?: Taint[]; unschedulable?: boolean; providerID?: string };
  status: {
    capacity: Record<string, string>;
    allocatable: Record<string, string>;
    conditions: Condition[];
    addresses: { type: string; address: string }[];
    nodeInfo: {
      kubeletVersion: string;
      kubeProxyVersion?: string;
      osImage: string;
      kernelVersion: string;
      containerRuntimeVersion: string;
      operatingSystem: string;
      architecture: string;
      machineID?: string;
      systemUUID?: string;
      bootID?: string;
    };
    images?: { names: string[]; sizeBytes?: number }[];
  };
}

export interface Namespace extends KubeObject {
  kind: 'Namespace';
  spec?: { finalizers?: string[] };
  status?: { phase: 'Active' | 'Terminating' };
}

export interface ConfigMap extends KubeObject {
  kind: 'ConfigMap';
  data?: Record<string, string>;
  binaryData?: Record<string, string>;
  immutable?: boolean;
}

export interface Secret extends KubeObject {
  kind: 'Secret';
  type?: string;
  data?: Record<string, string>;
  stringData?: Record<string, string>;
  immutable?: boolean;
}

export interface Event extends KubeObject {
  kind: 'Event';
  involvedObject: { kind: string; namespace?: string; name: string; uid?: string; apiVersion?: string; fieldPath?: string };
  reason: string;
  message: string;
  source: { component: string; host?: string };
  firstTimestamp: string;
  lastTimestamp: string;
  count: number;
  type: 'Normal' | 'Warning';
  reportingComponent?: string;
  reportingInstance?: string;
}

export interface StatefulSet extends KubeObject {
  kind: 'StatefulSet';
  spec: {
    replicas?: number;
    serviceName: string;
    selector: LabelSelector;
    template: PodTemplateSpec;
    volumeClaimTemplates?: PersistentVolumeClaim[];
    podManagementPolicy?: 'OrderedReady' | 'Parallel';
    updateStrategy?: { type?: 'RollingUpdate' | 'OnDelete'; rollingUpdate?: { partition?: number } };
    revisionHistoryLimit?: number;
    minReadySeconds?: number;
    persistentVolumeClaimRetentionPolicy?: { whenDeleted?: string; whenScaled?: string };
  };
  status: {
    replicas: number;
    readyReplicas?: number;
    availableReplicas?: number;
    currentReplicas?: number;
    updatedReplicas?: number;
    currentRevision?: string;
    updateRevision?: string;
    observedGeneration?: number;
    collisionCount?: number;
  };
}

export interface PersistentVolumeClaim extends KubeObject {
  kind: 'PersistentVolumeClaim';
  spec: { accessModes?: string[]; resources?: { requests?: Record<string, string> }; storageClassName?: string; volumeName?: string; volumeMode?: string };
  status?: { phase?: 'Pending' | 'Bound' | 'Lost'; accessModes?: string[]; capacity?: Record<string, string> };
}

export interface PersistentVolume extends KubeObject {
  kind: 'PersistentVolume';
  spec: {
    capacity?: Record<string, string>;
    accessModes?: string[];
    persistentVolumeReclaimPolicy?: 'Delete' | 'Retain' | 'Recycle';
    storageClassName?: string;
    volumeMode?: string;
    claimRef?: { kind: string; namespace: string; name: string; uid?: string; apiVersion?: string };
    csi?: { driver: string; volumeHandle: string; fsType?: string };
    hostPath?: { path: string };
  };
  status?: { phase?: 'Pending' | 'Available' | 'Bound' | 'Released' | 'Failed' };
}

export interface StorageClass extends KubeObject {
  kind: 'StorageClass';
  provisioner: string;
  reclaimPolicy?: 'Delete' | 'Retain';
  volumeBindingMode?: 'Immediate' | 'WaitForFirstConsumer';
  allowVolumeExpansion?: boolean;
  parameters?: Record<string, string>;
}

export interface IngressBackend { service?: { name: string; port?: { number?: number; name?: string } } }
export interface Ingress extends KubeObject {
  kind: 'Ingress';
  spec: {
    ingressClassName?: string;
    defaultBackend?: IngressBackend;
    tls?: { hosts?: string[]; secretName?: string }[];
    rules?: { host?: string; http?: { paths: { path?: string; pathType: 'Prefix' | 'Exact' | 'ImplementationSpecific'; backend: IngressBackend }[] } }[];
  };
  status?: { loadBalancer?: { ingress?: { ip?: string; hostname?: string }[] } };
}

export interface NetworkPolicyPeer { podSelector?: LabelSelector; namespaceSelector?: LabelSelector; ipBlock?: { cidr: string; except?: string[] } }
export interface NetworkPolicyPort { protocol?: string; port?: number | string; endPort?: number }
export interface NetworkPolicy extends KubeObject {
  kind: 'NetworkPolicy';
  spec: {
    podSelector: LabelSelector;
    policyTypes?: ('Ingress' | 'Egress')[];
    ingress?: { from?: NetworkPolicyPeer[]; ports?: NetworkPolicyPort[] }[];
    egress?: { to?: NetworkPolicyPeer[]; ports?: NetworkPolicyPort[] }[];
  };
}

export interface PolicyRule { apiGroups?: string[]; resources?: string[]; verbs: string[]; resourceNames?: string[]; nonResourceURLs?: string[] }
export interface Role extends KubeObject { kind: 'Role' | 'ClusterRole'; rules?: PolicyRule[] }
export interface RbacSubject { kind: 'User' | 'Group' | 'ServiceAccount'; name: string; namespace?: string; apiGroup?: string }
export interface RoleBinding extends KubeObject {
  kind: 'RoleBinding' | 'ClusterRoleBinding';
  roleRef: { apiGroup?: string; kind: 'Role' | 'ClusterRole'; name: string };
  subjects?: RbacSubject[];
}

export interface MetricSpec {
  type: 'Resource' | 'Pods' | 'Object' | 'External' | 'ContainerResource';
  resource?: { name: string; target: { type: 'Utilization' | 'AverageValue'; averageUtilization?: number; averageValue?: string } };
  pods?: { metric: { name: string }; target: { type: 'AverageValue'; averageValue?: string } };
}
export interface HorizontalPodAutoscaler extends KubeObject {
  kind: 'HorizontalPodAutoscaler';
  spec: {
    scaleTargetRef: { apiVersion?: string; kind: string; name: string };
    minReplicas?: number;
    maxReplicas: number;
    metrics?: MetricSpec[];
    behavior?: { scaleUp?: { stabilizationWindowSeconds?: number }; scaleDown?: { stabilizationWindowSeconds?: number } };
  };
  status: {
    currentReplicas?: number;
    desiredReplicas?: number;
    lastScaleTime?: string;
    currentMetrics?: { type: string; resource?: { name: string; current: { averageUtilization?: number; averageValue?: string } }; pods?: { metric: { name: string }; current: { averageValue?: string } } }[];
    conditions?: Condition[];
    observedGeneration?: number;
  };
}

export interface PodDisruptionBudget extends KubeObject {
  kind: 'PodDisruptionBudget';
  spec: { minAvailable?: number | string; maxUnavailable?: number | string; selector?: LabelSelector };
  status: { currentHealthy: number; desiredHealthy: number; disruptionsAllowed: number; expectedPods: number; observedGeneration?: number; conditions?: Condition[] };
}

export interface ResourceQuota extends KubeObject {
  kind: 'ResourceQuota';
  spec: { hard?: Record<string, string | number> };
  status?: { hard?: Record<string, string>; used?: Record<string, string> };
}

export interface LimitRangeItem { type: 'Container' | 'Pod' | 'PersistentVolumeClaim'; max?: Record<string, string>; min?: Record<string, string>; default?: Record<string, string>; defaultRequest?: Record<string, string>; maxLimitRequestRatio?: Record<string, string> }
export interface LimitRange extends KubeObject { kind: 'LimitRange'; spec: { limits: LimitRangeItem[] } }

export interface PriorityClass extends KubeObject { kind: 'PriorityClass'; value: number; globalDefault?: boolean; preemptionPolicy?: string; description?: string }

export interface CrdVersion {
  name: string;
  served?: boolean;
  storage?: boolean;
  schema?: { openAPIV3Schema?: JsonSchema };
  additionalPrinterColumns?: { name: string; type: string; jsonPath: string; priority?: number; description?: string }[];
  subresources?: Record<string, unknown>;
}
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  description?: string;
  'x-kubernetes-preserve-unknown-fields'?: boolean;
  additionalProperties?: JsonSchema | boolean;
  [extra: string]: unknown;
}
export interface CustomResourceDefinition extends KubeObject {
  kind: 'CustomResourceDefinition';
  spec: {
    group: string;
    scope: 'Namespaced' | 'Cluster';
    names: { kind: string; plural: string; singular?: string; shortNames?: string[]; categories?: string[]; listKind?: string };
    versions: CrdVersion[];
  };
  status?: { conditions?: Condition[]; acceptedNames?: Record<string, unknown>; storedVersions?: string[] };
}

export type AnyObject = Pod | ReplicaSet | Deployment | DaemonSet | Job | CronJob | Service | Endpoints | Node | Namespace | ConfigMap | Secret | Event | KubeObject;

export function isPod(o: KubeObject): o is Pod { return o.kind === 'Pod'; }
export function isDeployment(o: KubeObject): o is Deployment { return o.kind === 'Deployment'; }
export function isReplicaSet(o: KubeObject): o is ReplicaSet { return o.kind === 'ReplicaSet'; }
export function isService(o: KubeObject): o is Service { return o.kind === 'Service'; }
export function isNode(o: KubeObject): o is Node { return o.kind === 'Node'; }
