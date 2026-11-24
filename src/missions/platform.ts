/**
 * Platform add-ons that Orbital's clusters have installed (as real clusters do): ingress-nginx, the Gateway API
 * CRDs with Envoy Gateway, Argo CD, storage classes — plus builders for the objects missions create with them.
 */
import type { KubeObject, JsonSchema, Container, PodSpec } from '../engine/types.ts';
import type { ContainerBehaviour } from '../engine/images.ts';
import { makeCertPem, makeKeyPem } from '../engine/encoding.ts';

type Seed = { ageSeconds: number; object: KubeObject };
const AGE = 14 * 86400;

// --- tiny schema DSL for CRDs -------------------------------------------------
export const S = {
  str: (extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'string', ...extra }),
  int: (extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'integer', ...extra }),
  bool: (): JsonSchema => ({ type: 'boolean' }),
  obj: (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties, ...(required.length ? { required } : {}) }),
  arr: (items: JsonSchema): JsonSchema => ({ type: 'array', items }),
  map: (): JsonSchema => ({ type: 'object', additionalProperties: { type: 'string' } }),
  any: (): JsonSchema => ({ type: 'object', 'x-kubernetes-preserve-unknown-fields': true }),
};

export function crd(o: { group: string; kind: string; plural: string; singular?: string; shortNames?: string[]; scope?: 'Namespaced' | 'Cluster'; version: string; spec: JsonSchema; columns?: { name: string; type: string; jsonPath: string; priority?: number }[]; categories?: string[] }): KubeObject {
  return {
    apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition',
    metadata: { name: `${o.plural}.${o.group}` },
    spec: {
      group: o.group, scope: o.scope ?? 'Namespaced',
      names: { kind: o.kind, listKind: `${o.kind}List`, plural: o.plural, singular: o.singular ?? o.kind.toLowerCase(), ...(o.shortNames ? { shortNames: o.shortNames } : {}), ...(o.categories ? { categories: o.categories } : {}) },
      versions: [{ name: o.version, served: true, storage: true, schema: { openAPIV3Schema: S.obj({ apiVersion: S.str(), kind: S.str(), metadata: { type: 'object' }, spec: o.spec, status: S.any() }) }, ...(o.columns ? { additionalPrinterColumns: o.columns } : {}), subresources: { status: {} } }],
    },
  };
}

// --- ingress-nginx ------------------------------------------------------------
export const NGINX_IMAGE = 'registry.k8s.io/ingress-nginx/controller:v1.12.0';

/** ingress-nginx as its Helm chart installs it: IngressClass `nginx`, controller Deployment, LoadBalancer Service. */
export function ingressNginx(): Seed[] {
  const labels = { 'app.kubernetes.io/component': 'controller', 'app.kubernetes.io/instance': 'ingress-nginx', 'app.kubernetes.io/name': 'ingress-nginx' };
  return [
    { ageSeconds: AGE, object: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'ingress-nginx', labels: { 'app.kubernetes.io/name': 'ingress-nginx' } } } },
    { ageSeconds: AGE, object: { apiVersion: 'networking.k8s.io/v1', kind: 'IngressClass', metadata: { name: 'nginx', labels: { 'app.kubernetes.io/component': 'controller' } }, spec: { controller: 'k8s.io/ingress-nginx' } } },
    { ageSeconds: AGE, object: { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'ingress-nginx-controller', namespace: 'ingress-nginx', labels }, spec: { replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: { containers: [{ name: 'controller', image: NGINX_IMAGE, ports: [{ name: 'http', containerPort: 80, protocol: 'TCP' }, { name: 'https', containerPort: 443, protocol: 'TCP' }], readinessProbe: { httpGet: { path: '/healthz', port: 10254 }, periodSeconds: 5 } }] } } }, status: {} } },
    { ageSeconds: AGE, object: { apiVersion: 'v1', kind: 'Service', metadata: { name: 'ingress-nginx-controller', namespace: 'ingress-nginx', labels }, spec: { type: 'LoadBalancer', selector: labels, ports: [{ name: 'http', port: 80, targetPort: 'http', protocol: 'TCP' }, { name: 'https', port: 443, targetPort: 'https', protocol: 'TCP' }] }, status: {} } },
  ];
}

// --- Gateway API + Envoy Gateway ------------------------------------------------
const GW = 'gateway.networking.k8s.io';
const cond = (type: string): string => `.status.conditions[?(@.type=="${type}")].status`;

