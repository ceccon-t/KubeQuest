/** RBAC: identities, the authorizer and the bootstrap roles every cluster ships with. upstream: plugin/pkg/auth/authorizer/rbac */
import type { Engine } from './engine.ts';
import type { Role, RoleBinding, PolicyRule, RbacSubject, KubeObject } from './types.ts';

export interface UserInfo { name: string; groups: string[] }

/** The player's kubeconfig user: a member of system:masters, which bypasses RBAC like on a real cluster. */
export const ADMIN: UserInfo = { name: 'oncall', groups: ['system:masters', 'system:authenticated'] };

export function serviceAccountUser(namespace: string, name: string): UserInfo {
  return { name: `system:serviceaccount:${namespace}:${name}`, groups: ['system:serviceaccounts', `system:serviceaccounts:${namespace}`, 'system:authenticated'] };
}

/** Identity for `--as` / `--as-group` impersonation. */
export function userFor(as: string | undefined, asGroups: string[]): UserInfo {
  if (!as) return ADMIN;
  const m = /^system:serviceaccount:([^:]+):([^:]+)$/.exec(as);
  if (m) { const u = serviceAccountUser(m[1] as string, m[2] as string); return { name: u.name, groups: [...u.groups, ...asGroups] }; }
  return { name: as, groups: ['system:authenticated', ...asGroups] };
}

export interface AccessRequest {
  verb: string;
  /** API group ('' for core). */
  group: string;
  /** Plural resource name, e.g. `pods`. */
  resource: string;
  subresource?: string;
  namespace?: string;
  name?: string;
}

function ruleAllows(rule: PolicyRule, req: AccessRequest): boolean {
  if (!rule.verbs.includes('*') && !rule.verbs.includes(req.verb)) return false;
  const groups = rule.apiGroups ?? [];
  if (!groups.includes('*') && !groups.includes(req.group)) return false;
  const resources = rule.resources ?? [];
  const full = req.subresource ? `${req.resource}/${req.subresource}` : req.resource;
  if (!resources.includes('*') && !resources.includes(full) && !(req.subresource && resources.includes(`*/${req.subresource}`))) return false;
  if (rule.resourceNames?.length) return req.name !== undefined && rule.resourceNames.includes(req.name);
  return true;
}

function subjectMatches(s: RbacSubject, user: UserInfo, bindingNamespace: string | undefined): boolean {
  switch (s.kind) {
    case 'User': return s.name === user.name;
    case 'Group': return user.groups.includes(s.name);
    case 'ServiceAccount': return user.name === `system:serviceaccount:${s.namespace ?? bindingNamespace ?? ''}:${s.name}`;
    default: return false;
  }
}

/** Rules that apply to a user in a namespace (undefined = cluster scope only). */
export function rulesFor(engine: Engine, user: UserInfo, namespace: string | undefined): PolicyRule[] {
  const out: PolicyRule[] = [];
  for (const crb of engine.store.list<RoleBinding>('ClusterRoleBinding')) {
    if (!(crb.subjects ?? []).some((s) => subjectMatches(s, user, undefined))) continue;
    out.push(...(engine.store.get<Role>('ClusterRole', undefined, crb.roleRef.name)?.rules ?? []));
  }
  if (namespace !== undefined) {
    for (const rb of engine.store.list<RoleBinding>('RoleBinding', namespace)) {
      if (!(rb.subjects ?? []).some((s) => subjectMatches(s, user, namespace))) continue;
      const role = rb.roleRef.kind === 'ClusterRole' ? engine.store.get<Role>('ClusterRole', undefined, rb.roleRef.name) : engine.store.get<Role>('Role', namespace, rb.roleRef.name);
      out.push(...(role?.rules ?? []));
    }
  }
  return out;
}

export function authorize(engine: Engine, user: UserInfo, req: AccessRequest): boolean {
  if (user.groups.includes('system:masters')) return true;
  return rulesFor(engine, user, req.namespace).some((r) => ruleAllows(r, req));
}

/** upstream: k8s.io/apiserver/pkg/endpoints/handlers/responsewriters.Forbidden */
export function forbiddenMessage(user: UserInfo, req: AccessRequest): string {
  const qualified = req.group ? `${req.resource}.${req.group}` : req.resource;
  const full = req.subresource ? `${req.resource}/${req.subresource}` : req.resource;
  const scope = req.namespace !== undefined ? `in the namespace "${req.namespace}"` : 'at the cluster scope';
  return `${qualified}${req.name ? ` "${req.name}"` : ''} is forbidden: User "${user.name}" cannot ${req.verb} resource "${full}" in API group "${req.group}" ${scope}`;
}

