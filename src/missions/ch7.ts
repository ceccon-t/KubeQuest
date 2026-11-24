/** Chapter 7 — Delivery and extension: Kustomize, Helm, GitOps, CRDs and operators. */
import type { Mission, ObjectiveContext } from '../game/mission.ts';
import { ORBITAL_IMAGES, REG, deployment, service, orbitalNodes, systemWorkloads, usedCmd, outputHad } from './lib.ts';
import { argoCd, ARGO_IMAGES, crd, S } from './platform.ts';
import type { ConfigMap, Deployment, KubeObject, Secret, Service } from '../engine/types.ts';
import type { OperatorSpec } from '../engine/controllers/crd.ts';
import { authorize, serviceAccountUser } from '../engine/rbac.ts';
import { gitRemote, remoteCommit } from '../engine/git.ts';
import { stringify, type YamlValue } from '../engine/yaml.ts';

const ns = (name: string, labels: Record<string, string> = {}): { ageSeconds: number; object: KubeObject } => ({ ageSeconds: 30 * 86400, object: { apiVersion: 'v1', kind: 'Namespace', metadata: { name, labels } } });
const stderrHad = (c: ObjectiveContext, re: RegExp): boolean => c.history.some((h) => re.test(h.stderr));
const image = (d: Deployment | undefined): string => d?.spec.template.spec.containers[0]?.image ?? '';
interface AppStatus { sync?: { status?: string }; health?: { status?: string }; conditions?: { type: string; message: string }[] }
interface AppSpec { syncPolicy?: { automated?: { prune?: boolean; selfHeal?: boolean } } }
const app = (c: ObjectiveContext, name: string): (KubeObject & { spec?: AppSpec; status?: AppStatus }) | undefined => c.view.get('Application', 'argocd', name);
const appGreen = (c: ObjectiveContext, name: string): boolean => { const a = app(c, name); return a?.status?.sync?.status === 'Synced' && a.status.health?.status === 'Healthy'; };
const headFile = (c: ObjectiveContext, url: string, path: string): string => { const r = gitRemote(c.engine, url); return r?.commits[r.commits.length - 1]?.tree[path] ?? ''; };

// ---------------------------------------------------------------------------
// 7.1 Kustomize
// ---------------------------------------------------------------------------

const K_BASE = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- deployment.yaml
- service.yaml
configMapGenerator:
- name: frontend-config
  literals:
  - LOG_LEVEL=info
`;
const K_DEPLOY = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  labels:
    app: frontend
spec:
  replicas: 1
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      containers:
      - name: frontend
        image: ${REG}/frontend:1.4.1
        ports:
        - containerPort: 8080
        envFrom:
        - configMapRef:
            name: frontend-config
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
          periodSeconds: 5
`;
const K_SVC = `apiVersion: v1
kind: Service
metadata:
  name: frontend
spec:
  selector:
    app: frontend
  ports:
  - port: 80
    targetPort: 8080
`;
const K_STAGING = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: freight-staging
resources:
- ../../base
labels:
- pairs:
    env: staging
`;
const K_PROD = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: freight-prod
resources:
- ../../base
labels:
- pairs:
    env: prod
images:
- name: ${REG}/frontend
  newTag: 1.6.0
replicas:
- name: frontend
  count: 3
configMapGenerator:
- name: frontend-config
  behavior: merge
  literals:
  - LOG_LEVEL=warn
`;
const generatedConfig = (c: ObjectiveContext, nsName: string): ConfigMap | undefined => {
  const ref = c.view.deployment(nsName, 'frontend')?.spec.template.spec.containers[0]?.envFrom?.[0]?.configMapRef?.name ?? '';
  return /^frontend-config-[a-z0-9]{10}$/.test(ref) ? c.view.get<ConfigMap>('ConfigMap', nsName, ref) : undefined;
};

