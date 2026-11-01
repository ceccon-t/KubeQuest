import type { Mission } from '../game/mission.ts';
import { ORBITAL_IMAGES, REG, deployment, service, orbitalNodes, systemWorkloads, usedCmd, outputHad, yamlOf, PROBES } from './lib.ts';
import { isPodReady } from '../engine/controllers/kubelet.ts';
import type { Pod, Job, CronJob, DaemonSet } from '../engine/types.ts';

const FRONTEND_PROBELESS = yamlOf(deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.2-rc1`, replicas: 3, port: 8080 }));

export const m3_1: Mission = {
  id: '3.1', chapter: 3, order: 1, title: 'Three of a kind', tagline: 'Delete a pod. Watch it come back. Then scale for launch.',
  ticket: {
    from: 'Chief Helmsman Okafor', priority: 'P3', subject: 'Marketing launch at 10:00 — frontend needs 5 replicas; also a weird alert',
    body: [
      'Two things. First, an alert said a frontend pod "disappeared and reappeared" overnight. Nobody understands why. Delete one yourself and watch what happens — I want you to see the ReplicaSet do its job.',
      'Second, marketing launches a campaign at 10:00. Scale frontend to 5 replicas. Traffic is live, so no drops please — the SLO board is watching.',
    ],
  },
  concepts: [
    { title: 'ReplicaSets reconcile', body: 'A ReplicaSet\'s only job: make the number of Pods matching its **selector** equal `spec.replicas`. Delete a Pod and it creates another one within seconds; add an extra Pod with matching labels and it deletes one. That loop — observe, compare, act — is the **controller pattern** all of Kubernetes is built on.', example: 'kubectl get rs -n freight\nkubectl describe rs NAME' },
    { title: 'Deployments own ReplicaSets', body: 'You rarely create ReplicaSets yourself: a **Deployment** creates one per Pod template revision and manages rollouts between them. `kubectl scale deployment` changes the Deployment\'s replicas, which the controller copies to the current ReplicaSet.', example: 'kubectl scale deployment frontend --replicas=5' },
    { title: 'Readiness gates traffic', body: 'A Service only routes to Pods whose **Ready** condition is True. New replicas take traffic as soon as they are ready; deleted Pods leave the endpoints immediately. That is why a rolling change can be zero-downtime.', example: 'kubectl get endpoints frontend' },
  ],
  cluster: {
    seed: 41, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.0`, replicas: 3, port: 8080, readinessProbe: PROBES.readiness('/readyz', 8080) }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
    ],
    traffic: [{ id: 'customers', service: 'freight/frontend', rps: 10, label: 'customers' }],
  },
  objectives: [
    { id: 'delete', text: 'Delete one frontend pod', check: (c) => usedCmd(c, /^kubectl delete (pods?|po)[ /]frontend-/) },
    { id: 'rs', text: 'Look at the ReplicaSet that replaced it (get rs / describe rs)', check: (c) => usedCmd(c, /^kubectl (get|describe) (replicasets?|rs)\b/) && outputHad(c, /frontend-[a-z0-9]+/) },
    { id: 'scale', text: 'Scale frontend to 5 replicas, all ready', check: (c) => c.view.deploymentReady('freight', 'frontend', 5) },
    { id: 'events', text: 'Bonus: read the SuccessfulCreate events of the ReplicaSet', optional: true, check: (c) => outputHad(c, /SuccessfulCreate/) },
  ],
  chaos: [
    { id: 'oom', at: { afterObjective: 'scale', delaySeconds: 8 }, action: { type: 'killPods', namespace: 'freight', selector: 'app=frontend', count: 1 }, announce: { from: 'node-monitor', text: 'orbital-worker-b: kernel OOM killer took a frontend process. Watch the ReplicaSet.' } },
  ],
  hints: [
    { text: '`kubectl get pods -n freight`, pick one, `kubectl delete pod <name> -n freight`, then `kubectl get pods -n freight` again — count them.', cost: 80 },
    { text: '`kubectl get rs -n freight` shows DESIRED/CURRENT/READY. `kubectl describe rs <name> -n freight` lists the SuccessfulCreate events.', cost: 80 },
    { text: '`kubectl scale deployment frontend --replicas=5 -n freight`; confirm with `kubectl get deploy frontend -n freight`.', cost: 100 },
  ],
  par: { timeSec: 240, commands: 7 }, slo: { minAvailability: 0.99 },
  solution: ['kubectl get pods -n freight', 'kubectl delete pod $(kubectl get pods -n freight -l app=frontend -o name | head -1 | cut -d/ -f2) -n freight', 'kubectl get rs -n freight', 'kubectl describe rs -n freight', 'kubectl scale deployment frontend --replicas=5 -n freight', 'kubectl rollout status deployment/frontend -n freight', 'sleep 12', 'kubectl get pods -n freight'],
  debrief: { proTips: ['`kubectl get pods -w` watches changes live — perfect for seeing a pod replaced.', 'The pod-template-hash label ties Pods to their ReplicaSet; never edit it by hand.', 'Horizontal Pod Autoscalers scale for you based on metrics — Chapter 6.'] },
};