/** The standard-channel Gateway API CRDs (v1.2) with the fields people write by hand. */
export function gatewayApiCrds(): Seed[] {
  const parentRef = S.obj({ group: S.str(), kind: S.str(), name: S.str(), namespace: S.str(), sectionName: S.str(), port: S.int() }, ['name']);
  const backendRef = S.obj({ group: S.str(), kind: S.str(), name: S.str(), namespace: S.str(), port: S.int({ minimum: 1, maximum: 65535 }), weight: S.int({ minimum: 0, maximum: 1000000 }) }, ['name']);
  const list: KubeObject[] = [
    crd({ group: GW, kind: 'GatewayClass', plural: 'gatewayclasses', shortNames: ['gc'], scope: 'Cluster', version: 'v1', categories: ['gateway-api'],
      spec: S.obj({ controllerName: S.str(), description: S.str(), parametersRef: S.any() }, ['controllerName']),
      columns: [{ name: 'Controller', type: 'string', jsonPath: '.spec.controllerName' }, { name: 'Accepted', type: 'string', jsonPath: cond('Accepted') }, { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' }, { name: 'Description', type: 'string', jsonPath: '.spec.description', priority: 1 }] }),
    crd({ group: GW, kind: 'Gateway', plural: 'gateways', shortNames: ['gtw'], version: 'v1', categories: ['gateway-api'],
      spec: S.obj({ gatewayClassName: S.str(), addresses: S.arr(S.any()), infrastructure: S.any(), listeners: S.arr(S.obj({ name: S.str(), hostname: S.str(), port: S.int({ minimum: 1, maximum: 65535 }), protocol: S.str(), tls: S.obj({ mode: S.str({ enum: ['Terminate', 'Passthrough'] }), certificateRefs: S.arr(S.obj({ group: S.str(), kind: S.str(), name: S.str(), namespace: S.str() }, ['name'])), options: S.map() }), allowedRoutes: S.obj({ namespaces: S.obj({ from: S.str({ enum: ['All', 'Selector', 'Same'] }), selector: S.any() }), kinds: S.arr(S.any()) }) }, ['name', 'port', 'protocol'])) }, ['gatewayClassName', 'listeners']),
      columns: [{ name: 'Class', type: 'string', jsonPath: '.spec.gatewayClassName' }, { name: 'Address', type: 'string', jsonPath: '.status.addresses[0].value' }, { name: 'Programmed', type: 'string', jsonPath: cond('Programmed') }, { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' }] }),
    crd({ group: GW, kind: 'HTTPRoute', plural: 'httproutes', version: 'v1', categories: ['gateway-api'],
      spec: S.obj({ parentRefs: S.arr(parentRef), hostnames: S.arr(S.str()), rules: S.arr(S.obj({ name: S.str(), matches: S.arr(S.obj({ path: S.obj({ type: S.str({ enum: ['Exact', 'PathPrefix', 'RegularExpression'] }), value: S.str() }), headers: S.arr(S.any()), queryParams: S.arr(S.any()), method: S.str() })), filters: S.arr(S.any()), backendRefs: S.arr(backendRef), timeouts: S.any() })) }),
      columns: [{ name: 'Hostnames', type: 'string', jsonPath: '.spec.hostnames' }, { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' }] }),
    crd({ group: GW, kind: 'ReferenceGrant', plural: 'referencegrants', shortNames: ['refgrant'], version: 'v1beta1', categories: ['gateway-api'], spec: S.obj({ from: S.arr(S.any()), to: S.arr(S.any()) }, ['from', 'to']), columns: [{ name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' }] }),
  ];
  return list.map((object) => ({ ageSeconds: AGE, object }));
}

export const ENVOY_GATEWAY_IMAGE = 'docker.io/envoyproxy/gateway:v1.2.6';

/** Envoy Gateway (control plane) and its GatewayClass `eg`. */
export function envoyGateway(): Seed[] {
  const labels = { 'app.kubernetes.io/instance': 'eg', 'app.kubernetes.io/name': 'gateway-helm', 'control-plane': 'envoy-gateway' };
  return [
    ...gatewayApiCrds(),
    { ageSeconds: AGE, object: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'envoy-gateway-system' } } },
    { ageSeconds: AGE, object: { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'envoy-gateway', namespace: 'envoy-gateway-system', labels }, spec: { replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: { containers: [{ name: 'envoy-gateway', image: ENVOY_GATEWAY_IMAGE }] } } }, status: {} } },
    { ageSeconds: AGE - 60, object: { apiVersion: `${GW}/v1`, kind: 'GatewayClass', metadata: { name: 'eg' }, spec: { controllerName: 'gateway.envoyproxy.io/gatewayclass-controller' } } },
  ];
}

// --- Argo CD --------------------------------------------------------------------
export const ARGOCD_IMAGE = 'quay.io/argoproj/argocd:v3.0.6';
export const ARGO_IMAGES: Record<string, ContainerBehaviour> = {
  [ARGOCD_IMAGE]: { ports: [8082], memoryMiB: 180, cpuMillis: 40, startMs: 1500, sizeBytes: 160_000_000, controller: 'argocd', hasShell: false, user: 999, logs: { start: ['time="2026-10-05T09:00:01Z" level=info msg="ArgoCD Application Controller is starting" built="2026-06-11T10:12:03Z" version=v3.0.6', 'time="2026-10-05T09:00:02Z" level=info msg="Starting configmap/secret informers"', 'time="2026-10-05T09:00:03Z" level=info msg="appResyncPeriod=20s, appHardResyncPeriod=0s"'], loop: ['time="…" level=info msg="Reconciliation completed" application=argocd/freight'], loopEveryMs: 20000 }, description: 'Argo CD application controller.' },
};

/** Argo CD's Application CRD and the application controller (the part that reconciles; no UI, no CLI). */
export function argoCd(): Seed[] {
  const labels = { 'app.kubernetes.io/name': 'argocd-application-controller', 'app.kubernetes.io/part-of': 'argocd' };
  return [
    { ageSeconds: AGE, object: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'argocd' } } },
    { ageSeconds: AGE, object: crd({ group: 'argoproj.io', kind: 'Application', plural: 'applications', shortNames: ['app', 'apps'], version: 'v1alpha1',
      spec: S.obj({ project: S.str(), source: S.obj({ repoURL: S.str(), path: S.str(), targetRevision: S.str(), kustomize: S.any(), helm: S.any(), directory: S.any() }, ['repoURL']), destination: S.obj({ server: S.str(), name: S.str(), namespace: S.str() }), syncPolicy: S.obj({ automated: S.obj({ prune: S.bool(), selfHeal: S.bool(), allowEmpty: S.bool() }), syncOptions: S.arr(S.str()), retry: S.any() }), ignoreDifferences: S.arr(S.any()), revisionHistoryLimit: S.int() }, ['destination', 'project']),
      columns: [{ name: 'Sync Status', type: 'string', jsonPath: '.status.sync.status' }, { name: 'Health Status', type: 'string', jsonPath: '.status.health.status' }, { name: 'Revision', type: 'string', jsonPath: '.status.sync.revision', priority: 10 }, { name: 'Project', type: 'string', jsonPath: '.spec.project', priority: 10 }] }) },
    { ageSeconds: AGE, object: { apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: { name: 'argocd-application-controller', namespace: 'argocd', labels }, spec: { serviceName: 'argocd-application-controller', replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: { containers: [{ name: 'argocd-application-controller', image: ARGOCD_IMAGE }] } } }, status: { replicas: 0 } } },
  ];
}

// --- storage, TLS, workloads -----------------------------------------------------
export function storageClass(name: string, o: { isDefault?: boolean; provisioner?: string; bindingMode?: 'Immediate' | 'WaitForFirstConsumer'; reclaimPolicy?: 'Delete' | 'Retain' } = {}): Seed {
  return { ageSeconds: AGE, object: { apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name, ...(o.isDefault ? { annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } } : {}) }, provisioner: o.provisioner ?? 'rook-ceph.rbd.csi.ceph.com', reclaimPolicy: o.reclaimPolicy ?? 'Delete', volumeBindingMode: o.bindingMode ?? 'Immediate', allowVolumeExpansion: true } };
}

/** A certificate + key pair as files (simulated X.509: see engine/encoding.ts). */
export function tlsPair(commonName: string, o: { sans?: string[]; issuer?: string; notAfter?: string } = {}): { crt: string; key: string } {
  return { crt: makeCertPem({ subject: `CN=${commonName}`, sans: o.sans ?? [commonName], issuer: o.issuer ?? 'CN=Orbital Internal CA', notAfter: o.notAfter ?? '2027-10-05T00:00:00Z' }), key: makeKeyPem(`CN=${commonName}`) };
}

export function workloadPod(o: { name: string; ns: string; labels: Record<string, string>; containers: Container[]; spec?: Partial<PodSpec> }): KubeObject {
  return { apiVersion: 'v1', kind: 'Pod', metadata: { name: o.name, namespace: o.ns, labels: o.labels }, spec: { containers: o.containers, ...(o.spec ?? {}) }, status: {} };
}