export const m7_1: Mission = {
  id: '7.1', chapter: 7, order: 1, title: 'One base, many environments', tagline: 'Kustomize overlays instead of copy-pasted YAML.',
  ticket: {
    from: 'Platform (Liang)', priority: 'P3', subject: 'Stop copy-pasting manifests between staging and prod',
    body: [
      'Last week prod got staging\'s image tag because someone copied the wrong folder. We are moving the frontend to Kustomize: one base in ~/deploy/base, one small overlay per environment. Staging is done (~/deploy/overlays/staging) — render it, then apply it.',
      'Write the prod overlay in ~/deploy/overlays/prod: namespace `freight-prod`, label `env: prod`, 3 replicas, image tag `1.6.0`, and `LOG_LEVEL=warn` (the base generates the ConfigMap with `info`).',
      'No edits to the base files, no templating. Stay on after it is live — support may want a log-level change.',
    ],
  },
  concepts: [
    { title: 'Base and overlays', body: 'A **kustomization.yaml** lists `resources` and the changes to make to them. A **base** holds the plain manifests; an **overlay** points at the base (`resources: [../../base]`) and states only what differs: `namespace`, `labels`, `images`, `replicas`, `patches`. No template language — the output is ordinary YAML.', example: 'kubectl kustomize deploy/overlays/staging   # render\nkubectl apply -k deploy/overlays/staging     # render + apply' },
    { title: 'Transformers you use daily', body: '`images` rewrites a tag without touching the Deployment file; `replicas` sets counts by name; `labels` adds labels; `namespace` moves everything. For anything else, `patches` merges a partial manifest over the base one.', example: 'images:\n- name: registry.orbital.local/freight/frontend\n  newTag: 1.6.0\nreplicas:\n- name: frontend\n  count: 3' },
    { title: 'Generated ConfigMaps roll Pods', body: '`configMapGenerator` builds a ConfigMap and appends a hash of its content to the name (`frontend-config-7m2k…`), rewriting every reference. Change a value and the name changes, so the Deployment\'s Pod template changes — a rollout happens without `rollout restart`. An overlay adjusts a base generator with `behavior: merge`.', example: 'configMapGenerator:\n- name: frontend-config\n  behavior: merge\n  literals:\n  - LOG_LEVEL=warn' },
  ],
  cluster: { seed: 81, nodes: orbitalNodes(), namespaces: ['freight-staging', 'freight-prod'], images: ORBITAL_IMAGES, objects: [...systemWorkloads()] },
  files: { 'deploy/base/kustomization.yaml': K_BASE, 'deploy/base/deployment.yaml': K_DEPLOY, 'deploy/base/service.yaml': K_SVC, 'deploy/overlays/staging/kustomization.yaml': K_STAGING },
  objectives: [
    { id: 'render', text: 'Render the staging overlay without applying it', check: (c) => c.history.some((h) => /^(kubectl|k) (kustomize\b|apply .*--dry-run)/.test(h.line) && /namespace: freight-staging/.test(h.stdout)) },
    { id: 'staging', text: 'Staging is deployed from its overlay', check: (c) => c.view.deploymentReady('freight-staging', 'frontend', 1) && !!generatedConfig(c, 'freight-staging') },
    { id: 'prod', text: 'Prod overlay: freight-prod, env=prod, 3 replicas on 1.6.0, ready', check: (c) => { const d = c.view.deployment('freight-prod', 'frontend'); return !!d && d.metadata.labels?.env === 'prod' && image(d) === `${REG}/frontend:1.6.0` && c.view.deploymentReady('freight-prod', 'frontend', 3); } },
    { id: 'config', text: 'Prod runs with LOG_LEVEL=warn from a generated ConfigMap; the base is untouched', check: (c) => generatedConfig(c, 'freight-prod')?.data?.LOG_LEVEL === 'warn' && generatedConfig(c, 'freight-staging')?.data?.LOG_LEVEL === 'info' && c.view.deploymentReady('freight-prod', 'frontend', 3) },
    { id: 'debug', text: 'Support needs LOG_LEVEL=debug in prod: change the overlay and apply — the Pods must pick it up', revealAfter: 'config', check: (c) => { const pods = c.view.readyPods('freight-prod', 'app=frontend'); return c.flags.has('debug-request') && generatedConfig(c, 'freight-prod')?.data?.LOG_LEVEL === 'debug' && pods.length === 3 && pods.every((p) => c.engine.podRuntime(p).containers[0]?.env.LOG_LEVEL === 'debug'); } },
  ],
  chaos: [{ id: 'debug-request', at: { afterObjective: 'config', delaySeconds: 6 }, action: { type: 'flag', flag: 'debug-request' }, announce: { from: 'Support (Imani)', text: 'We are chasing a customer issue in prod. Can you switch the frontend to LOG_LEVEL=debug for a while?' } }],
  hints: [
    { text: '`kubectl kustomize deploy/overlays/staging` prints what the overlay produces; `kubectl apply -k deploy/overlays/staging` applies it. Look at the ConfigMap name in the output.', cost: 100 },
    { text: 'Create deploy/overlays/prod/kustomization.yaml: `namespace: freight-prod`, `resources: [../../base]`, `labels: [{pairs: {env: prod}}]`, `images: [{name: registry.orbital.local/freight/frontend, newTag: 1.6.0}]`, `replicas: [{name: frontend, count: 3}]`.', cost: 150 },
    { text: 'For the log level add `configMapGenerator: [{name: frontend-config, behavior: merge, literals: [LOG_LEVEL=warn]}]`, then `kubectl apply -k deploy/overlays/prod`. Later change `warn` to `debug` and apply again: a new ConfigMap name, and a rollout by itself.', cost: 150 },
  ],
  par: { timeSec: 480, commands: 12 }, timeLimitSec: 900,
  solution: [
    'cat deploy/base/kustomization.yaml deploy/overlays/staging/kustomization.yaml',
    'kubectl kustomize deploy/overlays/staging',
    'kubectl apply -k deploy/overlays/staging',
    { edit: 'deploy/overlays/prod/kustomization.yaml', replace: [/^[\s\S]*$/, K_PROD] },
    'kubectl kustomize deploy/overlays/prod',
    'kubectl apply -k deploy/overlays/prod',
    'kubectl rollout status deployment/frontend -n freight-prod',
    'sleep 8',
    { edit: 'deploy/overlays/prod/kustomization.yaml', replace: ['LOG_LEVEL=warn', 'LOG_LEVEL=debug'] },
    'kubectl apply -k deploy/overlays/prod',
    'kubectl rollout status deployment/frontend -n freight-prod',
    'kubectl get configmaps -n freight-prod',
  ],
  debrief: { proTips: ['Old generated ConfigMaps pile up: `kubectl apply -k … --prune` with a label selector, or a GitOps controller with pruning, cleans them.', '`kubectl diff -k overlay/` shows what an apply would change — the review step before prod.', 'Kustomize and Helm combine well: render a vendor chart, then patch it with an overlay instead of forking the chart.'] },
};

// ---------------------------------------------------------------------------
// 7.2 Helm
// ---------------------------------------------------------------------------

const CHART = {
  'charts/notifier/Chart.yaml': 'apiVersion: v2\nname: notifier\ndescription: Shipment notification service\ntype: application\nversion: 0.3.0\nappVersion: "1.2.0"\n',
  'charts/notifier/values.yaml': `replicaCount: 1\n\nimage:\n  repository: ${REG}/notifier\n  # defaults to the chart's appVersion\n  tag: ""\n\nservice:\n  port: 80\n\nresources:\n  requests:\n    cpu: 50m\n    memory: 64Mi\n`,
  'charts/notifier/templates/_helpers.tpl': '{{- define "notifier.labels" -}}\napp.kubernetes.io/name: {{ .Chart.Name }}\napp.kubernetes.io/instance: {{ .Release.Name }}\n{{- end }}\n',
  'charts/notifier/templates/deployment.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Release.Name }}\n  labels:\n    {{- include "notifier.labels" . | nindent 4 }}\nspec:\n  replicas: {{ .Values.replicaCount }}\n  selector:\n    matchLabels:\n      {{- include "notifier.labels" . | nindent 6 }}\n  template:\n    metadata:\n      labels:\n        {{- include "notifier.labels" . | nindent 8 }}\n    spec:\n      containers:\n      - name: notifier\n        image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"\n        ports:\n        - containerPort: 8080\n        resources:\n          {{- toYaml .Values.resources | nindent 10 }}\n',
  'charts/notifier/templates/service.yaml': 'apiVersion: v1\nkind: Service\nmetadata:\n  name: {{ .Release.Name }}\n  labels:\n    {{- include "notifier.labels" . | nindent 4 }}\nspec:\n  selector:\n    {{- include "notifier.labels" . | nindent 4 }}\n  ports:\n  - port: {{ .Values.service.port }}\n    targetPort: 8080\n',
  'charts/notifier/templates/NOTES.txt': 'notifier {{ .Chart.AppVersion }} installed as release "{{ .Release.Name }}" in {{ .Release.Namespace }}.\nCheck it with: kubectl get pods -n {{ .Release.Namespace }} -l app.kubernetes.io/instance={{ .Release.Name }}\n',
  'charts/values-prod.yaml': 'replicaCount: 2\n\nresources:\n  requests:\n    cpu: 100m\n    memory: 128Mi\n',
};
const releases = (c: ObjectiveContext): Secret[] => c.view.list<Secret>('Secret', 'freight').filter((s) => s.type === 'helm.sh/release.v1' && s.metadata.labels?.name === 'notifier').sort((a, b) => Number(a.metadata.labels?.version) - Number(b.metadata.labels?.version));
const helmRan = (c: ObjectiveContext, sub: string): boolean => c.history.some((h) => new RegExp(`^helm ${sub}\\b`).test(h.line) && h.code === 0);
const notifierOn = (c: ObjectiveContext, tag: string): boolean => image(c.view.deployment('freight', 'notifier')) === `${REG}/notifier:${tag}` && c.view.deploymentReady('freight', 'notifier', 2);