export const m3_2: Mission = {
  id: '3.2', chapter: 3, order: 2, title: 'Ship it (and un-ship it)', tagline: 'A rolling update, a bad release, a rollback.',
  ticket: {
    from: 'Release train', priority: 'P2', subject: 'Deploy frontend 1.4.1 to prod — and stay around, CI has been flaky',
    body: [
      'frontend 1.4.1 is approved. Roll it out to the freight namespace with zero downtime and watch the rollout finish.',
      'Image: ' + `${REG}/frontend:1.4.1`,
      'Stay on the console afterwards. CI has been auto-deploying things it should not.',
    ],
  },
  concepts: [
    { title: 'Rolling updates', body: 'Changing a Deployment\'s Pod template creates a new ReplicaSet and shifts replicas across, bounded by `maxSurge` (extra Pods allowed) and `maxUnavailable` (Pods allowed to be missing), both 25% by default. Old Pods are only removed once new ones are **available**.', example: 'kubectl set image deployment/frontend frontend=IMAGE\nkubectl rollout status deployment/frontend' },
    { title: 'Revisions and rollback', body: 'Each template change is a revision kept as an old ReplicaSet (`revisionHistoryLimit`, default 10). `kubectl rollout history` lists them, `kubectl rollout undo` goes back one (or `--to-revision=N`). A rollback is just another rolling update.', example: 'kubectl rollout history deployment/frontend\nkubectl rollout undo deployment/frontend' },
    { title: 'A stuck rollout is a safe rollout', body: 'If new Pods never become ready, the controller stops at the `maxUnavailable` boundary: most old Pods keep serving. `progressDeadlineSeconds` (600s) eventually marks the Deployment as failed. Your job: notice, and undo.', example: 'kubectl get pods -l app=frontend\nkubectl describe deployment frontend' },
  ],
  cluster: {
    seed: 42, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.0`, replicas: 4, port: 8080, readinessProbe: PROBES.readiness('/readyz', 8080), annotations: { 'kubernetes.io/change-cause': 'ci-deploy 1.4.0' } }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
    ],
    traffic: [{ id: 'customers', service: 'freight/frontend', rps: 15, label: 'customers' }],
  },
  objectives: [
    { id: 'image', text: 'Update the frontend deployment to image frontend:1.4.1', check: (c) => c.view.deploymentImage('freight', 'frontend') === `${REG}/frontend:1.4.1` },
    { id: 'status', text: 'Watch the rollout complete with kubectl rollout status', check: (c) => usedCmd(c, /^kubectl rollout status\b/) && outputHad(c, /successfully rolled out/) && c.view.deploymentReady('freight', 'frontend', 4) && c.view.deploymentImage('freight', 'frontend') === `${REG}/frontend:1.4.1` },
    { id: 'undo', text: 'Roll back the bad 1.5.0 release and get 4/4 ready on 1.4.1 again', revealAfter: 'status', check: (c) => c.flags.has('bad-release') && usedCmd(c, /^kubectl rollout undo\b/) && c.view.deploymentImage('freight', 'frontend') === `${REG}/frontend:1.4.1` && c.view.deploymentReady('freight', 'frontend', 4) },
    { id: 'history', text: 'Bonus: inspect the revision history', optional: true, check: (c) => usedCmd(c, /^kubectl rollout history\b/) },
  ],
  chaos: [
    { id: 'ci', at: { afterObjective: 'status', delaySeconds: 6 }, action: { type: 'setImage', namespace: 'freight', deployment: 'frontend', image: `${REG}/frontend:1.5.0` }, announce: { from: 'ci-bot', text: 'Auto-deployed frontend:1.5.0 to freight (merge of PR #812). Pods are crashing. Humans, please.' } },
    { id: 'ci-flag', at: { afterObjective: 'status', delaySeconds: 6 }, action: { type: 'flag', flag: 'bad-release' } },
  ],
  hints: [
    { text: `\`kubectl set image deployment/frontend frontend=${REG}/frontend:1.4.1 -n freight\` then \`kubectl rollout status deployment/frontend -n freight\`.`, cost: 100 },
    { text: 'When CI pushes 1.5.0, check `kubectl get pods -n freight` — new pods crash-loop while old ones keep serving. `kubectl rollout history deployment/frontend -n freight` shows the revisions.', cost: 100 },
    { text: '`kubectl rollout undo deployment/frontend -n freight` returns to the previous revision (1.4.1). Confirm with `rollout status` and `get deploy`.', cost: 150 },
  ],
  par: { timeSec: 360, commands: 9 }, timeLimitSec: 600, slo: { minAvailability: 0.99 },
  solution: [`kubectl set image deployment/frontend frontend=${REG}/frontend:1.4.1 -n freight`, 'kubectl rollout status deployment/frontend -n freight', 'sleep 12', 'kubectl get pods -n freight', 'kubectl rollout history deployment/frontend -n freight', 'kubectl rollout undo deployment/frontend -n freight', 'kubectl rollout status deployment/frontend -n freight', 'kubectl get deploy frontend -n freight'],
  debrief: { proTips: ['`kubectl rollout undo --to-revision=N` targets a specific revision; `rollout history --revision=N` shows its template.', '`kubectl annotate deployment/frontend kubernetes.io/change-cause="…"` records why in the history table.', 'Set `strategy.rollingUpdate.maxUnavailable: 0` for strict zero-downtime at the cost of extra capacity during rollouts.'] },
};

