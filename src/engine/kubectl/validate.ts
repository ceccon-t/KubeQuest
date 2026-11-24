/** Admission-time validation with upstream-identical error strings. */
import type { KubeObject, PodSpec, Container, Probe } from '../types.ts';
import { resourceByKind, resolveResource, apiVersionOf } from '../registry.ts';
import { parseQuantity, parseMemoryBytes, parseCpuMillis } from '../duration.ts';
import { fromLabelSelector, matches } from '../selector.ts';
import { checkCel } from '../cel.ts';
import { KubectlError } from './args.ts';

export class ValidationError extends Error {}

const DNS1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const SUBDOMAIN_MSG = `a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character (e.g. 'example.com', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*')`;
const LABEL_MSG = `a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character (e.g. 'my-name',  or '123-abc', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?')`;

// Known fields per schema type (subset). Unknown fields are rejected like the OpenAPI validator does.
const SCHEMA: Record<string, string[]> = {
  ObjectMeta: ['name', 'namespace', 'labels', 'annotations', 'generateName', 'ownerReferences', 'finalizers', 'uid', 'resourceVersion', 'creationTimestamp', 'generation', 'deletionTimestamp', 'deletionGracePeriodSeconds', 'managedFields', 'selfLink'],
  PodSpec: ['containers', 'initContainers', 'ephemeralContainers', 'volumes', 'restartPolicy', 'terminationGracePeriodSeconds', 'activeDeadlineSeconds', 'dnsPolicy', 'dnsConfig', 'nodeSelector', 'nodeName', 'affinity', 'tolerations', 'serviceAccountName', 'serviceAccount', 'automountServiceAccountToken', 'securityContext', 'imagePullSecrets', 'hostname', 'subdomain', 'schedulerName', 'priorityClassName', 'priority', 'hostNetwork', 'hostPID', 'hostIPC', 'shareProcessNamespace', 'enableServiceLinks', 'preemptionPolicy', 'overhead', 'topologySpreadConstraints', 'runtimeClassName', 'readinessGates', 'setHostnameAsFQDN', 'os', 'hostUsers', 'schedulingGates', 'resourceClaims', 'hostAliases'],
  Container: ['name', 'image', 'imagePullPolicy', 'command', 'args', 'workingDir', 'ports', 'env', 'envFrom', 'resources', 'volumeMounts', 'volumeDevices', 'livenessProbe', 'readinessProbe', 'startupProbe', 'lifecycle', 'terminationMessagePath', 'terminationMessagePolicy', 'securityContext', 'stdin', 'stdinOnce', 'tty', 'resizePolicy', 'restartPolicy'],
  Probe: ['httpGet', 'tcpSocket', 'exec', 'grpc', 'initialDelaySeconds', 'periodSeconds', 'timeoutSeconds', 'successThreshold', 'failureThreshold', 'terminationGracePeriodSeconds'],
  ResourceRequirements: ['limits', 'requests', 'claims'],
  ContainerPort: ['name', 'containerPort', 'hostPort', 'hostIP', 'protocol'],
  EnvVar: ['name', 'value', 'valueFrom'],
  DeploymentSpec: ['replicas', 'selector', 'template', 'strategy', 'minReadySeconds', 'revisionHistoryLimit', 'paused', 'progressDeadlineSeconds'],
  ReplicaSetSpec: ['replicas', 'selector', 'template', 'minReadySeconds'],
  DaemonSetSpec: ['selector', 'template', 'updateStrategy', 'minReadySeconds', 'revisionHistoryLimit'],
  JobSpec: ['parallelism', 'completions', 'activeDeadlineSeconds', 'podFailurePolicy', 'successPolicy', 'backoffLimit', 'backoffLimitPerIndex', 'maxFailedIndexes', 'selector', 'manualSelector', 'template', 'ttlSecondsAfterFinished', 'completionMode', 'suspend', 'podReplacementPolicy', 'managedBy'],
  CronJobSpec: ['schedule', 'timeZone', 'startingDeadlineSeconds', 'concurrencyPolicy', 'suspend', 'jobTemplate', 'successfulJobsHistoryLimit', 'failedJobsHistoryLimit'],
  ServiceSpec: ['ports', 'selector', 'clusterIP', 'clusterIPs', 'type', 'externalIPs', 'sessionAffinity', 'loadBalancerIP', 'loadBalancerSourceRanges', 'externalName', 'externalTrafficPolicy', 'healthCheckNodePort', 'publishNotReadyAddresses', 'sessionAffinityConfig', 'ipFamilies', 'ipFamilyPolicy', 'allocateLoadBalancerNodePorts', 'loadBalancerClass', 'internalTrafficPolicy', 'trafficDistribution'],
  ServicePort: ['name', 'protocol', 'appProtocol', 'port', 'targetPort', 'nodePort'],
  PodTemplateSpec: ['metadata', 'spec'],
  StatefulSetSpec: ['replicas', 'selector', 'template', 'volumeClaimTemplates', 'serviceName', 'podManagementPolicy', 'updateStrategy', 'revisionHistoryLimit', 'minReadySeconds', 'persistentVolumeClaimRetentionPolicy', 'ordinals'],
  IngressSpec: ['ingressClassName', 'defaultBackend', 'tls', 'rules'],
  NetworkPolicySpec: ['podSelector', 'ingress', 'egress', 'policyTypes'],
  PersistentVolumeClaimSpec: ['accessModes', 'selector', 'resources', 'volumeName', 'storageClassName', 'volumeMode', 'dataSource', 'dataSourceRef', 'volumeAttributesClassName'],
  HorizontalPodAutoscalerSpec: ['scaleTargetRef', 'minReplicas', 'maxReplicas', 'metrics', 'behavior'],
  PodDisruptionBudgetSpec: ['minAvailable', 'selector', 'maxUnavailable', 'unhealthyPodEvictionPolicy'],
  SecurityContext: ['capabilities', 'privileged', 'seLinuxOptions', 'windowsOptions', 'runAsUser', 'runAsGroup', 'runAsNonRoot', 'readOnlyRootFilesystem', 'allowPrivilegeEscalation', 'procMount', 'seccompProfile', 'appArmorProfile'],
  PodSecurityContext: ['seLinuxOptions', 'windowsOptions', 'runAsUser', 'runAsGroup', 'runAsNonRoot', 'supplementalGroups', 'supplementalGroupsPolicy', 'fsGroup', 'sysctls', 'fsGroupChangePolicy', 'seccompProfile', 'appArmorProfile', 'seLinuxChangePolicy'],
  VolumeMount: ['name', 'readOnly', 'recursiveReadOnly', 'mountPath', 'subPath', 'mountPropagation', 'subPathExpr'],
  LabelSelector: ['matchLabels', 'matchExpressions'],
  DeploymentStrategy: ['type', 'rollingUpdate'],
};