export const m7_2: Mission = {
  id: '7.2', chapter: 7, order: 2, title: 'Charts and releases', tagline: 'Helm: install, upgrade, and the rollback you will need.',
  ticket: {
    from: 'Ana (team-notify)', priority: 'P2', subject: 'Install notifier from its Helm chart — and be ready for an upgrade today',
    body: [
      'The notifier now ships as a Helm chart: ~/charts/notifier. Install it as release `notifier` in namespace freight with the production values in ~/charts/values-prod.yaml (2 replicas, bigger requests).',
      'Have a look at what the chart renders before you install it; nobody here has read the templates.',
      'A new application version is due this afternoon. I will send the tag as soon as the build is out.',
    ],
  },
  concepts: [
    { title: 'Chart, values, release', body: 'A **chart** is a folder of templates plus default `values.yaml`. Helm renders the templates with your values into manifests and applies them as a named **release**. Every install, upgrade and rollback is a numbered **revision**, stored in the cluster as a Secret, so Helm knows what it deployed.', example: 'helm template notifier charts/notifier -f charts/values-prod.yaml\nhelm install notifier charts/notifier -n freight -f charts/values-prod.yaml' },
    { title: 'Upgrade and rollback', body: '`helm upgrade` renders again and applies the difference as a new revision; `helm history` lists revisions; `helm rollback RELEASE N` re-applies revision N as a new one. Helm reports `deployed` as soon as the API accepted the manifests — it does not wait for Pods unless you pass `--wait` (or `--atomic` to roll back automatically).', example: 'helm upgrade notifier charts/notifier -n freight --set image.tag=1.3.0\nhelm history notifier -n freight\nhelm rollback notifier 1 -n freight' },
    { title: 'Values do not carry over', body: 'An upgrade uses the chart defaults plus **only the values you pass this time**. Leave out `-f values-prod.yaml` and replicas silently return to the default. Pass the same files every time, or use `--reuse-values`. `helm get values RELEASE` shows what a release was given.', example: 'helm get values notifier -n freight\nhelm upgrade notifier charts/notifier -n freight -f charts/values-prod.yaml --set image.tag=1.3.0' },
  ],
  cluster: { seed: 82, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES, objects: [...systemWorkloads()] },
  files: CHART,
  objectives: [
    { id: 'render', text: 'Render the chart locally with the production values', check: (c) => c.history.some((h) => /^helm (template\b|install\b.*--dry-run)/.test(h.line) && /kind: Deployment/.test(h.stdout) && /replicas: 2/.test(h.stdout)) },
    { id: 'install', text: 'Release notifier is installed in freight: 2/2 ready', check: (c) => releases(c).length >= 1 && c.view.deploymentReady('freight', 'notifier', 2) },
    { id: 'upgrade', text: 'Upgrade the release to image tag 1.5.0', revealAfter: 'install', check: (c) => c.flags.has('tag-150') && c.history.some((h) => /^helm upgrade\b.*1\.5\.0/.test(h.line) && h.code === 0) },
    { id: 'rollback', text: 'The new Pods cannot start: roll the release back to the working revision', revealAfter: 'upgrade', check: (c) => helmRan(c, 'rollback') && notifierOn(c, '1.2.0') },
    { id: 'again', text: 'The tag was a typo. Upgrade to 1.3.0 and keep the production values: 2/2 ready', revealAfter: 'rollback', check: (c) => { const r = releases(c); return c.flags.has('tag-130') && notifierOn(c, '1.3.0') && r[r.length - 1]?.metadata.labels?.status === 'deployed'; } },
    { id: 'history', text: 'Bonus: read the release history', optional: true, check: (c) => helmRan(c, '(history|hist)') },
  ],
  chaos: [
    { id: 'tag-150', at: { afterObjective: 'install', delaySeconds: 6 }, action: { type: 'flag', flag: 'tag-150' }, announce: { from: 'Ana (team-notify)', text: 'Build is out. Please upgrade notifier to image tag 1.5.0.' } },
    { id: 'tag-130', at: { afterObjective: 'rollback', delaySeconds: 5 }, action: { type: 'flag', flag: 'tag-130' }, announce: { from: 'Ana (team-notify)', text: 'Sorry — fat fingers. There is no 1.5.0; the tag is 1.3.0.' } },
  ],
  hints: [
    { text: '`helm template notifier charts/notifier -f charts/values-prod.yaml` shows the manifests. Install: `helm install notifier charts/notifier -n freight -f charts/values-prod.yaml`, then `helm list -n freight`.', cost: 100 },
    { text: 'Upgrade: `helm upgrade notifier charts/notifier -n freight -f charts/values-prod.yaml --set image.tag=1.5.0`. Helm says deployed; `kubectl get pods -n freight` says ImagePullBackOff. `helm history notifier -n freight`, then `helm rollback notifier 1 -n freight`.', cost: 150 },
    { text: 'Final upgrade: `helm upgrade notifier charts/notifier -n freight -f charts/values-prod.yaml --set image.tag=1.3.0`. If you forget `-f`, the release drops to 1 replica: values are not remembered between upgrades (`--reuse-values` is the other way).', cost: 150 },
  ],
  par: { timeSec: 480, commands: 10 }, timeLimitSec: 900,
  solution: [
    'helm template notifier charts/notifier -f charts/values-prod.yaml',
    'helm install notifier charts/notifier -n freight -f charts/values-prod.yaml',
    'helm list -n freight',
    'kubectl rollout status deployment/notifier -n freight',
    'sleep 8',
    'helm upgrade notifier charts/notifier -n freight -f charts/values-prod.yaml --set image.tag=1.5.0',
    'sleep 6',
    'kubectl get pods -n freight',
    'helm history notifier -n freight',
    'helm rollback notifier 1 -n freight',
    'kubectl rollout status deployment/notifier -n freight',
    'sleep 7',
    'helm upgrade notifier charts/notifier -n freight -f charts/values-prod.yaml --set image.tag=1.3.0',
    'kubectl rollout status deployment/notifier -n freight',
    'helm get values notifier -n freight',
  ],
  debrief: { proTips: ['In CI use `helm upgrade --install --atomic --timeout 5m`: one command for first install and upgrades, with automatic rollback when Pods do not become Ready.', 'Charts are distributed through repositories or OCI registries (`helm install NAME oci://registry/charts/app --version 1.2.3`); pin the chart version like an image tag.', 'The helm-diff plugin shows what an upgrade would change; `helm lint` and `helm template | kubectl apply --dry-run=server -f -` catch mistakes before a release exists.'] },
};