export const m3_3: Mission = {
  id: '3.3', chapter: 3, order: 3, title: 'Probe-ably fine', tagline: 'Readiness gates traffic. Liveness restarts the stuck.',
  ticket: {
    from: 'Priya (QA)', priority: 'P2', subject: 'Every frontend deploy causes ~15s of errors — add health checks',
    body: [
      'frontend 1.4.2-rc1 takes about 12 seconds to warm its route cache after start. Until then it answers 503, but Kubernetes sends it traffic immediately. Every rollout = errors.',
      'The app exposes GET /readyz (503 while warming, then 200) and GET /healthz (200 whenever the process is alive). Add a readiness probe on /readyz and a liveness probe on /healthz to ~/manifests/frontend.yaml and apply it.',
      'Traffic is live. The SLO board wants ≥99.5% success for this change. Do not use kubectl set — fix the manifest.',
    ],
  },
  concepts: [
    { title: 'Readiness vs liveness vs startup', body: '**Readiness** failing removes the Pod from Service endpoints (no traffic) without restarting it. **Liveness** failing restarts the container. **Startup** probes delay the other two for slow starters. Probes can be httpGet, tcpSocket, exec or gRPC.', example: 'readinessProbe:\n  httpGet: {path: /readyz, port: 8080}\n  periodSeconds: 5' },
    { title: 'Probe timing', body: '`initialDelaySeconds` (0), `periodSeconds` (10), `timeoutSeconds` (1), `failureThreshold` (3), `successThreshold` (1). A readiness probe with period 5 marks a warming Pod ready within ~5s of /readyz turning 200. Too aggressive liveness probes cause restart storms.', example: 'kubectl describe pod NAME  # shows Readiness: http-get http://:8080/readyz delay=0s timeout=1s period=5s …' },
    { title: 'Available ≠ Running', body: 'A Deployment\'s rollout only proceeds when new Pods are **available**: Ready for `minReadySeconds`. Without a readiness probe, "Running" is immediately "Ready", so the rollout happily deletes healthy old Pods while new ones are still warming up.', example: 'kubectl get deploy frontend  # READY vs AVAILABLE' },
  ],
  cluster: {
    seed: 43, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 1800, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.2-rc1`, replicas: 3, port: 8080 }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
    ],
    traffic: [{ id: 'customers', service: 'freight/frontend', rps: 15, label: 'customers' }],
  },
  files: { 'manifests/frontend.yaml': FRONTEND_PROBELESS },
  objectives: [
    { id: 'readiness', text: 'Add a readiness probe (httpGet /readyz on port 8080) to the frontend container', check: (c) => { const p = c.view.deployment('freight', 'frontend')?.spec.template.spec.containers[0]?.readinessProbe; return !!p?.httpGet && p.httpGet.path === '/readyz' && String(p.httpGet.port) === '8080'; } },
    { id: 'liveness', text: 'Add a liveness probe (httpGet /healthz on port 8080)', check: (c) => { const p = c.view.deployment('freight', 'frontend')?.spec.template.spec.containers[0]?.livenessProbe; return !!p?.httpGet && p.httpGet.path === '/healthz' && String(p.httpGet.port) === '8080'; } },
    { id: 'declarative', text: 'Apply the change from the manifest (kubectl apply -f)', check: (c) => usedCmd(c, /^kubectl apply\b.*-f .*frontend/) && !!c.view.deployment('freight', 'frontend')?.metadata.annotations?.['kubectl.kubernetes.io/last-applied-configuration']?.includes('readinessProbe') },
    { id: 'rolled', text: 'Rollout complete: 3/3 ready with probes, no errors served', check: (c) => c.view.deploymentReady('freight', 'frontend', 3) && c.view.pods('freight', 'app=frontend').every((p) => !!p.spec.containers[0]?.readinessProbe) },
    { id: 'survive', text: 'Survive the restart of a pod without serving errors', revealAfter: 'rolled', check: (c) => c.flags.has('restarted') && c.view.deploymentReady('freight', 'frontend', 3) && c.elapsedSec > 0 && c.view.readyPods('freight', 'app=frontend').length === 3 },
  ],
  chaos: [
    { id: 'kill', at: { afterObjective: 'rolled', delaySeconds: 5 }, action: { type: 'killPods', namespace: 'freight', selector: 'app=frontend', count: 1 }, announce: { from: 'node-monitor', text: 'A frontend pod was OOM-killed by the kernel. If your readiness probe is right, nobody notices.' } },
    { id: 'kill-flag', at: { afterObjective: 'rolled', delaySeconds: 5 }, action: { type: 'flag', flag: 'restarted' } },
  ],
  hints: [
    { text: 'Open `manifests/frontend.yaml`. Under the container (same level as `image:`), add `readinessProbe:` with `httpGet: {path: /readyz, port: 8080}` and `periodSeconds: 5`.', cost: 100 },
    { text: 'Add `livenessProbe:` with `httpGet: {path: /healthz, port: 8080}`, `initialDelaySeconds: 5`, `periodSeconds: 10`. Indentation matters: probes sit at the same depth as `image:`.', cost: 100 },
    { text: 'Apply with `kubectl apply -f manifests/frontend.yaml` and watch `kubectl rollout status deployment/frontend -n freight`. New pods stay 0/1 until /readyz answers 200.', cost: 150 },
  ],
  par: { timeSec: 360, commands: 6 }, slo: { minAvailability: 0.995 },
  solution: ['cat manifests/frontend.yaml', { edit: 'manifests/frontend.yaml', replace: [/        ports:\n/, '        readinessProbe:\n          httpGet:\n            path: /readyz\n            port: 8080\n          periodSeconds: 5\n        livenessProbe:\n          httpGet:\n            path: /healthz\n            port: 8080\n          initialDelaySeconds: 5\n          periodSeconds: 10\n        ports:\n'] }, 'kubectl apply -f manifests/frontend.yaml', 'kubectl rollout status deployment/frontend -n freight', 'sleep 30', 'kubectl get pods -n freight'],
  debrief: { proTips: ['A startupProbe with a high failureThreshold is the right tool for very slow starters; it disables liveness until it passes.', 'Never point a liveness probe at something that depends on another service — you will restart healthy pods during someone else\'s outage.', '`kubectl explain pod.spec.containers.readinessProbe` documents every field offline.'] },
};

export const m3_4: Mission = {
  id: '3.4', chapter: 3, order: 4, title: 'Out of memory', tagline: 'Limits, requests, OOMKilled and a Pending pod.',
  ticket: {
    from: 'PagerDuty → scheduler', priority: 'P2', subject: 'scheduler restarts every minute (OOMKilled); route planning is failing',
    body: [
      'The route scheduler (freight/scheduler) restarts constantly. Status says OOMKilled. It loads a ~312 MiB route graph at start.',
      'Give it enough memory to run, but be sensible: the workers are small (2 Gi each) and other things run there too. Keep requests ≤ limits and do not ask for more than a node can give — or the pod will never schedule.',
      'Fix it directly on the Deployment (kubectl set resources or edit) — this one is not managed by CI yet.',
    ],
  },
  concepts: [
    { title: 'Requests and limits', body: '**Requests** are what the scheduler reserves on a node (a Pod only lands where requests fit). **Limits** are enforced at runtime: exceeding the memory limit gets the container **OOMKilled** (exit 137); CPU over the limit is throttled, not killed.', example: 'resources:\n  requests: {cpu: 100m, memory: 384Mi}\n  limits: {memory: 512Mi}' },
    { title: 'QoS classes', body: 'Requests == limits for every resource → **Guaranteed**. Some set → **Burstable**. None → **BestEffort**. Under node memory pressure, BestEffort Pods are evicted first. `kubectl describe pod` shows the class.', example: 'kubectl get pod NAME -o jsonpath=\'{.status.qosClass}\'' },
    { title: 'Pending: Insufficient memory', body: 'If no node has enough **allocatable** memory left for the request, the Pod stays Pending with a `FailedScheduling` event: `0/4 nodes are available: 3 Insufficient memory…`. Check `kubectl describe node` for allocated resources before asking for the moon.', example: 'kubectl describe pod NAME | grep -A3 Events\nkubectl describe node NAME' },
  ],
  cluster: {
    seed: 44, nodes: orbitalNodes({ memory: '2Gi' }), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.0`, replicas: 3, port: 8080, resources: { requests: { cpu: '100m', memory: '600Mi' }, limits: { memory: '700Mi' } } }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
      { ageSeconds: 3 * 86400, object: deployment({ name: 'cargo-api', ns: 'freight', image: `${REG}/cargo-api:2.1.0`, replicas: 2, port: 8080, env: [{ name: 'CARGO_DB_URL', value: 'postgres://cargo-db:5432/cargo' }], resources: { requests: { cpu: '100m', memory: '500Mi' }, limits: { memory: '600Mi' } } }) },
      { ageSeconds: 900, object: deployment({ name: 'scheduler', ns: 'freight', image: `${REG}/scheduler:3.0.2`, replicas: 2, port: 9000, resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '128Mi' } } }) },
      { ageSeconds: 900, object: service({ name: 'scheduler', ns: 'freight', selector: { app: 'scheduler' }, port: 80, targetPort: 9000 }) },
    ],
    traffic: [{ id: 'planner', service: 'freight/scheduler', rps: 6, label: 'route planner' }, { id: 'customers', service: 'freight/frontend', rps: 4, label: 'customers' }],
  },
  objectives: [
    { id: 'diagnose', text: 'Confirm the OOMKilled reason (get pods / describe)', check: (c) => outputHad(c, /OOMKilled/) },
    { id: 'limit', text: 'Raise the scheduler memory limit to at least 400Mi (and keep requests ≤ limits)', check: (c) => { const r = c.view.deployment('freight', 'scheduler')?.spec.template.spec.containers[0]?.resources; const lim = String(r?.limits?.memory ?? ''); const m = /^(\d+)(Mi|Gi)$/.exec(lim); if (!m) return false; const mib = parseInt(m[1] as string, 10) * (m[2] === 'Gi' ? 1024 : 1); return mib >= 400; } },
    { id: 'ready', text: 'scheduler is 2/2 ready and stays up', check: (c) => c.view.deploymentReady('freight', 'scheduler', 2) && c.view.pods('freight', 'app=scheduler').every((p) => (p.status.containerStatuses?.[0]?.restartCount ?? 0) === 0 && isPodReady(p)) },
    { id: 'no-pending', text: 'No scheduler pod is Pending for lack of memory', check: (c) => c.view.deploymentReady('freight', 'scheduler', 2) && c.view.pods('freight', 'app=scheduler').every((p) => p.status.phase === 'Running') },
    { id: 'qos', text: 'Bonus: check the QoS class of a scheduler pod', optional: true, check: (c) => outputHad(c, /QoS Class:\s+(Burstable|Guaranteed)/) || (usedCmd(c, /jsonpath.*qosClass/) && outputHad(c, /Burstable|Guaranteed/)) },
  ],
  hints: [
    { text: '`kubectl get pods -n freight` shows OOMKilled / CrashLoopBackOff for scheduler. `kubectl describe pod <name> -n freight` shows `Last State: Terminated, Reason: OOMKilled` and the current Limits.', cost: 80 },
    { text: 'The app needs ~312 MiB. Try `kubectl set resources deployment/scheduler -n freight --limits=memory=512Mi --requests=memory=384Mi`.', cost: 120 },
    { text: 'If a pod goes Pending, describe it: "Insufficient memory" means your request does not fit on any node. Lower the request (it must still be ≤ limit) — `kubectl describe nodes` shows what is allocated.', cost: 120 },
  ],
  par: { timeSec: 300, commands: 6 }, timeLimitSec: 600, slo: { minAvailability: 0.3 },
  solution: ['kubectl get pods -n freight', 'kubectl describe pod $(kubectl get pods -n freight -l app=scheduler -o name | head -1 | cut -d/ -f2) -n freight', 'kubectl set resources deployment/scheduler -n freight --limits=memory=512Mi --requests=memory=384Mi', 'kubectl rollout status deployment/scheduler -n freight', 'sleep 10', 'kubectl get pods -n freight'],
  debrief: { proTips: ['`kubectl top pods` (metrics-server) shows actual usage so you can right-size instead of guessing.', 'LimitRanges set namespace defaults for requests/limits; ResourceQuotas cap totals — Chapter 6.', 'Memory limits are hard; CPU limits throttle. Many teams set memory limits and only CPU requests.'] },
};