const SCHEMA_PKG: Record<string, string> = {
  ObjectMeta: 'io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta', PodSpec: 'io.k8s.api.core.v1.PodSpec', Container: 'io.k8s.api.core.v1.Container', Probe: 'io.k8s.api.core.v1.Probe',
  ResourceRequirements: 'io.k8s.api.core.v1.ResourceRequirements', ContainerPort: 'io.k8s.api.core.v1.ContainerPort', EnvVar: 'io.k8s.api.core.v1.EnvVar', DeploymentSpec: 'io.k8s.api.apps.v1.DeploymentSpec',
  ReplicaSetSpec: 'io.k8s.api.apps.v1.ReplicaSetSpec', DaemonSetSpec: 'io.k8s.api.apps.v1.DaemonSetSpec', JobSpec: 'io.k8s.api.batch.v1.JobSpec', CronJobSpec: 'io.k8s.api.batch.v1.CronJobSpec',
  StatefulSetSpec: 'io.k8s.api.apps.v1.StatefulSetSpec', IngressSpec: 'io.k8s.api.networking.v1.IngressSpec', NetworkPolicySpec: 'io.k8s.api.networking.v1.NetworkPolicySpec', PersistentVolumeClaimSpec: 'io.k8s.api.core.v1.PersistentVolumeClaimSpec',
  HorizontalPodAutoscalerSpec: 'io.k8s.api.autoscaling.v2.HorizontalPodAutoscalerSpec', PodDisruptionBudgetSpec: 'io.k8s.api.policy.v1.PodDisruptionBudgetSpec', SecurityContext: 'io.k8s.api.core.v1.SecurityContext', PodSecurityContext: 'io.k8s.api.core.v1.PodSecurityContext', VolumeMount: 'io.k8s.api.core.v1.VolumeMount',
  ServiceSpec: 'io.k8s.api.core.v1.ServiceSpec', ServicePort: 'io.k8s.api.core.v1.ServicePort', PodTemplateSpec: 'io.k8s.api.core.v1.PodTemplateSpec', LabelSelector: 'io.k8s.apimachinery.pkg.apis.meta.v1.LabelSelector', DeploymentStrategy: 'io.k8s.api.apps.v1.DeploymentStrategy',
};