// ---------------------------------------------------------------------------
// 7.3 GitOps
// ---------------------------------------------------------------------------

const REPO = 'https://git.orbital.local/freight/deploy.git';
const gitFrontend = (replicas: number, tag: string, nsName = 'freight'): string => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  namespace: ${nsName}
  labels:
    app: frontend
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      containers:
      - name: frontend
        image: ${REG}/frontend:${tag}
        ports:
        - containerPort: 8080
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
          periodSeconds: 5
`;
const GIT_SVC = `apiVersion: v1
kind: Service
metadata:
  name: frontend
  namespace: freight
spec:
  selector:
    app: frontend
  ports:
  - port: 80
    targetPort: 8080
`;
const application = (name: string, path: string, destNs: string, automated: Record<string, boolean>): KubeObject => ({
  apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', metadata: { name, namespace: 'argocd' },
  spec: { project: 'default', source: { repoURL: REPO, path, targetRevision: 'HEAD' }, destination: { server: 'https://kubernetes.default.svc', namespace: destNs }, syncPolicy: { automated } },
});
const frontendLive = (nsName: string, replicas: number, tag: string): KubeObject => deployment({ name: 'frontend', ns: nsName, image: `${REG}/frontend:${tag}`, replicas, port: 8080, readinessProbe: { httpGet: { path: '/readyz', port: 8080 }, periodSeconds: 5 } });

export const m7_3: Mission = {
  id: '7.3', chapter: 7, order: 3, title: 'Git is the source of truth', tagline: 'GitOps with Argo CD: change the repository, not the cluster.',
  ticket: {
    from: 'Chief Helmsman Okafor', priority: 'P2', subject: 'frontend to 4 replicas on 1.6.0 — through Git this time',
    body: [
      'The freight frontend is now managed by Argo CD: Application `frontend` in namespace argocd follows ~/deploy (a clone of our deploy repository), path apps/frontend, with automated sync, pruning and self-heal.',
      'I need frontend at 4 replicas on image 1.6.0. Yesterday somebody ran `kubectl scale` and swore the cluster "ignored" it. Try it if you want to see why — then make the change where it belongs: commit and push.',
      'Other people push to this repository as well. If something lands that breaks prod, the fix goes through Git too.',
    ],
  },
  concepts: [
    { title: 'GitOps', body: 'The desired state of the cluster lives in a Git repository. A controller inside the cluster — **Argo CD**, Flux — keeps comparing the repository with the live objects and applies the difference. Deploying is a commit; rollback is a revert; the audit log is `git log`. Nobody needs write access to the cluster to ship.', example: 'kubectl get applications -n argocd\nkubectl describe application frontend -n argocd' },
    { title: 'Sync and health', body: 'An Argo CD **Application** names a repo, a path and a destination. **Sync status** says whether live matches Git (`Synced` / `OutOfSync`); **health** says whether the workloads are working (`Healthy`, `Progressing`, `Degraded`). With `automated` sync, new commits are applied by themselves; `selfHeal` also reverts manual changes; `prune` deletes what was removed from Git.', example: 'syncPolicy:\n  automated:\n    prune: true\n    selfHeal: true' },
    { title: 'The workflow', body: 'Edit the manifest in your clone, then `git add`, `git commit`, `git push`. The controller polls the repository (every 3 minutes by default; 20 seconds here) — or refresh it now with an annotation. To undo a bad change: `git pull`, `git revert HEAD`, `git push`.', example: 'git add -A && git commit -m "frontend: 4 replicas" && git push\nkubectl annotate application frontend -n argocd argocd.argoproj.io/refresh=normal' },
  ],
  cluster: {
    seed: 83, nodes: orbitalNodes(), namespaces: ['freight'], images: { ...ORBITAL_IMAGES, ...ARGO_IMAGES }, gitRemotes: { [REPO]: 'deploy' }, gitPollSeconds: 20,
    objects: [
      ...systemWorkloads(), ...argoCd(),
      { ageSeconds: 5 * 86400, object: frontendLive('freight', 2, '1.4.1') },
      { ageSeconds: 5 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
      { ageSeconds: 86400, object: application('frontend', 'apps/frontend', 'freight', { prune: true, selfHeal: true }) },
    ],
    traffic: [{ id: 'customers', service: 'freight/frontend', rps: 8, label: 'customers' }],
  },
  files: { 'deploy/apps/frontend/deployment.yaml': gitFrontend(2, '1.4.1'), 'deploy/apps/frontend/service.yaml': GIT_SVC, 'deploy/README.md': '# freight deploy repository\n\nEverything under apps/ is applied to the cluster by Argo CD. Do not kubectl apply by hand.\n' },
  objectives: [
    { id: 'look', text: 'Look at the Application: sync and health status', check: (c) => c.history.some((h) => /^(kubectl|k) (get|describe) (applications?(\.argoproj\.io)?|apps?)\b/.test(h.line) && /Synced|OutOfSync/.test(h.stdout)) },
    { id: 'drift', text: 'Change the live Deployment by hand and watch Argo CD undo it', check: (c) => c.history.some((h) => /^(kubectl|k) (scale|set image|patch|edit)\b.*frontend/.test(h.line) && h.code === 0 && c.engine.clock.nowMs - h.at > 6000) && c.view.deployment('freight', 'frontend')?.spec.replicas === 2 && image(c.view.deployment('freight', 'frontend')).endsWith(':1.4.1') },
    { id: 'push', text: 'Commit and push: 4 replicas, image 1.6.0', check: (c) => { const f = headFile(c, REPO, 'apps/frontend/deployment.yaml'); return /replicas:\s*4\b/.test(f) && f.includes('frontend:1.6.0'); } },
    { id: 'synced', text: 'Argo CD rolled it out: 4/4 on 1.6.0, Synced and Healthy', check: (c) => image(c.view.deployment('freight', 'frontend')).endsWith(':1.6.0') && c.view.deploymentReady('freight', 'frontend', 4) && appGreen(c, 'frontend') },
    { id: 'revert', text: 'A pushed commit broke the rollout: revert it in Git and get back to Healthy', revealAfter: 'synced', check: (c) => c.flags.has('bad-commit') && headFile(c, REPO, 'apps/frontend/deployment.yaml').includes('frontend:1.6.0') && image(c.view.deployment('freight', 'frontend')).endsWith(':1.6.0') && c.view.deploymentReady('freight', 'frontend', 4) && appGreen(c, 'frontend') },
  ],
  chaos: [
    { id: 'bad-commit', at: { afterObjective: 'synced', delaySeconds: 8 }, action: { type: 'custom', run: (e) => remoteCommit(e, REPO, 'frontend: bump to 1.6.1', (tree) => { tree['apps/frontend/deployment.yaml'] = (tree['apps/frontend/deployment.yaml'] ?? '').replace(/frontend:[\w.-]+/, 'frontend:1.6.1'); }, 'dana') }, announce: { from: 'Dana (frontend)', text: 'Pushed the 1.6.1 bump to the deploy repo, heading into a meeting!' } },
    { id: 'bad-flag', at: { afterObjective: 'synced', delaySeconds: 8 }, action: { type: 'flag', flag: 'bad-commit' } },
  ],
  hints: [
    { text: '`kubectl get applications -n argocd`. Then try `kubectl scale deployment frontend --replicas=4 -n freight` and watch `kubectl get deploy frontend -n freight` for ten seconds: self-heal puts Git\'s value back.', cost: 100 },
    { text: 'Edit deploy/apps/frontend/deployment.yaml (replicas 4, image tag 1.6.0), then `cd deploy`, `git add -A`, `git commit -m "frontend: 4 replicas on 1.6.0"`, `git push`. Argo CD picks it up within its poll interval.', cost: 150 },
    { text: 'After the bad commit: `kubectl get applications -n argocd` and `kubectl get pods -n freight` (ImagePullBackOff). In ~/deploy: `git pull`, `git log --oneline`, `git revert HEAD`, `git push`.', cost: 150 },
  ],
  par: { timeSec: 540, commands: 14 }, timeLimitSec: 1080, slo: { minAvailability: 0.97 },
  solution: [
    'kubectl get pods -n argocd',
    'kubectl get applications -n argocd',
    'kubectl scale deployment frontend --replicas=4 -n freight',
    'sleep 8',
    'kubectl get deployment frontend -n freight',
    { edit: 'deploy/apps/frontend/deployment.yaml', replace: ['  replicas: 2\n', '  replicas: 4\n'] },
    { edit: 'deploy/apps/frontend/deployment.yaml', replace: ['frontend:1.4.1', 'frontend:1.6.0'] },
    'cd deploy',
    'git status',
    'git add -A',
    'git commit -m "frontend: 4 replicas on 1.6.0"',
    'git push',
    'kubectl annotate application frontend -n argocd argocd.argoproj.io/refresh=normal',
    'kubectl rollout status deployment/frontend -n freight',
    'kubectl get applications -n argocd',
    'sleep 40',
    'kubectl get applications -n argocd',
    'kubectl get pods -n freight',
    'git pull',
    'git log --oneline',
    'git revert HEAD',
    'git push',
    'sleep 30',
    'kubectl get applications -n argocd',
  ],
  debrief: { proTips: ['Real teams put a pull request between the edit and the push: review, CI checks (`kubeconform`, policy tests), then merge — the cluster only ever sees reviewed commits.', 'Progressive delivery tools (Argo Rollouts, Flagger) extend this: Git says "release 1.6.1", the controller canaries it and rolls back by itself on bad metrics.', 'Secrets do not go into Git in plain text: Sealed Secrets, SOPS, or the External Secrets Operator keep GitOps and secrecy compatible.'] },
};

// ---------------------------------------------------------------------------
// 7.4 CRDs and operators
// ---------------------------------------------------------------------------

const OP_REPO = 'registry.orbital.local/platform/route-operator';
const ROUTECACHE_CRD = stringify(crd({
  group: 'orbital.local', kind: 'RouteCache', plural: 'routecaches', shortNames: ['rcache'], version: 'v1',
  spec: S.obj({ replicas: S.int({ minimum: 1, maximum: 5 }), tier: S.str({ enum: ['small', 'large'] }) }, ['replicas']),
  columns: [{ name: 'Replicas', type: 'integer', jsonPath: '.spec.replicas' }, { name: 'Ready', type: 'integer', jsonPath: '.status.readyReplicas' }, { name: 'Phase', type: 'string', jsonPath: '.status.phase' }],
}) as unknown as YamlValue);
const OPERATOR_YAML = `apiVersion: v1
kind: ServiceAccount
metadata:
  name: route-operator
  namespace: platform
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: route-operator
  namespace: platform
  labels:
    app: route-operator