const READ = ['get', 'list', 'watch'];
const WRITE = ['create', 'delete', 'deletecollection', 'patch', 'update'];
const VIEW_CORE = ['configmaps', 'endpoints', 'persistentvolumeclaims', 'persistentvolumeclaims/status', 'pods', 'replicationcontrollers', 'replicationcontrollers/scale', 'serviceaccounts', 'services', 'services/status', 'bindings', 'events', 'limitranges', 'namespaces/status', 'pods/log', 'pods/status', 'replicationcontrollers/status', 'resourcequotas', 'resourcequotas/status', 'namespaces'];
const VIEW_APPS = ['controllerrevisions', 'daemonsets', 'daemonsets/status', 'deployments', 'deployments/scale', 'deployments/status', 'replicasets', 'replicasets/scale', 'replicasets/status', 'statefulsets', 'statefulsets/scale', 'statefulsets/status'];
const EDIT_CORE = ['configmaps', 'events', 'persistentvolumeclaims', 'replicationcontrollers', 'replicationcontrollers/scale', 'secrets', 'serviceaccounts', 'services', 'services/proxy', 'pods', 'pods/attach', 'pods/exec', 'pods/portforward', 'pods/proxy'];
const EDIT_APPS = ['daemonsets', 'deployments', 'deployments/rollback', 'deployments/scale', 'replicasets', 'replicasets/scale', 'statefulsets', 'statefulsets/scale'];

function viewRules(): PolicyRule[] {
  return [
    { apiGroups: [''], resources: VIEW_CORE, verbs: READ },
    { apiGroups: ['apps'], resources: VIEW_APPS, verbs: READ },
    { apiGroups: ['autoscaling'], resources: ['horizontalpodautoscalers', 'horizontalpodautoscalers/status'], verbs: READ },
    { apiGroups: ['batch'], resources: ['cronjobs', 'cronjobs/status', 'jobs', 'jobs/status'], verbs: READ },
    { apiGroups: ['discovery.k8s.io'], resources: ['endpointslices'], verbs: READ },
    { apiGroups: ['networking.k8s.io'], resources: ['ingresses', 'ingresses/status', 'networkpolicies'], verbs: READ },
    { apiGroups: ['policy'], resources: ['poddisruptionbudgets', 'poddisruptionbudgets/status'], verbs: READ },
  ];
}
function editRules(): PolicyRule[] {
  return [
    ...viewRules(),
    { apiGroups: [''], resources: ['pods/attach', 'pods/exec', 'pods/portforward', 'pods/proxy', 'secrets', 'services/proxy'], verbs: READ },
    { apiGroups: [''], resources: ['serviceaccounts'], verbs: ['impersonate'] },
    { apiGroups: [''], resources: EDIT_CORE, verbs: WRITE },
    { apiGroups: [''], resources: ['serviceaccounts/token'], verbs: ['create'] },
    { apiGroups: ['apps'], resources: EDIT_APPS, verbs: WRITE },
    { apiGroups: ['autoscaling'], resources: ['horizontalpodautoscalers'], verbs: WRITE },
    { apiGroups: ['batch'], resources: ['cronjobs', 'jobs'], verbs: WRITE },
    { apiGroups: ['networking.k8s.io'], resources: ['ingresses', 'networkpolicies'], verbs: WRITE },
    { apiGroups: ['policy'], resources: ['poddisruptionbudgets'], verbs: WRITE },
  ];
}

/** ClusterRoles/bindings created by the API server on first start (kubernetes.io/bootstrapping=rbac-defaults). */
export function bootstrapRbac(): KubeObject[] {
  const meta = (name: string) => ({ name, labels: { 'kubernetes.io/bootstrapping': 'rbac-defaults' }, annotations: { 'rbac.authorization.kubernetes.io/autoupdate': 'true' } });
  const cr = (name: string, rules: PolicyRule[]): KubeObject => ({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: meta(name), rules });
  return [
    cr('cluster-admin', [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }, { nonResourceURLs: ['*'], verbs: ['*'] }]),
    cr('admin', [...editRules(), { apiGroups: ['rbac.authorization.k8s.io'], resources: ['rolebindings', 'roles'], verbs: [...WRITE, ...READ] }, { apiGroups: ['authorization.k8s.io'], resources: ['localsubjectaccessreviews'], verbs: ['create'] }]),
    cr('edit', editRules()),
    cr('view', viewRules()),
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: meta('cluster-admin'), roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' }, subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'system:masters' }] },
  ];
}