function unknownField(kind: string, path: string, field: string, schema: string): never {
  throw new ValidationError(`error validating data: ValidationError(${kind}.${path}): unknown field "${field}" in ${SCHEMA_PKG[schema] ?? schema}; if you choose to ignore these errors, turn validation off with --validate=false`);
}

function checkFields(kind: string, path: string, obj: unknown, schema: string): void {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  const allowed = SCHEMA[schema];
  if (!allowed) return;
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) unknownField(kind, path, k, schema);
}

function checkContainers(kind: string, path: string, containers: unknown): void {
  if (!Array.isArray(containers)) return;
  containers.forEach((c, i) => {
    checkFields(kind, `${path}[${i}]`, c, 'Container');
    const cc = c as Container;
    for (const pk of ['livenessProbe', 'readinessProbe', 'startupProbe'] as const) if (cc[pk]) checkFields(kind, `${path}[${i}].${pk}`, cc[pk], 'Probe');
    if (cc.resources) checkFields(kind, `${path}[${i}].resources`, cc.resources, 'ResourceRequirements');
    if (Array.isArray(cc.ports)) cc.ports.forEach((p, j) => checkFields(kind, `${path}[${i}].ports[${j}]`, p, 'ContainerPort'));
    if (Array.isArray(cc.env)) cc.env.forEach((e, j) => checkFields(kind, `${path}[${i}].env[${j}]`, e, 'EnvVar'));
    if (cc.securityContext) checkFields(kind, `${path}[${i}].securityContext`, cc.securityContext, 'SecurityContext');
    if (Array.isArray(cc.volumeMounts)) cc.volumeMounts.forEach((m, j) => checkFields(kind, `${path}[${i}].volumeMounts[${j}]`, m, 'VolumeMount'));
  });
}

function checkPodSpec(kind: string, path: string, spec: unknown): void {
  checkFields(kind, path, spec, 'PodSpec');
  const s = spec as PodSpec;
  checkContainers(kind, `${path}.containers`, s?.containers);
  checkContainers(kind, `${path}.initContainers`, s?.initContainers);
  if (s?.securityContext) checkFields(kind, `${path}.securityContext`, s.securityContext, 'PodSecurityContext');
}

/** Structural validation (unknown/missing fields) — produces `error validating data` errors. */
export function validateStructure(obj: KubeObject, source: string): void {
  const kind = obj.kind;
  checkFields(kind, 'metadata', obj.metadata, 'ObjectMeta');
  const spec = obj.spec as Record<string, unknown> | undefined;
  switch (kind) {
    case 'Pod':
      checkPodSpec(kind, 'spec', spec);
      break;
    case 'Ingress': case 'NetworkPolicy': case 'PersistentVolumeClaim': case 'HorizontalPodAutoscaler': case 'PodDisruptionBudget':
      checkFields(kind, 'spec', spec, `${kind}Spec`);
      break;
    case 'Deployment':
    case 'ReplicaSet':
    case 'StatefulSet':
    case 'DaemonSet': {
      checkFields(kind, 'spec', spec, `${kind}Spec`);
      if (spec?.template) { checkFields(kind, 'spec.template', spec.template, 'PodTemplateSpec'); checkPodSpec(kind, 'spec.template.spec', (spec.template as { spec?: unknown }).spec); }
      if (spec?.selector) checkFields(kind, 'spec.selector', spec.selector, 'LabelSelector');
      if (kind === 'Deployment' && spec?.strategy) checkFields(kind, 'spec.strategy', spec.strategy, 'DeploymentStrategy');
      break;
    }
    case 'Job':
      checkFields(kind, 'spec', spec, 'JobSpec');
      if (spec?.template) checkPodSpec(kind, 'spec.template.spec', (spec.template as { spec?: unknown }).spec);
      break;
    case 'CronJob':
      checkFields(kind, 'spec', spec, 'CronJobSpec');
      if (spec?.jobTemplate) {
        const js = (spec.jobTemplate as { spec?: Record<string, unknown> }).spec;
        checkFields(kind, 'spec.jobTemplate.spec', js, 'JobSpec');
        if (js?.template) checkPodSpec(kind, 'spec.jobTemplate.spec.template.spec', (js.template as { spec?: unknown }).spec);
      }
      break;
    case 'Service':
      checkFields(kind, 'spec', spec, 'ServiceSpec');
      if (Array.isArray(spec?.ports)) (spec.ports as unknown[]).forEach((p, i) => checkFields(kind, `spec.ports[${i}]`, p, 'ServicePort'));
      break;
    default:
      break;
  }
  void source;
}