spec:
  replicas: 1
  selector:
    matchLabels:
      app: route-operator
  template:
    metadata:
      labels:
        app: route-operator
    spec:
      serviceAccountName: route-operator
      containers:
      - name: manager
        image: ${OP_REPO}:1.2.0
`;
const ROUTECACHE_CR = `apiVersion: orbital.local/v1
kind: RouteCache
metadata:
  name: main
  namespace: freight
spec:
  replicas: 3
  tier: medium
`;
const routeOperator: OperatorSpec = {
  image: OP_REPO,
  reconcile: (api) => {
    if (!api.can('list', 'orbital.local', 'routecaches') || !api.can('watch', 'orbital.local', 'routecaches')) return;
    for (const rc of api.engine.store.list('RouteCache')) {
      const spec = (rc.spec ?? {}) as { replicas?: number; tier?: string };
      const name = `routecache-${rc.metadata.name}`;
      const labels = { app: name, 'app.kubernetes.io/managed-by': 'route-operator' };
      const memory = spec.tier === 'large' ? '512Mi' : '128Mi';
      const ok = api.apply({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: rc.metadata.namespace, labels }, spec: { replicas: spec.replicas ?? 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels }, spec: { containers: [{ name: 'redis', image: 'redis:7', ports: [{ containerPort: 6379 }], resources: { requests: { cpu: '50m', memory } } }] } } } }, rc);
      if (!ok) continue;
      const ready = api.engine.store.get<Deployment>('Deployment', rc.metadata.namespace, name)?.status.readyReplicas ?? 0;
      api.setStatus(rc, { phase: ready >= (spec.replicas ?? 1) ? 'Ready' : 'Reconciling', readyReplicas: ready });
    }
  },
};
const opCan = (c: ObjectiveContext, verb: string, group: string, resource: string, namespace?: string): boolean => authorize(c.engine, serviceAccountUser('platform', 'route-operator'), { verb, group, resource, namespace });
const cacheDeploy = (c: ObjectiveContext): Deployment | undefined => c.view.deployment('freight', 'routecache-main');

export const m7_4: Mission = {
  id: '7.4', chapter: 7, order: 4, title: 'Teach the cluster a new word', tagline: 'CustomResourceDefinitions and the operator that gives them meaning.',
  ticket: {
    from: 'Platform (Liang)', priority: 'P2', subject: 'Roll out the RouteCache operator and give freight its first cache',
    body: [
      'We wrote an operator so teams can order a route cache with five lines of YAML instead of maintaining Redis Deployments. Everything is in ~/operator: the CRD (crd.yaml), the operator itself (operator.yaml, runs in namespace platform) and freight\'s first RouteCache (routecache.yaml — written by the freight team, unreviewed).',
      'The operator needs to get/list/watch and update `routecaches` (API group orbital.local) cluster-wide, and to manage Deployments. No RBAC manifest was written; please do not hand it cluster-admin.',
      'Done means: RouteCache `main` in freight reports Ready with 3 replicas. The planners may ask for more later.',
    ],
  },
  concepts: [
    { title: 'CustomResourceDefinition', body: 'A **CRD** adds a new kind to the API: a group, a kind, and an OpenAPI schema. From then on the API server stores, validates, lists and watches those objects like built-in ones — `kubectl get`, RBAC, `-o yaml` all work. On its own a custom resource is only data.', example: 'kubectl apply -f operator/crd.yaml\nkubectl api-resources --api-group=orbital.local\nkubectl get crd' },
    { title: 'Operator = controller + CRD', body: 'An **operator** is a controller that watches a custom resource and reconciles the real world to match: it creates Deployments, Services, backups… and writes what it observed into `.status`. You declare *what* (`replicas: 3`); the operator encodes *how*. Change the custom resource, never the objects the operator owns.', example: 'kubectl get routecaches -A\nkubectl describe routecache main -n freight' },
    { title: 'Operators are API clients', body: 'The controller runs as a Pod with a ServiceAccount, and needs RBAC for everything it reads or writes — its own resources and the ones it manages. A missing permission does not crash it: it logs `forbidden` and waits. The operator\'s logs are the first place to look when a custom resource "does nothing".', example: 'kubectl logs deploy/route-operator -n platform\nkubectl auth can-i list routecaches.orbital.local --as=system:serviceaccount:platform:route-operator' },
  ],
  cluster: {
    seed: 84, nodes: orbitalNodes(), namespaces: ['freight', 'platform'], images: ORBITAL_IMAGES, operators: [routeOperator],
    objects: [...systemWorkloads()],
  },
  files: { 'operator/crd.yaml': ROUTECACHE_CRD, 'operator/operator.yaml': OPERATOR_YAML, 'operator/routecache.yaml': ROUTECACHE_CR },
  objectives: [
    { id: 'crd', text: 'The RouteCache CRD is installed and the operator Pod is running', check: (c) => !!c.view.get('CustomResourceDefinition', undefined, 'routecaches.orbital.local') && c.view.deploymentReady('platform', 'route-operator', 1) },
    { id: 'invalid', text: 'Apply freight\'s RouteCache and read why the API server rejects it', check: (c) => stderrHad(c, /The RouteCache "main" is invalid: spec\.tier: Unsupported value: "medium"/) },
    { id: 'cr', text: 'RouteCache main exists in freight (3 replicas)', check: (c) => (c.view.get('RouteCache', 'freight', 'main')?.spec as { replicas?: number } | undefined)?.replicas !== undefined },
    { id: 'forbidden', text: 'Nothing happens: find out why in the operator\'s logs', check: (c) => c.history.some((h) => /^(kubectl|k) logs\b.*route-operator/.test(h.line) && /is forbidden: User \\?"system:serviceaccount:platform:route-operator/.test(h.stdout)) },
    { id: 'rbac', text: 'The operator\'s ServiceAccount may read and update routecaches and manage Deployments — without cluster-admin', check: (c) => ['get', 'list', 'watch', 'update'].every((v) => opCan(c, v, 'orbital.local', 'routecaches', 'freight')) && opCan(c, 'list', 'orbital.local', 'routecaches') && ['get', 'create', 'update'].every((v) => opCan(c, v, 'apps', 'deployments', 'freight')) && !opCan(c, 'get', '', 'secrets', 'freight') && !opCan(c, 'delete', '', 'nodes') },
    { id: 'ready', text: 'The operator reconciled: RouteCache main is Ready with 3 replicas', check: (c) => (c.view.get('RouteCache', 'freight', 'main')?.status as { phase?: string } | undefined)?.phase === 'Ready' && (cacheDeploy(c)?.status.readyReplicas ?? 0) >= 3 },
    { id: 'scale', text: 'The planners need 5 members: change the RouteCache, not the Deployment', revealAfter: 'ready', check: (c) => c.flags.has('more-cache') && (c.view.get('RouteCache', 'freight', 'main')?.spec as { replicas?: number } | undefined)?.replicas === 5 && cacheDeploy(c)?.status.readyReplicas === 5 },
    { id: 'heal', text: 'Bonus: delete the Deployment the operator owns and watch it come back', optional: true, check: (c) => { const del = c.history.find((h) => /^(kubectl|k) delete deploy(ments?)?(\.apps)?[ /]routecache-main\b/.test(h.line) && h.code === 0); const d = cacheDeploy(c); return !!del && !!d && Date.parse(d.metadata.creationTimestamp ?? '') >= del.at - 1000; } },
  ],
  chaos: [{ id: 'more-cache', at: { afterObjective: 'ready', delaySeconds: 6 }, action: { type: 'flag', flag: 'more-cache' }, announce: { from: 'Planning (Sofia)', text: 'Route planning is slow this weekend — can the freight cache have 5 members?' } }],
  hints: [
    { text: '`kubectl apply -f operator/crd.yaml -f operator/operator.yaml`, then `kubectl apply -f operator/routecache.yaml`: the API server validates it against the CRD schema and names the bad field. `kubectl get crd routecaches.orbital.local -o yaml | grep -A4 tier` shows the allowed values. Fix the file (`tier: small`) and apply.', cost: 100 },
    { text: '`kubectl get routecaches -n freight` shows no status; `kubectl logs deploy/route-operator -n platform` says what the operator may not do. Create a ClusterRole: `kubectl create clusterrole route-operator --verb=get,list,watch,create,update,patch,delete --resource=routecaches.orbital.local,deployments.apps`.', cost: 150 },
    { text: 'Bind it to the ServiceAccount: `kubectl create clusterrolebinding route-operator --clusterrole=route-operator --serviceaccount=platform:route-operator`. Later, to scale: `kubectl patch routecache main -n freight --type merge -p \'{"spec":{"replicas":5}}\'`.', cost: 150 },
  ],
  par: { timeSec: 540, commands: 12 }, timeLimitSec: 1080,
  solution: [
    'kubectl apply -f operator/crd.yaml',
    'kubectl api-resources --api-group=orbital.local',
    'kubectl apply -f operator/operator.yaml',
    'kubectl apply -f operator/routecache.yaml',
    { edit: 'operator/routecache.yaml', replace: ['tier: medium', 'tier: small'] },
    'kubectl apply -f operator/routecache.yaml',
    'kubectl rollout status deployment/route-operator -n platform',
    'sleep 6',
    'kubectl get routecaches -n freight',
    'kubectl logs deploy/route-operator -n platform',
    'kubectl create clusterrole route-operator --verb=get,list,watch,create,update,patch,delete --resource=routecaches.orbital.local,deployments.apps',
    'kubectl create clusterrolebinding route-operator --clusterrole=route-operator --serviceaccount=platform:route-operator',
    'sleep 12',
    'kubectl get routecaches,deployments -n freight',
    'kubectl delete deployment routecache-main -n freight',
    'sleep 8',
    'kubectl get routecaches,deployments -n freight',
    'kubectl patch routecache main -n freight --type merge -p \'{"spec":{"replicas":5}}\'',
    'sleep 10',
    'kubectl get routecaches -n freight',
  ],
  debrief: { proTips: ['Most operators you will run are not yours: cert-manager, Prometheus Operator, CloudNativePG, Strimzi. The skill is the same — read the CRD, read the status, read the controller logs.', 'Kubebuilder and Operator SDK scaffold controllers in Go; the hard part is not the code but the failure cases your reconcile loop must tolerate.', 'CRDs are cluster-wide and versioned: upgrading an operator means upgrading its CRDs first, and removing a CRD deletes every object of that kind.'] },
};