export const m3_5: Mission = {
  id: '3.5', chapter: 3, order: 5, title: 'Night shift', tagline: 'Jobs, CronJobs and a DaemonSet for the new node.',
  ticket: {
    from: 'Ana (team-notify)', priority: 'P3', subject: 'Three batch things before the night window',
    body: [
      '1) Reindex shipments: run a Job named `reindex` in freight using ' + `${REG}/manifest-worker:0.9.0` + ' with 3 completions and parallelism 3.',
      '2) Create a CronJob `nightly-report` in freight (same image) that runs every 2 minutes so we can test it now: schedule "*/2 * * * *".',
      '3) Apply ~/manifests/log-agent.yaml (a DaemonSet). A new node is joining the cluster soon — the agent must land on it automatically.',
    ],
  },
  concepts: [
    { title: 'Jobs run to completion', body: 'A **Job** creates Pods until `completions` succeed, running up to `parallelism` at a time, retrying failures up to `backoffLimit` (6). Pods use `restartPolicy: Never` or `OnFailure`. Indexed Jobs give each Pod an index for sharded work.', example: 'kubectl create job reindex --image=IMG\nkubectl get jobs; kubectl logs job/reindex' },
    { title: 'CronJobs schedule Jobs', body: 'A **CronJob** creates a Job on a cron schedule (`*/2 * * * *` = every 2 minutes). `concurrencyPolicy` (Allow/Forbid/Replace) decides what happens if the previous run is still going; history limits prune old Jobs.', example: 'kubectl create cronjob nightly-report --image=IMG --schedule="*/2 * * * *"' },
    { title: 'DaemonSets: one Pod per node', body: 'A **DaemonSet** runs exactly one Pod on every (matching) node — agents, log shippers, CNI. When a node joins, the Pod appears; when it leaves, the Pod goes. They tolerate NotReady/unschedulable taints by default.', example: 'kubectl get ds -A\nkubectl get pods -l app=log-agent -o wide' },
  ],
  cluster: {
    seed: 45, nodes: orbitalNodes({ workers: 2 }), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.0`, replicas: 2, port: 8080 }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
    ],
    traffic: [{ id: 'customers', service: 'freight/frontend', rps: 3, label: 'customers' }],
  },
  files: { 'manifests/log-agent.yaml': `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: log-agent
  namespace: freight
  labels:
    app: log-agent
spec:
  selector:
    matchLabels:
      app: log-agent
  template:
    metadata:
      labels:
        app: log-agent
    spec:
      containers:
      - name: agent
        image: ${REG}/log-agent:2.4.0
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
` },
  objectives: [
    { id: 'job', text: 'Job reindex completes 3/3 (parallelism 3)', check: (c) => { const j = c.view.get<Job>('Job', 'freight', 'reindex'); return !!j && (j.spec.completions ?? 1) === 3 && (j.spec.parallelism ?? 1) === 3 && !!j.status.conditions?.some((x) => x.type === 'Complete' && x.status === 'True'); } },
    { id: 'cron', text: 'CronJob nightly-report exists with schedule */2 * * * * and has run at least once', check: (c) => { const cj = c.view.get<CronJob>('CronJob', 'freight', 'nightly-report'); return !!cj && cj.spec.schedule.replace(/\s+/g, ' ') === '*/2 * * * *' && !!cj.status.lastScheduleTime; } },
    { id: 'ds', text: 'DaemonSet log-agent runs on every worker node', check: (c) => { const ds = c.view.get<DaemonSet>('DaemonSet', 'freight', 'log-agent'); return !!ds && ds.status.desiredNumberScheduled >= 2 && ds.status.numberReady === ds.status.desiredNumberScheduled; } },
    { id: 'newnode', text: 'The agent lands on the new node orbital-worker-c by itself', revealAfter: 'ds', check: (c) => c.flags.has('node-joined') && c.view.pods('freight', 'app=log-agent').some((p) => p.spec.nodeName === 'orbital-worker-c' && isPodReady(p)) },
    { id: 'logs', text: 'Bonus: read the logs of the reindex job', optional: true, check: (c) => usedCmd(c, /^kubectl logs (job\/reindex|.*reindex-)/) && outputHad(c, /reindexed/) },
  ],
  chaos: [
    { id: 'join', at: { afterObjective: 'ds', delaySeconds: 6 }, action: { type: 'custom', run: (e) => { e.addNode({ name: 'orbital-worker-c', cpu: '4', memory: '8Gi', labels: { 'topology.kubernetes.io/zone': 'dock-c', 'node.orbital.local/pool': 'general' } }); } }, announce: { from: 'cluster-autoscaler', text: 'Node orbital-worker-c joined the cluster.' } },
    { id: 'join-flag', at: { afterObjective: 'ds', delaySeconds: 6 }, action: { type: 'flag', flag: 'node-joined' } },
  ],
  hints: [
    { text: `Fastest: \`kubectl create job reindex --image=${REG}/manifest-worker:0.9.0 -n freight --dry-run=client -o yaml > manifests/reindex.yaml\`, add \`completions: 3\` and \`parallelism: 3\` under spec, apply.`, cost: 100 },
    { text: `\`kubectl create cronjob nightly-report --image=${REG}/manifest-worker:0.9.0 --schedule="*/2 * * * *" -n freight\`. Wait for the next even minute; \`kubectl get jobs -n freight\`.`, cost: 100 },
    { text: '`kubectl apply -f manifests/log-agent.yaml` then `kubectl get ds -n freight` and `kubectl get pods -n freight -o wide` — one agent per worker.', cost: 100 },
  ],
  par: { timeSec: 480, commands: 10 },
  solution: [`kubectl create job reindex --image=${REG}/manifest-worker:0.9.0 -n freight --dry-run=client -o yaml > manifests/reindex.yaml`, { edit: 'manifests/reindex.yaml', replace: ['spec:\n  template:', 'spec:\n  completions: 3\n  parallelism: 3\n  template:'] }, 'kubectl apply -f manifests/reindex.yaml', `kubectl create cronjob nightly-report --image=${REG}/manifest-worker:0.9.0 --schedule="*/2 * * * *" -n freight`, 'kubectl apply -f manifests/log-agent.yaml', 'kubectl wait --for=condition=Complete job/reindex -n freight --timeout=120s', 'kubectl logs job/reindex -n freight', 'sleep 150', 'kubectl get jobs,cronjobs,ds -n freight', 'kubectl get pods -n freight -o wide'],
  debrief: { proTips: ['`ttlSecondsAfterFinished` cleans up finished Jobs automatically.', 'Use `kubectl create job manual-run --from=cronjob/nightly-report` (real kubectl) to trigger a CronJob by hand.', 'DaemonSet Pods are scheduled with node affinity and tolerate the unschedulable taint — cordoning a node does not remove them.'] },
};