function invalid(kind: string, name: string, errs: string[]): never {
  throw new ValidationError(`${kind} "${name}" is invalid: ${errs.length === 1 ? errs[0] : `[${errs.join(', ')}]`}`);
}

function validateContainers(path: string, containers: Container[] | undefined, errs: string[], required = true): void {
  if (!containers || !Array.isArray(containers) || containers.length === 0) {
    if (required) errs.push(`${path}: Required value`);
    return;
  }
  const names = new Set<string>();
  containers.forEach((c, i) => {
    if (!c.name) errs.push(`${path}[${i}].name: Required value`);
    else if (!DNS1123_LABEL.test(c.name)) errs.push(`${path}[${i}].name: Invalid value: "${c.name}": ${LABEL_MSG}`);
    else if (names.has(c.name)) errs.push(`${path}[${i}].name: Duplicate value: "${c.name}"`);
    names.add(c.name);
    if (!c.image) errs.push(`${path}[${i}].image: Required value`);
    const probeCheck = (p: Probe | undefined, pn: string) => {
      if (!p) return;
      if (p.httpGet && (p.httpGet.port === undefined || p.httpGet.port === null)) errs.push(`${path}[${i}].${pn}.httpGet.port: Required value`);
      if (p.tcpSocket && p.tcpSocket.port === undefined) errs.push(`${path}[${i}].${pn}.tcpSocket.port: Required value`);
      if (!p.httpGet && !p.tcpSocket && !p.exec && !(p as { grpc?: unknown }).grpc) errs.push(`${path}[${i}].${pn}: Required value: must specify a handler type`);
      for (const f of ['initialDelaySeconds', 'periodSeconds', 'timeoutSeconds', 'failureThreshold', 'successThreshold'] as const) {
        const v = p[f];
        if (v !== undefined && (typeof v !== 'number' || v < 0)) errs.push(`${path}[${i}].${pn}.${f}: Invalid value: ${v}: must be greater than or equal to 0`);
      }
    };
    probeCheck(c.livenessProbe, 'livenessProbe');
    probeCheck(c.readinessProbe, 'readinessProbe');
    probeCheck(c.startupProbe, 'startupProbe');
    const res = c.resources ?? {};
    for (const [section, vals] of Object.entries({ requests: res.requests, limits: res.limits })) {
      for (const [k, v] of Object.entries(vals ?? {})) {
        try { parseQuantity(v); } catch (e) { errs.push(`${path}[${i}].resources.${section}[${k}]: Invalid value: "${v}": ${(e as Error).message}`); }
      }
    }
    if (res.requests?.memory !== undefined && res.limits?.memory !== undefined) {
      try { if (parseMemoryBytes(res.requests.memory) > parseMemoryBytes(res.limits.memory)) errs.push(`${path}[${i}].resources.requests: Invalid value: "${res.requests.memory}": must be less than or equal to memory limit of ${res.limits.memory}`); } catch { /* reported above */ }
    }
    if (res.requests?.cpu !== undefined && res.limits?.cpu !== undefined) {
      try { if (parseCpuMillis(res.requests.cpu) > parseCpuMillis(res.limits.cpu)) errs.push(`${path}[${i}].resources.requests: Invalid value: "${res.requests.cpu}": must be less than or equal to cpu limit of ${res.limits.cpu}`); } catch { /* reported above */ }
    }
    for (const [j, p] of (c.ports ?? []).entries()) {
      if (typeof p.containerPort !== 'number' || p.containerPort < 1 || p.containerPort > 65535) errs.push(`${path}[${i}].ports[${j}].containerPort: Invalid value: ${p.containerPort}: must be between 1 and 65535, inclusive`);
    }
  });
}

function validatePodSpec(path: string, spec: PodSpec | undefined, errs: string[], allowedRestart: string[] = ['Always', 'OnFailure', 'Never']): void {
  if (!spec) { errs.push(`${path}: Required value`); return; }
  validateContainers(`${path}.containers`, spec.containers, errs);
  validateContainers(`${path}.initContainers`, spec.initContainers, errs, false);
  if (spec.restartPolicy && !allowedRestart.includes(spec.restartPolicy)) errs.push(`${path}.restartPolicy: Unsupported value: "${spec.restartPolicy}": supported values: ${allowedRestart.map((v) => `"${v}"`).join(', ')}`);
}

