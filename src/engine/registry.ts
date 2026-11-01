/** Resource registry: kinds, API groups, plurals, short names — drives `kubectl` type resolution and `api-resources`. */

export interface ResourceInfo {
  kind: string;
  group: string; // '' for core
  version: string;
  plural: string;
  singular: string;
  shortNames: string[];
  namespaced: boolean;
  categories: string[];
  verbs: string[];
}

const ALL_VERBS = ['create', 'delete', 'deletecollection', 'get', 'list', 'patch', 'update', 'watch'];

const RESOURCES: ResourceInfo[] = [
  { kind: 'ConfigMap', group: '', version: 'v1', plural: 'configmaps', singular: 'configmap', shortNames: ['cm'], namespaced: true, categories: [], verbs: ALL_VERBS },
  { kind: 'Endpoints', group: '', version: 'v1', plural: 'endpoints', singular: 'endpoints', shortNames: ['ep'], namespaced: true, categories: [], verbs: ALL_VERBS },
  { kind: 'Event', group: '', version: 'v1', plural: 'events', singular: 'event', shortNames: ['ev'], namespaced: true, categories: [], verbs: ALL_VERBS },
  { kind: 'Namespace', group: '', version: 'v1', plural: 'namespaces', singular: 'namespace', shortNames: ['ns'], namespaced: false, categories: [], verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
  { kind: 'Node', group: '', version: 'v1', plural: 'nodes', singular: 'node', shortNames: ['no'], namespaced: false, categories: [], verbs: ALL_VERBS },
  { kind: 'Pod', group: '', version: 'v1', plural: 'pods', singular: 'pod', shortNames: ['po'], namespaced: true, categories: ['all'], verbs: ALL_VERBS },
  { kind: 'Secret', group: '', version: 'v1', plural: 'secrets', singular: 'secret', shortNames: [], namespaced: true, categories: [], verbs: ALL_VERBS },
  { kind: 'ServiceAccount', group: '', version: 'v1', plural: 'serviceaccounts', singular: 'serviceaccount', shortNames: ['sa'], namespaced: true, categories: [], verbs: ALL_VERBS },
  { kind: 'Service', group: '', version: 'v1', plural: 'services', singular: 'service', shortNames: ['svc'], namespaced: true, categories: ['all'], verbs: ALL_VERBS },
  { kind: 'DaemonSet', group: 'apps', version: 'v1', plural: 'daemonsets', singular: 'daemonset', shortNames: ['ds'], namespaced: true, categories: ['all'], verbs: ALL_VERBS },
  { kind: 'Deployment', group: 'apps', version: 'v1', plural: 'deployments', singular: 'deployment', shortNames: ['deploy'], namespaced: true, categories: ['all'], verbs: ALL_VERBS },
  { kind: 'ReplicaSet', group: 'apps', version: 'v1', plural: 'replicasets', singular: 'replicaset', shortNames: ['rs'], namespaced: true, categories: ['all'], verbs: ALL_VERBS },
  { kind: 'StatefulSet', group: 'apps', version: 'v1', plural: 'statefulsets', singular: 'statefulset', shortNames: ['sts'], namespaced: true, categories: ['all'], verbs: ALL_VERBS },
  { kind: 'CronJob', group: 'batch', version: 'v1', plural: 'cronjobs', singular: 'cronjob', shortNames: ['cj'], namespaced: true, categories: ['all'], verbs: ALL_VERBS },
  { kind: 'Job', group: 'batch', version: 'v1', plural: 'jobs', singular: 'job', shortNames: [], namespaced: true, categories: ['all'], verbs: ALL_VERBS },
  { kind: 'EndpointSlice', group: 'discovery.k8s.io', version: 'v1', plural: 'endpointslices', singular: 'endpointslice', shortNames: [], namespaced: true, categories: [], verbs: ALL_VERBS },
];

export function allResources(): ResourceInfo[] {
  return RESOURCES;
}

export function apiVersionOf(r: ResourceInfo): string {
  return r.group ? `${r.group}/${r.version}` : r.version;
}

/** Resolve a user-typed resource name (`po`, `pods`, `pod`, `deploy.apps`, `deployments.apps`) to its info. */
export function resolveResource(name: string): ResourceInfo | undefined {
  const lower = name.toLowerCase();
  // strip optional group suffix: `deployments.apps`, `deploy.v1.apps`
  const dot = lower.indexOf('.');
  const base = dot >= 0 ? lower.slice(0, dot) : lower;
  const group = dot >= 0 ? lower.slice(dot + 1) : undefined;
  const candidates = RESOURCES.filter(
    (r) => r.plural === base || r.singular === base || r.shortNames.includes(base) || r.kind.toLowerCase() === base,
  );
  if (candidates.length === 0) return undefined;
  if (group) {
    const g = candidates.find((r) => group === r.group || group === `${r.version}.${r.group}` || group === r.version);
    return g;
  }
  return candidates[0];
}

export function resourceByKind(kind: string): ResourceInfo | undefined {
  return RESOURCES.find((r) => r.kind === kind);
}

/** `kubectl` prints created/deleted objects as `deployment.apps/web` (core group has no suffix). */
export function qualifiedName(kind: string, name: string): string {
  const r = resourceByKind(kind);
  if (!r) return `${kind.toLowerCase()}/${name}`;
  return r.group ? `${r.singular}.${r.group}/${name}` : `${r.singular}/${name}`;
}