export const m3_6: Mission = {
  id: '3.6', chapter: 3, order: 6, title: 'Capstone: Zero-downtime Friday', tagline: 'Two releases, a policy, a dead node and a kernel patch.',
  ticket: {
    from: 'Chief Helmsman Okafor', priority: 'P1', subject: 'Friday release + maintenance window — I need this to be boring',
    body: [
      '1) Release frontend 1.4.1 and cargo-api 2.1.1. Platform policy from today: every container has readiness+liveness probes and memory limits. Manifests are in ~/manifests/. Zero downtime; SLO ≥ 99%.',
      '2) Infra will patch the kernel on orbital-worker-a after the release. When they ask, drain it properly (ignore DaemonSets), wait for them, then uncordon it.',
      '3) And whatever happens, keep 3 frontends ready. I have a bad feeling about worker-b.',
      'Database URL for cargo-api is already in the manifest. Frontend endpoints: /readyz and /healthz on 8080; cargo-api: /readyz and /healthz on 8080.',
    ],
  },
  concepts: [
    { title: 'cordon, drain, uncordon', body: '`cordon` marks a node unschedulable (existing Pods stay). `drain` cordons and then evicts every Pod (DaemonSet Pods are skipped with `--ignore-daemonsets`); controllers recreate them elsewhere. After maintenance, `uncordon` lets the scheduler use the node again.', example: 'kubectl drain orbital-worker-a --ignore-daemonsets\nkubectl uncordon orbital-worker-a' },
    { title: 'When a node dies', body: 'A NotReady node gets `node.kubernetes.io/unreachable` taints. Its Pods are marked NotReady at once (traffic stops) but are only evicted after `tolerationSeconds` (default 5 min — this cluster uses 40s). Until then the ReplicaSet sees "enough" Pods and does nothing: capacity headroom matters.', example: 'kubectl get nodes\nkubectl get pods -o wide' },
    { title: 'Policy as YAML', body: 'Probes and resource limits belong in the manifest, reviewed with the code. Admission policies (Chapter 5) can reject Pods without them; today you are the policy.', example: 'kubectl explain deployment.spec.template.spec.containers.resources' },
  ],
  cluster: {
    seed: 46, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES, evictionSeconds: 40,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.0`, replicas: 3, port: 8080 }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
      { ageSeconds: 3 * 86400, object: deployment({ name: 'cargo-api', ns: 'freight', image: `${REG}/cargo-api:2.1.0`, replicas: 2, port: 8080, env: [{ name: 'CARGO_DB_URL', value: 'postgres://cargo-db.freight.svc.cluster.local:5432/cargo' }] }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'cargo-api', ns: 'freight', selector: { app: 'cargo-api' }, port: 80, targetPort: 8080 }) },
      { ageSeconds: 5 * 86400, object: deployment({ name: 'cargo-db', ns: 'freight', image: 'redis:7', replicas: 1, port: 6379, containerName: 'db' }) },
      { ageSeconds: 6 * 86400, object: { apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: 'log-agent', namespace: 'freight', labels: { app: 'log-agent' } }, spec: { selector: { matchLabels: { app: 'log-agent' } }, template: { metadata: { labels: { app: 'log-agent' } }, spec: { containers: [{ name: 'agent', image: `${REG}/log-agent:2.4.0` }] } } }, status: {} } },
    ],
    traffic: [{ id: 'customers', service: 'freight/frontend', rps: 20, label: 'customers' }, { id: 'cargo', service: 'freight/cargo-api', rps: 8, label: 'cargo page' }],
  },
  files: {
    'manifests/frontend.yaml': yamlOf(deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.0`, replicas: 3, port: 8080 })),
    'manifests/cargo-api.yaml': yamlOf(deployment({ name: 'cargo-api', ns: 'freight', image: `${REG}/cargo-api:2.1.0`, replicas: 2, port: 8080, env: [{ name: 'CARGO_DB_URL', value: 'postgres://cargo-db.freight.svc.cluster.local:5432/cargo' }] })),
  },
  objectives: [
    { id: 'policy', text: 'frontend and cargo-api containers have readiness + liveness probes and a memory limit', check: (c) => ['frontend', 'cargo-api'].every((n) => { const ct = c.view.deployment('freight', n)?.spec.template.spec.containers[0]; return !!ct?.readinessProbe && !!ct?.livenessProbe && ct.resources?.limits?.memory !== undefined; }) },
    { id: 'frontend', text: 'frontend 1.4.1 rolled out, 3/3 ready', check: (c) => c.view.deploymentImage('freight', 'frontend') === `${REG}/frontend:1.4.1` && c.view.deploymentReady('freight', 'frontend', 3) },
    { id: 'cargo', text: 'cargo-api 2.1.1 rolled out, 2/2 ready', check: (c) => c.view.deploymentImage('freight', 'cargo-api') === `${REG}/cargo-api:2.1.1` && c.view.deploymentReady('freight', 'cargo-api', 2) },
    { id: 'nodeloss', text: 'worker-b is down: get back to 3 ready frontends on the remaining nodes', revealAfter: 'cargo', check: (c) => c.flags.has('worker-b-down') && c.view.readyPods('freight', 'app=frontend').filter((p) => p.spec.nodeName !== 'orbital-worker-b').length >= 3 },
    { id: 'drain', text: 'Drain orbital-worker-a for the kernel patch (ignore DaemonSets)', revealAfter: 'nodeloss', check: (c) => c.flags.has('patch-requested') && usedCmd(c, /^kubectl drain orbital-worker-a\b/) && !!c.view.node('orbital-worker-a')?.spec.unschedulable && c.view.pods('freight').every((p) => p.spec.nodeName !== 'orbital-worker-a' || p.metadata.ownerReferences?.some((r) => r.kind === 'DaemonSet')) },
    { id: 'uncordon', text: 'Patch done: uncordon orbital-worker-a, everything ready', revealAfter: 'drain', check: (c) => c.flags.has('patch-done') && !c.view.node('orbital-worker-a')?.spec.unschedulable && c.view.deploymentReady('freight', 'frontend', 3) && c.view.deploymentReady('freight', 'cargo-api', 2) },
  ],
  chaos: [
    { id: 'b-down', at: { afterObjective: 'cargo', delaySeconds: 8 }, action: { type: 'nodeDown', node: 'orbital-worker-b' }, announce: { from: 'node-monitor', text: 'orbital-worker-b stopped reporting (power event in dock-b). Pods on it are NotReady.' } },
    { id: 'b-flag', at: { afterObjective: 'cargo', delaySeconds: 8 }, action: { type: 'flag', flag: 'worker-b-down' } },
    { id: 'b-up', at: { afterObjective: 'nodeloss', delaySeconds: 25 }, action: { type: 'nodeUp', node: 'orbital-worker-b' }, announce: { from: 'node-monitor', text: 'orbital-worker-b is back (Ready).' } },
    { id: 'patch', at: { afterObjective: 'nodeloss', delaySeconds: 30 }, action: { type: 'flag', flag: 'patch-requested' }, announce: { from: 'infra (Marco)', text: 'Ready to patch orbital-worker-a. Drain it and tell me when it is empty.' } },
    { id: 'patched', at: { afterObjective: 'drain', delaySeconds: 20 }, action: { type: 'flag', flag: 'patch-done' }, announce: { from: 'infra (Marco)', text: 'worker-a patched and rebooted. You can uncordon it.' } },
  ],
  hints: [
    { text: 'Edit both manifests: bump the image tags, add readinessProbe/livenessProbe (httpGet on /readyz and /healthz, port 8080) and `resources.limits.memory` (e.g. 256Mi). Apply both, watch `rollout status`.', cost: 120 },
    { text: 'When worker-b dies, its pods stay in the list as NotReady for 40s, then get evicted and replaced. Just make sure the Deployment ends with 3 ready pods on other nodes — scale up temporarily if you need headroom.', cost: 120 },
    { text: '`kubectl drain orbital-worker-a --ignore-daemonsets` (add `--delete-emptydir-data` if asked). After the patch: `kubectl uncordon orbital-worker-a`.', cost: 150 },
  ],
  par: { timeSec: 600, commands: 16 }, timeLimitSec: 900, slo: { minAvailability: 0.99 },
  solution: [
    { edit: 'manifests/frontend.yaml', replace: [/        image: .*\n/, `        image: ${REG}/frontend:1.4.1\n        readinessProbe:\n          httpGet:\n            path: /readyz\n            port: 8080\n          periodSeconds: 5\n        livenessProbe:\n          httpGet:\n            path: /healthz\n            port: 8080\n          periodSeconds: 10\n        resources:\n          limits:\n            memory: 256Mi\n`] },
    { edit: 'manifests/cargo-api.yaml', replace: [/        image: .*\n/, `        image: ${REG}/cargo-api:2.1.1\n        readinessProbe:\n          httpGet:\n            path: /readyz\n            port: 8080\n          periodSeconds: 5\n        livenessProbe:\n          httpGet:\n            path: /healthz\n            port: 8080\n          periodSeconds: 10\n        resources:\n          limits:\n            memory: 256Mi\n`] },
    'kubectl apply -f manifests/', 'kubectl rollout status deployment/frontend -n freight', 'kubectl rollout status deployment/cargo-api -n freight',
    'sleep 10', 'kubectl get nodes', 'kubectl get pods -n freight -o wide', 'sleep 60', 'kubectl get pods -n freight -o wide', 'sleep 10',
    'kubectl drain orbital-worker-a --ignore-daemonsets', 'kubectl get pods -n freight -o wide', 'sleep 22', 'kubectl uncordon orbital-worker-a', 'kubectl get nodes', 'sleep 3',
  ],
  debrief: { proTips: ['PodDisruptionBudgets make `drain` wait so you never evict below a minimum — Chapter 6.', 'Spread replicas across nodes/zones with topologySpreadConstraints so one node loss cannot take all of them.', 'Shorter `tolerationSeconds` on critical Deployments means faster replacement after node loss, at the risk of flapping.'] },
};

export const chapter3: Mission[] = [m3_1, m3_2, m3_3, m3_4, m3_5, m3_6];
void ((0 as unknown) as Pod);