function validateLabels(path: string, labels: Record<string, string> | undefined, errs: string[]): void {
  for (const [k, v] of Object.entries(labels ?? {})) {
    if (!/^([a-z0-9A-Z]([-a-z0-9A-Z_.]*[a-z0-9A-Z])?\/)?[a-z0-9A-Z]([-a-z0-9A-Z_.]*[a-z0-9A-Z])?$/.test(k)) errs.push(`${path}: Invalid value: "${k}": name part must consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character`);
    if (typeof v !== 'string' || (v !== '' && !/^[a-z0-9A-Z]([-a-z0-9A-Z_.]*[a-z0-9A-Z])?$/.test(v)) || String(v).length > 63) errs.push(`${path}: Invalid value: "${v}": a valid label must be an empty string or consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyValue',  or 'my_value',  or '12345', regex used for validation is '(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?')`);
  }
}

/** Semantic validation — produces `The Kind "name" is invalid:` errors. */
/** Every field the manifest states is already so in the live object (which also carries defaults the manifest omits). */
function isSubset(want: unknown, live: unknown): boolean {
  if (Array.isArray(want)) return Array.isArray(live) && live.length === want.length && want.every((w, i) => isSubset(w, live[i]));
  if (want && typeof want === 'object') {
    if (!live || typeof live !== 'object' || Array.isArray(live)) return Object.keys(want).length === 0;
    return Object.entries(want as Record<string, unknown>).every(([k, v]) => v === null || v === undefined || isSubset(v, (live as Record<string, unknown>)[k]));
  }
  return want === live || String(want) === String(live);
}