// ---------------------------------------------------------------------------
// 7.5 Capstone
// ---------------------------------------------------------------------------

const C_BASE = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- deployment.yaml
- service.yaml
- legacy-banner.yaml
`;
const C_BANNER = `apiVersion: v1
kind: ConfigMap
metadata:
  name: legacy-banner
data:
  banner.html: "<marquee>Welcome to Orbital Freight</marquee>"
`;
const C_PROD = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: freight-prod
resources:
- ../../base
labels:
- pairs:
    env: prod
images:
- name: ${REG}/frontend
  newTag: 1.4.1
replicas:
- name: frontend
  count: 3
`;
const C_APP = `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: freight-prod
  namespace: argocd
spec:
  project: default
  source:
    repoURL: ${REPO}
    path: overlays/production
    targetRevision: HEAD
  destination:
    server: https://kubernetes.default.svc
    namespace: freight-prod
  syncPolicy:
    automated: {}
`;
const C_DEPLOY = K_DEPLOY.replace('        envFrom:\n        - configMapRef:\n            name: frontend-config\n', '');

export const m7_5: Mission = {
  id: '7.5', chapter: 7, order: 5, title: 'Capstone: Hands off prod', tagline: 'Kustomize in Git, Argo CD in charge, and nobody typing kubectl apply.',
  ticket: {
    from: 'Chief Helmsman Okafor', priority: 'P1', subject: 'freight-prod goes GitOps today',
    body: [
      'The prod frontend was deployed by hand. From today Argo CD owns it. ~/deploy is the clone of the deploy repository: a Kustomize base, the prod overlay, and an Application manifest in argocd/application.yaml that someone drafted and never got working. Get the Application `freight-prod` Synced and Healthy.',
      'Then ship frontend 1.6.0 to prod — through the repository. And retire the `legacy-banner` ConfigMap: remove it from Git and have Argo CD delete it from the cluster.',
      'By tonight I want manual changes in freight-prod to be undone automatically. Customers are on the site the whole time.',
    ],
  },
  concepts: [
    { title: 'Argo CD renders for you', body: 'If the Application\'s `path` contains a `kustomization.yaml`, Argo CD runs Kustomize; a `Chart.yaml`, Helm; otherwise it applies the plain YAML files. A wrong path or a broken kustomization shows up as a `ComparisonError` condition on the Application — Argo CD cannot even compute what should exist.', example: 'kubectl describe application freight-prod -n argocd\nkubectl kustomize overlays/prod   # what Argo CD will render' },
    { title: 'Three switches', body: '`automated: {}` applies new commits. It does not revert manual changes (the Application shows `OutOfSync` and waits) unless `selfHeal: true`; and it never deletes objects that disappeared from Git unless `prune: true`. Decide each one on purpose — pruning with a wrong path can delete a lot.', example: 'kubectl patch application freight-prod -n argocd --type merge -p \'{"spec":{"syncPolicy":{"automated":{"prune":true,"selfHeal":true}}}}\'' },
    { title: 'Promotion is a commit', body: 'Releasing to prod is a one-line change in the overlay — `newTag: 1.6.0` — reviewed, merged, pushed. The same commit that changes the cluster documents who changed it, when and why; `git revert` is the rollback.', example: 'git add -A && git commit -m "prod: frontend 1.6.0" && git push' },
  ],
  cluster: {
    seed: 85, nodes: orbitalNodes(), namespaces: ['freight-prod'], images: { ...ORBITAL_IMAGES, ...ARGO_IMAGES }, gitRemotes: { [REPO]: 'deploy' }, gitPollSeconds: 20,
    objects: [
      ...systemWorkloads(), ...argoCd(),
      { ageSeconds: 9 * 86400, object: frontendLive('freight-prod', 3, '1.4.1') },
      { ageSeconds: 9 * 86400, object: service({ name: 'frontend', ns: 'freight-prod', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
      { ageSeconds: 200 * 86400, object: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'legacy-banner', namespace: 'freight-prod' }, data: { 'banner.html': '<marquee>Welcome to Orbital Freight</marquee>' } } },
    ],
    traffic: [{ id: 'customers', service: 'freight-prod/frontend', rps: 10, label: 'customers' }],
  },
  files: { 'deploy/base/kustomization.yaml': C_BASE, 'deploy/base/deployment.yaml': C_DEPLOY, 'deploy/base/service.yaml': K_SVC, 'deploy/base/legacy-banner.yaml': C_BANNER, 'deploy/overlays/prod/kustomization.yaml': C_PROD, 'deploy/argocd/application.yaml': C_APP },
  objectives: [
    { id: 'app', text: 'Application freight-prod is Synced and Healthy', check: (c) => appGreen(c, 'freight-prod') && c.view.deploymentReady('freight-prod', 'frontend', 3) },
    { id: 'release', text: 'frontend 1.6.0 is live in prod, released through Git', check: (c) => /newTag:\s*"?1\.6\.0/.test(headFile(c, REPO, 'overlays/prod/kustomization.yaml')) && image(c.view.deployment('freight-prod', 'frontend')).endsWith(':1.6.0') && c.view.deploymentReady('freight-prod', 'frontend', 3) && appGreen(c, 'freight-prod') },
    { id: 'heal', text: 'Someone deleted the prod Service: it is back, and self-heal is on', revealAfter: 'release', check: (c) => c.flags.has('svc-deleted') && !!c.view.get<Service>('Service', 'freight-prod', 'frontend') && app(c, 'freight-prod')?.spec?.syncPolicy?.automated?.selfHeal === true && c.view.endpointsReady('freight-prod', 'frontend') >= 3 },
    { id: 'prune', text: 'legacy-banner is gone from Git and pruned from the cluster', check: (c) => !headFile(c, REPO, 'base/kustomization.yaml').includes('legacy-banner') && !c.view.get('ConfigMap', 'freight-prod', 'legacy-banner') && app(c, 'freight-prod')?.spec?.syncPolicy?.automated?.prune === true && appGreen(c, 'freight-prod') },
  ],
  chaos: [
    { id: 'svc-delete', at: { afterObjective: 'release', delaySeconds: 10 }, action: { type: 'custom', run: (e) => { const s = e.store.get('Service', 'freight-prod', 'frontend'); if (s) e.store.remove(s); } }, announce: { from: 'PagerDuty', text: 'freight-prod frontend unreachable — audit log: an intern ran `kubectl delete service frontend -n freight-prod` while "cleaning up".' } },
    { id: 'svc-flag', at: { afterObjective: 'release', delaySeconds: 18 }, action: { type: 'flag', flag: 'svc-deleted' } },
  ],
  hints: [
    { text: '`kubectl apply -f deploy/argocd/application.yaml`, then `kubectl get applications -n argocd` and `kubectl describe application freight-prod -n argocd`: the ComparisonError names a path that does not exist. `ls deploy/overlays`. Fix `path:` and apply again.', cost: 120 },
    { text: 'Release: in deploy/overlays/prod/kustomization.yaml set `newTag: 1.6.0`; `cd deploy`, `git add -A`, `git commit -m "prod: frontend 1.6.0"`, `git push`. Retire the banner the same way: delete base/legacy-banner.yaml (`git rm` or `rm`) and its line in base/kustomization.yaml.', cost: 150 },
    { text: 'Self-heal and prune are switches on the Application: set `automated: {prune: true, selfHeal: true}` in argocd/application.yaml and `kubectl apply -f` it (or `kubectl patch application freight-prod -n argocd --type merge -p \'{"spec":{"syncPolicy":{"automated":{"prune":true,"selfHeal":true}}}}\'`).', cost: 150 },
  ],
  par: { timeSec: 720, commands: 18 }, timeLimitSec: 1500, slo: { minAvailability: 0.9 },
  solution: [
    'cd deploy',
    'kubectl apply -f argocd/application.yaml',
    'sleep 3',
    'kubectl get applications -n argocd',
    'kubectl describe application freight-prod -n argocd',
    'ls overlays',
    { edit: 'argocd/application.yaml', replace: ['path: overlays/production', 'path: overlays/prod'] },
    { edit: 'argocd/application.yaml', replace: ['    automated: {}\n', '    automated:\n      prune: true\n      selfHeal: true\n'] },
    'kubectl apply -f argocd/application.yaml',
    'sleep 6',
    'kubectl get applications -n argocd',
    { edit: 'overlays/prod/kustomization.yaml', replace: ['newTag: 1.4.1', 'newTag: 1.6.0'] },
    { edit: 'base/kustomization.yaml', replace: ['- legacy-banner.yaml\n', ''] },
    'rm base/legacy-banner.yaml',
    'kubectl kustomize overlays/prod',
    'git add -A',
    'git commit -m "prod: frontend 1.6.0, retire legacy banner"',
    'git push',
    'kubectl annotate application freight-prod -n argocd argocd.argoproj.io/refresh=normal',
    'kubectl rollout status deployment/frontend -n freight-prod',
    'kubectl get applications -n argocd',
    'sleep 22',
    'kubectl get svc,configmaps -n freight-prod',
  ],
  debrief: { proTips: ['The Application manifest itself belongs in Git too: an "app of apps" (or ApplicationSet) lets Argo CD manage its own Applications, so a new environment is one more file.', 'Give humans read-only access to prod and let the GitOps controller hold the write permission — the intern\'s `kubectl delete` would have been `forbidden`.', 'Sync windows, sync waves and health checks let you order and gate what a commit rolls out; start simple and add them when you feel the need.'] },
};

export const chapter7: Mission[] = [m7_1, m7_2, m7_3, m7_4, m7_5];
void usedCmd; void outputHad;