export function validateObject(obj: KubeObject, existing?: KubeObject): void {
  const kind = obj.kind;
  const errs: string[] = [];
  const name = obj.metadata?.name ?? '';
  if (!obj.metadata || !name) {
    if (!obj.metadata?.generateName) errs.push('metadata.name: Required value: name or generateName is required');
  } else if (!DNS1123_SUBDOMAIN.test(name)) {
    errs.push(`metadata.name: Invalid value: "${name}": ${SUBDOMAIN_MSG}`);
  }
  if (obj.metadata?.labels) validateLabels('metadata.labels', obj.metadata.labels, errs);
  const spec = obj.spec as Record<string, unknown> | undefined;
  switch (kind) {
    case 'Pod': {
      validatePodSpec('spec', spec as unknown as PodSpec, errs);
      break;
    }
    case 'Deployment':
    case 'ReplicaSet':
    case 'StatefulSet':
    case 'DaemonSet': {
      if (!spec) { errs.push('spec: Required value'); break; }
      const selector = spec.selector as { matchLabels?: Record<string, string>; matchExpressions?: unknown[] } | undefined;
      const template = spec.template as { metadata?: { labels?: Record<string, string> }; spec?: PodSpec } | undefined;
      if (!selector || (!selector.matchLabels && !selector.matchExpressions)) errs.push('spec.selector: Required value');
      else if (Object.keys(selector.matchLabels ?? {}).length === 0 && !(selector.matchExpressions?.length)) errs.push('spec.selector: Invalid value: v1.LabelSelector{MatchLabels:map[string]string(nil), MatchExpressions:[]v1.LabelSelectorRequirement(nil)}: empty selector is invalid for deployment');
      if (!template) errs.push('spec.template: Required value');
      else {
        validateLabels('spec.template.metadata.labels', template.metadata?.labels, errs);
        if (selector && (selector.matchLabels || selector.matchExpressions)) {
          const reqs = fromLabelSelector(selector as never);
          if (!matches(reqs, template.metadata?.labels)) {
            const lbl = template.metadata?.labels ?? {};
            const goMap = `map[string]string{${Object.entries(lbl).map(([k, v]) => `"${k}":"${v}"`).join(', ')}}`;
            errs.push(`spec.template.metadata.labels: Invalid value: ${goMap}: \`selector\` does not match template \`labels\``);
          }
        }
        validatePodSpec('spec.template.spec', template.spec, errs, kind === 'DaemonSet' ? ['Always'] : ['Always']);
      }
      if (spec.replicas !== undefined && (typeof spec.replicas !== 'number' || spec.replicas < 0 || !Number.isInteger(spec.replicas))) errs.push(`spec.replicas: Invalid value: ${spec.replicas}: must be greater than or equal to 0`);
      if (existing && kind === 'StatefulSet') {
        // upstream: apps/validation ValidateStatefulSetUpdate — everything but a handful of fields is immutable
        const frozen = (x: Record<string, unknown> | undefined) => JSON.stringify({ selector: x?.selector, serviceName: x?.serviceName, podManagementPolicy: x?.podManagementPolicy ?? 'OrderedReady', vct: ((x?.volumeClaimTemplates ?? []) as { metadata?: { name?: string }; spec?: { accessModes?: unknown; resources?: unknown; storageClassName?: unknown } }[]).map((t) => [t.metadata?.name, t.spec?.accessModes, t.spec?.resources, t.spec?.storageClassName ?? null]) });
        if (frozen(existing.spec as Record<string, unknown>) !== frozen(spec)) { errs.push("spec: Forbidden: updates to statefulset spec for fields other than 'replicas', 'ordinals', 'template', 'updateStrategy', 'persistentVolumeClaimRetentionPolicy' and 'minReadySeconds' are forbidden"); break; }
      }
      if (existing && selector && JSON.stringify(existing.spec && (existing.spec as Record<string, unknown>).selector) !== JSON.stringify(selector)) {
        const ml = selector.matchLabels ?? {};
        errs.push(`spec.selector: Invalid value: v1.LabelSelector{MatchLabels:map[string]string{${Object.entries(ml).map(([k, v]) => `"${k}":"${v}"`).join(', ')}}, MatchExpressions:[]v1.LabelSelectorRequirement(nil)}: field is immutable`);
      }
      break;
    }
    case 'Job': {
      if (!spec) { errs.push('spec: Required value'); break; }
      const template = spec.template as { spec?: PodSpec } | undefined;
      if (!template) errs.push('spec.template: Required value');
      else validatePodSpec('spec.template.spec', template.spec, errs, ['OnFailure', 'Never']);
      // upstream: batch/validation ValidateJobUpdate — spec.template is immutable. The real message dumps the whole
      // Go struct (core.PodTemplateSpec{ObjectMeta:…, Spec:…}); it is abbreviated here, the rest is verbatim.
      if (existing && template && !isSubset(template, (existing.spec as Record<string, unknown> | undefined)?.template)) errs.push('spec.template: Invalid value: core.PodTemplateSpec{…}: field is immutable');
      break;
    }
    case 'CronJob': {
      if (!spec) { errs.push('spec: Required value'); break; }
      if (!spec.schedule) errs.push('spec.schedule: Required value');
      const jt = spec.jobTemplate as { spec?: { template?: { spec?: PodSpec } } } | undefined;
      if (!jt?.spec) errs.push('spec.jobTemplate.spec: Required value');
      else validatePodSpec('spec.jobTemplate.spec.template.spec', jt.spec.template?.spec, errs, ['OnFailure', 'Never']);
      break;
    }
    case 'Service': {
      if (!spec) { errs.push('spec: Required value'); break; }
      const type = (spec.type as string | undefined) ?? 'ClusterIP';
      if (!['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName'].includes(type)) errs.push(`spec.type: Unsupported value: "${type}": supported values: "ClusterIP", "ExternalName", "LoadBalancer", "NodePort"`);
      const ports = spec.ports as { name?: string; port?: number; targetPort?: unknown; nodePort?: number; protocol?: string }[] | undefined;
      if (type !== 'ExternalName' && spec.clusterIP !== 'None' && (!ports || ports.length === 0)) errs.push('spec.ports: Required value');
      (ports ?? []).forEach((p, i) => {
        if (p.port === undefined) errs.push(`spec.ports[${i}].port: Required value`);
        else if (typeof p.port !== 'number' || p.port < 1 || p.port > 65535) errs.push(`spec.ports[${i}].port: Invalid value: ${p.port}: must be between 1 and 65535, inclusive`);
        if ((ports as unknown[]).length > 1 && !p.name) errs.push(`spec.ports[${i}].name: Required value`);
        if (p.protocol && !['TCP', 'UDP', 'SCTP'].includes(p.protocol)) errs.push(`spec.ports[${i}].protocol: Unsupported value: "${p.protocol}": supported values: "SCTP", "TCP", "UDP"`);
        if (p.nodePort !== undefined && (p.nodePort < 30000 || p.nodePort > 32767)) errs.push(`spec.ports[${i}].nodePort: Invalid value: ${p.nodePort}: provided port is not in the valid range. The range of valid ports is 30000-32767`);
      });
      if (spec.selector) validateLabels('spec.selector', spec.selector as Record<string, string>, errs);
      break;
    }
    case 'Ingress': {
      if (!spec) { errs.push('spec: Required value'); break; }
      const rules = (spec.rules ?? []) as { http?: { paths?: { path?: string; pathType?: string; backend?: { service?: { name?: string; port?: { number?: number; name?: string } } } }[] } }[];
      if (!rules.length && !spec.defaultBackend) errs.push('spec: Invalid value: []networking.IngressRule(nil): either `defaultBackend` or `rules` must be specified');
      rules.forEach((r, i) => (r.http?.paths ?? []).forEach((p, j) => {
        const at = `spec.rules[${i}].http.paths[${j}]`;
        if (!p.pathType) errs.push(`${at}.pathType: Required value: pathType must be specified`);
        else if (!['Exact', 'Prefix', 'ImplementationSpecific'].includes(p.pathType)) errs.push(`${at}.pathType: Unsupported value: "${p.pathType}": supported values: "Exact", "ImplementationSpecific", "Prefix"`);
        if ((p.pathType === 'Exact' || p.pathType === 'Prefix') && !(p.path ?? '').startsWith('/')) errs.push(`${at}.path: Invalid value: "${p.path ?? ''}": must be an absolute path`);
        if (!p.backend?.service?.name) errs.push(`${at}.backend.service.name: Required value`);
        else if (p.backend.service.port?.number === undefined && !p.backend.service.port?.name) errs.push(`${at}.backend: Invalid value: "": cannot set both port name & port number`.replace('Invalid value: "": cannot set both port name & port number', 'Required value: port name or number is required'));
      }));
      break;
    }
    case 'NetworkPolicy': {
      if (!spec) { errs.push('spec: Required value'); break; }
      for (const [i, t] of ((spec.policyTypes ?? []) as string[]).entries()) if (t !== 'Ingress' && t !== 'Egress') errs.push(`spec.policyTypes[${i}]: Unsupported value: "${t}": supported values: "Egress", "Ingress"`);
      break;
    }
    case 'PersistentVolumeClaim': {
      if (!spec) { errs.push('spec: Required value'); break; }
      const modes = (spec.accessModes ?? []) as string[];
      if (!modes.length) errs.push('spec.accessModes: Required value: at least 1 access mode is required');
      for (const m of modes) if (!['ReadWriteOnce', 'ReadOnlyMany', 'ReadWriteMany', 'ReadWriteOncePod'].includes(m)) errs.push(`spec.accessModes: Unsupported value: "${m}": supported values: "ReadOnlyMany", "ReadWriteMany", "ReadWriteOnce", "ReadWriteOncePod"`);
      const storage = (spec.resources as { requests?: Record<string, string> } | undefined)?.requests?.storage;
      if (storage === undefined) errs.push('spec.resources[storage]: Required value');
      else { try { parseQuantity(storage); } catch (e) { errs.push(`spec.resources[storage]: Invalid value: "${storage}": ${(e as Error).message}`); } }
      if (existing) {
        const old = (existing.spec ?? {}) as Record<string, unknown>;
        // Defaulted fields the manifest may omit are not changes; everything else but the size is immutable.
        // A class that the previous `kubectl apply` set and this one drops IS a change (the three-way patch removes it).
        // upstream appends a Go diff of core.PersistentVolumeClaimSpec to this message; that part is not reproduced.
        let appliedClass: unknown;
        try { appliedClass = (JSON.parse(existing.metadata.annotations?.['kubectl.kubernetes.io/last-applied-configuration'] ?? '{}') as { spec?: { storageClassName?: unknown } }).spec?.storageClassName; } catch { appliedClass = undefined; }
        const norm = (x: Record<string, unknown>) => JSON.stringify({ accessModes: x.accessModes, storageClassName: x.storageClassName ?? (x !== old && appliedClass !== undefined ? null : old.storageClassName), volumeMode: x.volumeMode ?? 'Filesystem', selector: x.selector });
        if (norm(old) !== norm(spec)) errs.push('spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims');
      }
      break;
    }
    case 'HorizontalPodAutoscaler': {
      if (!spec) { errs.push('spec: Required value'); break; }
      const ref = spec.scaleTargetRef as { kind?: string; name?: string } | undefined;
      if (!ref?.kind) errs.push('spec.scaleTargetRef.kind: Required value');
      if (!ref?.name) errs.push('spec.scaleTargetRef.name: Required value');
      const min = (spec.minReplicas as number | undefined) ?? 1, max = spec.maxReplicas as number | undefined;
      if (max === undefined || max < 1) errs.push(`spec.maxReplicas: Invalid value: ${max ?? 0}: must be greater than 0`);
      else if (max < min) errs.push(`spec.maxReplicas: Invalid value: ${max}: must be greater than or equal to \`minReplicas\``);
      break;
    }
    case 'PodDisruptionBudget': {
      if (!spec) { errs.push('spec: Required value'); break; }
      if (spec.minAvailable !== undefined && spec.maxUnavailable !== undefined) errs.push('spec: Invalid value: "": minAvailable and maxUnavailable cannot be both set');
      break;
    }
    case 'Role': case 'ClusterRole': {
      ((obj.rules ?? []) as { verbs?: string[]; apiGroups?: string[]; resources?: string[]; nonResourceURLs?: string[] }[]).forEach((r, i) => {
        if (!r.verbs?.length) errs.push(`rules[${i}].verbs: Required value: verbs must contain at least one value`);
        if (!r.nonResourceURLs?.length) {
          if (!r.apiGroups?.length) errs.push(`rules[${i}].apiGroups: Required value: resource rules must supply at least one api group`);
          if (!r.resources?.length) errs.push(`rules[${i}].resources: Required value: resource rules must supply at least one resource`);
        }
      });
      break;
    }
    case 'RoleBinding': case 'ClusterRoleBinding': {
      const ref = obj.roleRef as { kind?: string; name?: string } | undefined;
      if (!ref?.name) errs.push('roleRef.name: Required value');
      if (ref && !['Role', 'ClusterRole'].includes(ref.kind ?? '')) errs.push(`roleRef.kind: Unsupported value: "${ref.kind ?? ''}": supported values: "ClusterRole", "Role"`);
      else if (kind === 'ClusterRoleBinding' && ref?.kind === 'Role') errs.push('roleRef.kind: Unsupported value: "Role": supported values: "ClusterRole"');
      if (existing && JSON.stringify(existing.roleRef) !== JSON.stringify(ref)) errs.push(`roleRef: Invalid value: rbac.RoleRef{APIGroup:"rbac.authorization.k8s.io", Kind:"${ref?.kind ?? ''}", Name:"${ref?.name ?? ''}"}: cannot change roleRef`);
      ((obj.subjects ?? []) as { kind?: string; name?: string; namespace?: string }[]).forEach((sub, i) => {
        if (!sub.name) errs.push(`subjects[${i}].name: Required value`);
        if (!['User', 'Group', 'ServiceAccount'].includes(sub.kind ?? '')) errs.push(`subjects[${i}].kind: Unsupported value: "${sub.kind ?? ''}": supported values: "ServiceAccount", "User", "Group"`);
        else if (sub.kind === 'ServiceAccount' && kind === 'ClusterRoleBinding' && !sub.namespace) errs.push(`subjects[${i}].namespace: Required value`);
      });
      break;
    }
    case 'PriorityClass':
      if (typeof obj.value !== 'number') errs.push('value: Required value');
      break;
    case 'ValidatingAdmissionPolicy': {
      ((spec?.validations ?? []) as { expression?: string }[]).forEach((v, i) => {
        if (!v.expression) { errs.push(`spec.validations[${i}].expression: Required value: expression is not specified`); return; }
        try { checkCel(v.expression); } catch (e) { errs.push(`spec.validations[${i}].expression: Invalid value: ${JSON.stringify(v.expression)}: compilation failed: ERROR: <input>: ${(e as Error).message}`); }
      });
      break;
    }
    case 'Namespace':
      if (name && !DNS1123_LABEL.test(name)) { errs.length = 0; errs.push(`metadata.name: Invalid value: "${name}": ${LABEL_MSG}`); }
      break;
    default:
      break;
  }
  if (errs.length) invalid(kind, name, errs);
}

/** Resolve apiVersion/kind of a manifest to the registry; error message like kubectl's RESTMapper. */
export function resolveKind(obj: KubeObject, source: string): { kind: string; apiVersion: string } {
  const kind = obj.kind;
  const apiVersion = obj.apiVersion;
  if (!kind || !apiVersion) throw new KubectlError(`error validating "${source}": error validating data: ${!apiVersion ? 'apiVersion not set' : 'kind not set'}; if you choose to ignore these errors, turn validation off with --validate=false`);
  const r = resolveResource(String(kind)) ?? resourceByKind(String(kind));
  if (!r || r.kind !== kind || apiVersionOf(r) !== apiVersion) {
    throw new KubectlError(`resource mapping not found for name: "${obj.metadata?.name ?? ''}" namespace: "${obj.metadata?.namespace ?? ''}" from "${source}": no matches for kind "${kind}" in version "${apiVersion}"\nensure CRDs are installed first`);
  }
  return { kind: r.kind, apiVersion };
}
