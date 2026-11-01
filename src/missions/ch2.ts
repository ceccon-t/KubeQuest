import type { Mission } from '../game/mission.ts';
import { ORBITAL_IMAGES, REG, deployment, service, pod, orbitalNodes, systemWorkloads, usedCmd, usedCmdAll, outputHad } from './lib.ts';
import { LAST_APPLIED } from '../engine/kubectl/commands/apply.ts';

const CARGO_MANIFEST = `# cargo-api — freight namespace
# Owner: team-cargo. Deployed by CI from manifests/cargo-api.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cargo-api
  namespace: freight
  labels:
    app: cargo-api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: cargo-api
  template:
    metadata:
      labels:
        app: cargo-api
    spec:
      containers:
      - name: cargo-api
        image: ${REG}/cargo-api:2.1.0
        ports:
        - containerPort: 8080
        env:
        - name: LOG_LEVEL
          value: info
        # TODO(team-cargo): database settings moved to env in 2.1 — see runbook
`;

export const m2_1: Mission = {
  id: '2.1', chapter: 2, order: 1, title: 'Where is everything?', tagline: 'Four namespaces, one sick pod, four minutes.',
  ticket: {
    from: 'Chief Helmsman Okafor', priority: 'P3', subject: 'Something is crash-looping somewhere — find it and tag it',
    body: [
      'Monitoring says a pod has been restarting for the last 20 minutes but the alert lost its namespace label (thanks, Grafana).',
      'Find the crash-looping pod. Label it `triage=p1` so the owning team sees it on their board, and tell me which node it runs on.',
      'While you are at it, set your default namespace to the one where it lives — you will be living there for a while.',
    ],
  },
  concepts: [
    { title: '-n, -A and your context', body: 'Namespaced objects are listed per namespace. `-n NAME` picks one, `-A` lists all. Your kubeconfig **context** carries a default namespace; change it with `kubectl config set-context --current --namespace=NAME` so you can stop typing `-n`.', example: 'kubectl get pods -A\nkubectl config set-context --current --namespace=billing' },
    { title: 'Labels and selectors', body: 'Labels are key/value tags on objects. Selectors pick objects by label: `-l app=web`, `-l "tier in (api,web)"`, `-l \'!canary\'`. Controllers and Services find their Pods this way, and so can you.', example: 'kubectl get pods -l app=rate-limiter --show-labels\nkubectl label pod NAME triage=p1' },
    { title: 'Wide output', body: '`-o wide` adds the Pod IP and the **node** it runs on (plus nominated node and readiness gates). `-o yaml` / `-o json` show the full object; `-o jsonpath=…` extracts fields.', example: 'kubectl get pods -o wide\nkubectl get pod NAME -o jsonpath=\'{.spec.nodeName}\'' },
  ],
  cluster: {
    seed: 31, nodes: orbitalNodes(), namespaces: ['freight', 'billing', 'observability', 'dev-sandbox'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.0`, replicas: 3, port: 8080 }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
      { ageSeconds: 2 * 86400, object: deployment({ name: 'cargo-api', ns: 'freight', image: `${REG}/cargo-api:2.1.0`, replicas: 2, port: 8080, env: [{ name: 'CARGO_DB_URL', value: 'postgres://cargo-db:5432/cargo' }] }) },
      { ageSeconds: 9 * 86400, object: deployment({ name: 'invoicer', ns: 'billing', image: `${REG}/notifier:1.2.0`, replicas: 2, port: 8080 }) },
      { ageSeconds: 1200, object: deployment({ name: 'rate-limiter', ns: 'billing', image: `${REG}/rate-limiter:0.3.1`, replicas: 1, port: 8080, labels: { app: 'rate-limiter', tier: 'edge' } }) },
      { ageSeconds: 6 * 86400, object: deployment({ name: 'grafana', ns: 'observability', image: 'nginx:1.27', replicas: 1, port: 80 }) },
      { ageSeconds: 6 * 86400, object: deployment({ name: 'prometheus', ns: 'observability', image: 'nginx:1.27', replicas: 1, port: 80 }) },
      { ageSeconds: 3600, object: pod({ name: 'scratch-shell', ns: 'dev-sandbox', image: `${REG}/debug:1.0`, labels: { run: 'scratch-shell', owner: 'ana' } }) },
    ],
    traffic: [{ id: 'customers', service: 'freight/frontend', rps: 4, label: 'customers' }],
  },
  objectives: [
    { id: 'all', text: 'List pods across all namespaces and spot the one that keeps restarting', check: (c) => usedCmd(c, /^kubectl get (pods?|po)\b.*(-A|--all-namespaces)/) && outputHad(c, /CrashLoopBackOff|Error\s/) },
    { id: 'node', text: 'Find which node the rate-limiter pod runs on (-o wide or jsonpath)', check: (c) => (usedCmd(c, /^kubectl get (pods?|po)\b.*-o[= ]wide/) || usedCmd(c, /^kubectl get (pods?|po)\b.*jsonpath.*nodeName/) || usedCmd(c, /^kubectl describe (pods?|po)[ /]rate-limiter/)) && outputHad(c, /orbital-worker-[abc]/) },
    { id: 'label', text: 'Label the crash-looping pod triage=p1', check: (c) => c.view.pods('billing', 'app=rate-limiter').some((p) => p.metadata.labels?.triage === 'p1') },
    { id: 'ctx', text: 'Set your context\'s default namespace to billing', check: (c) => c.engine.currentNamespace === 'billing' },
    { id: 'selector', text: 'Bonus: list only the edge-tier pods with a label selector (-l tier=edge)', optional: true, check: (c) => usedCmd(c, /^kubectl get (pods?|po)\b.*(-l|--selector)[= ]["']?tier=edge/) },
  ],
  hints: [
    { text: '`kubectl get pods -A` lists every namespace. Look for a STATUS of CrashLoopBackOff or a high RESTARTS count.', cost: 80 },
    { text: 'Add `-o wide` to see the NODE column. Then `kubectl label pod <name> triage=p1 -n billing`.', cost: 100 },
    { text: '`kubectl config set-context --current --namespace=billing` changes the default namespace for every following command.', cost: 100 },
  ],
  par: { timeSec: 240, commands: 6 }, timeLimitSec: 420,
  solution: ['kubectl get pods -A', 'kubectl get pods -n billing -o wide', 'kubectl label pod $(kubectl get pods -n billing -l app=rate-limiter -o name | cut -d/ -f2) triage=p1 -n billing', 'kubectl config set-context --current --namespace=billing', 'kubectl get pods -l tier=edge'],
  debrief: { proTips: ['`kubectl get pods -A --sort-by=.status.containerStatuses[0].restartCount` floats restart-happy pods to the bottom.', 'Field selectors filter on object fields rather than labels: `--field-selector status.phase!=Running`.', 'The rate-limiter crashes because it cannot resolve `redis-cache` — that is a Chapter 4 story.'] },
};

export const m2_2: Mission = {
  id: '2.2', chapter: 2, order: 2, title: 'Logs don\'t lie', tagline: 'A crash loop, a missing variable, and a manifest to fix.',
  ticket: {
    from: 'PagerDuty → cargo-api', priority: 'P1', subject: 'cargo-api CrashLoopBackOff after 2.1.0 rollout — customers can\'t book cargo',
    body: [
      'cargo-api 2.1.0 rolled out 10 minutes ago and immediately started crash-looping. The cargo page is down.',
      'Team-cargo\'s runbook says 2.1 moved the database settings into the environment. The database URL is: postgres://cargo-db.freight.svc.cluster.local:5432/cargo',
      'The deployment manifest is in ~/manifests/cargo-api.yaml. Read the logs, find the problem, fix it the declarative way (edit the manifest and apply it) so CI does not undo your change.',
    ],
  },
  concepts: [
    { title: 'Reading container logs', body: '`kubectl logs POD` prints the current container\'s stdout/stderr. In a crash loop the current container may have just restarted and printed nothing yet — `--previous` (`-p`) shows the logs of the **last terminated** container, which is where the error is.', example: 'kubectl logs POD --previous\nkubectl logs deploy/cargo-api --tail=20' },
    { title: 'Events tell you what the kubelet did', body: '`kubectl describe pod` ends with Events: pulls, container starts, probe failures, and `Back-off restarting failed container`. The container\'s **Last State** block shows the exit code (1 = app error, 137 = killed / OOM).', example: 'kubectl describe pod POD -n freight' },
    { title: 'Declarative fixes survive CI', body: 'If you `kubectl set env` on the live Deployment, the next `kubectl apply` from CI (using the manifest in git) will overwrite it. Fix the **manifest** and `kubectl apply -f` it — the same command CI runs. Kubernetes computes the difference and rolls out the change.', example: 'vim manifests/cargo-api.yaml\nkubectl apply -f manifests/cargo-api.yaml' },
  ],
  cluster: {
    seed: 32, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.0`, replicas: 2, port: 8080 }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
      { ageSeconds: 600, object: { ...deployment({ name: 'cargo-api', ns: 'freight', image: `${REG}/cargo-api:2.1.0`, replicas: 2, port: 8080, env: [{ name: 'LOG_LEVEL', value: 'info' }] }), metadata: { name: 'cargo-api', namespace: 'freight', labels: { app: 'cargo-api' }, annotations: { [LAST_APPLIED]: JSON.stringify({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { labels: { app: 'cargo-api' }, name: 'cargo-api', namespace: 'freight' }, spec: { replicas: 2, selector: { matchLabels: { app: 'cargo-api' } }, template: { metadata: { labels: { app: 'cargo-api' } }, spec: { containers: [{ env: [{ name: 'LOG_LEVEL', value: 'info' }], image: `${REG}/cargo-api:2.1.0`, name: 'cargo-api', ports: [{ containerPort: 8080 }] }] } } } }) + '\n' } } } },
      { ageSeconds: 3 * 86400, object: service({ name: 'cargo-api', ns: 'freight', selector: { app: 'cargo-api' }, port: 80, targetPort: 8080 }) },
      { ageSeconds: 5 * 86400, object: deployment({ name: 'cargo-db', ns: 'freight', image: 'redis:7', replicas: 1, port: 6379, containerName: 'db' }) },
    ],
    traffic: [{ id: 'cargo', service: 'freight/cargo-api', rps: 8, label: 'cargo page' }, { id: 'customers', service: 'freight/frontend', rps: 3, label: 'customers' }],
  },
  files: { 'manifests/cargo-api.yaml': CARGO_MANIFEST },
  objectives: [
    { id: 'logs', text: 'Read the crash logs (kubectl logs, --previous if needed)', check: (c) => usedCmd(c, /^kubectl logs\b/) && outputHad(c, /CARGO_DB_URL is not set/) },
    { id: 'describe', text: 'Bonus: confirm the exit code and restarts with describe', optional: true, check: (c) => usedCmd(c, /^kubectl describe (pods?|po)[ /]cargo-api/) && outputHad(c, /Exit Code:\s+1/) },
    { id: 'env', text: 'Set CARGO_DB_URL on the cargo-api deployment to the URL from the runbook', check: (c) => { const d = c.view.deployment('freight', 'cargo-api'); const e = d?.spec.template.spec.containers[0]?.env?.find((x) => x.name === 'CARGO_DB_URL'); return !!e && /cargo-db/.test(e.value ?? ''); } },
    { id: 'declarative', text: 'Do it declaratively: the fix must come from kubectl apply -f of the manifest', check: (c) => { const d = c.view.deployment('freight', 'cargo-api'); const la = d?.metadata.annotations?.[LAST_APPLIED] ?? ''; return la.includes('CARGO_DB_URL') && usedCmd(c, /^kubectl apply\b.*-f/); } },
    { id: 'ready', text: 'cargo-api is 2/2 ready and serving', check: (c) => c.view.deploymentReady('freight', 'cargo-api', 2) && c.view.endpointsReady('freight', 'cargo-api') === 2 },
  ],
  hints: [
    { text: '`kubectl get pods -n freight` → pick a cargo-api pod → `kubectl logs <pod> -n freight --previous`.', cost: 80 },
    { text: 'The log says a required environment variable is missing. Open the manifest with `vim manifests/cargo-api.yaml` and add it under `env:` next to LOG_LEVEL (name: CARGO_DB_URL, value: the URL from the ticket).', cost: 120 },
    { text: 'Save, then `kubectl apply -f manifests/cargo-api.yaml` and watch with `kubectl rollout status deployment/cargo-api -n freight`.', cost: 150 },
  ],
  par: { timeSec: 300, commands: 7 }, timeLimitSec: 600, slo: { minAvailability: 0.3 },
  solution: ['kubectl get pods -n freight', 'kubectl logs $(kubectl get pods -n freight -l app=cargo-api -o name | head -1) -n freight --previous', 'kubectl describe pod $(kubectl get pods -n freight -l app=cargo-api -o name | head -1 | cut -d/ -f2) -n freight', { edit: 'manifests/cargo-api.yaml', replace: ['          value: info\n', '          value: info\n        - name: CARGO_DB_URL\n          value: postgres://cargo-db.freight.svc.cluster.local:5432/cargo\n'] }, 'kubectl apply -f manifests/cargo-api.yaml', 'kubectl rollout status deployment/cargo-api -n freight', 'sleep 3'],
  debrief: { proTips: ['`kubectl logs deploy/cargo-api` picks a pod for you; `-l app=cargo-api --prefix` streams all of them.', 'Put configuration in a ConfigMap and reference it with `envFrom` — Chapter 5 covers it.', 'Exit code 1 is the app complaining; 137 means the kernel or kubelet killed it (OOM, failed liveness probe).'] },
};

export const m2_3: Mission = {
  id: '2.3', chapter: 2, order: 3, title: 'Declarative by Friday', tagline: 'Turn a hand-made pod into a manifest in git.',
  ticket: {
    from: 'Ana (team-notify)', priority: 'P4', subject: 'notifier was created by hand — please make it a real Deployment with a manifest',
    body: [
      'Someone ran `kubectl run notifier-manual --image=…` in freight last week and it is still there, unmanaged. If the node dies, it dies. CI cannot update it.',
      'Please: (1) generate a Deployment manifest named `notifier` for image ' + `${REG}/notifier:1.2.0` + ' with 2 replicas using --dry-run=client -o yaml and save it under ~/manifests/, (2) apply it, (3) delete the hand-made pod, (4) then bump replicas to 3 by editing the file and re-applying — not with kubectl scale.',
      'The point: the YAML file is the source of truth. Anything you do by hand gets lost.',
    ],
  },
  concepts: [
    { title: 'Imperative vs declarative', body: '**Imperative** commands (`run`, `create deployment`, `scale`, `set image`) tell the API server what to do now. **Declarative** means describing the desired state in YAML and letting `kubectl apply -f` reconcile it — repeatable, reviewable, versionable. Use imperative commands to generate YAML, then apply.', example: 'kubectl create deployment notifier --image=IMG --replicas=2 --dry-run=client -o yaml > manifests/notifier.yaml' },
    { title: '--dry-run=client -o yaml', body: '`--dry-run=client` builds the object locally without sending it; `-o yaml` prints it. Redirect to a file and you have a manifest to edit and commit. `creationTimestamp: null` and `status: {}` are harmless artefacts.', example: 'kubectl run tmp --image=nginx --dry-run=client -o yaml' },
    { title: 'apply remembers what you applied', body: '`kubectl apply` stores the applied manifest in the `kubectl.kubernetes.io/last-applied-configuration` annotation and uses it to compute a three-way diff next time. First apply says `created`, later ones `configured` or `unchanged`.', example: 'kubectl apply -f manifests/notifier.yaml\nkubectl get deploy notifier -o yaml | grep last-applied' },
  ],
  cluster: {
    seed: 33, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.0`, replicas: 2, port: 8080 }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
      { ageSeconds: 7 * 86400, object: pod({ name: 'notifier-manual', ns: 'freight', image: `${REG}/notifier:1.2.0`, labels: { run: 'notifier-manual' }, port: 8080 }) },
    ],
    traffic: [{ id: 'customers', service: 'freight/frontend', rps: 3, label: 'customers' }],
  },
  files: { 'manifests/README.md': 'Manifests for the freight namespace. CI runs: kubectl apply -f manifests/ -n freight\n' },
  objectives: [
    { id: 'dryrun', text: 'Generate a Deployment manifest with --dry-run=client -o yaml and save it under manifests/', check: (c) => usedCmdAll(c, /^kubectl create deployment notifier\b/, /--dry-run[= ]client/, /-o[= ]yaml/, />\s*(~\/)?manifests\//) },
    { id: 'apply', text: 'Apply it: Deployment notifier in freight, 2 replicas ready', check: (c) => { const d = c.view.deployment('freight', 'notifier'); return !!d && !!d.metadata.annotations?.[LAST_APPLIED] && c.view.deploymentReady('freight', 'notifier', 2); } },
    { id: 'delete', text: 'Delete the hand-made pod notifier-manual', check: (c) => !c.view.pod('freight', 'notifier-manual'), revealAfter: 'apply' },
    { id: 'scale-declarative', text: 'Bump replicas to 3 by editing the file and re-applying (not kubectl scale)', revealAfter: 'apply', check: (c) => { const d = c.view.deployment('freight', 'notifier'); const la = d?.metadata.annotations?.[LAST_APPLIED] ?? ''; return !!d && (d.spec.replicas ?? 1) === 3 && /"replicas":3/.test(la) && c.view.deploymentReady('freight', 'notifier', 3); } },
  ],
  hints: [
    { text: `\`kubectl create deployment notifier --image=${REG}/notifier:1.2.0 --replicas=2 -n freight --dry-run=client -o yaml > manifests/notifier.yaml\` — then \`cat\` it to see what you got.`, cost: 100 },
    { text: '`kubectl apply -f manifests/notifier.yaml -n freight`, then `kubectl delete pod notifier-manual -n freight`.', cost: 100 },
    { text: 'Open the file (`vim manifests/notifier.yaml`), change `replicas: 2` to `replicas: 3`, save, and apply again. The output should say `configured`.', cost: 100 },
  ],
  par: { timeSec: 300, commands: 8 },
  solution: [`kubectl create deployment notifier --image=${REG}/notifier:1.2.0 --replicas=2 -n freight --dry-run=client -o yaml > manifests/notifier.yaml`, 'cat manifests/notifier.yaml', 'kubectl apply -f manifests/notifier.yaml -n freight', 'kubectl rollout status deployment/notifier -n freight', 'kubectl delete pod notifier-manual -n freight', { edit: 'manifests/notifier.yaml', replace: ['replicas: 2', 'replicas: 3'] }, 'kubectl apply -f manifests/notifier.yaml -n freight', 'kubectl rollout status deployment/notifier -n freight'],
  debrief: { proTips: ['`kubectl diff -f file.yaml` (real kubectl) shows what apply would change before you apply it.', 'Keep `namespace:` in metadata so the manifest applies to the right place regardless of your context.', 'A directory works too: `kubectl apply -f manifests/` applies every YAML in it.'] },
};

export const m2_4: Mission = {
  id: '2.4', chapter: 2, order: 4, title: 'Inside the box', tagline: 'exec, port-forward and a little curl.',
  ticket: {
    from: 'Priya (QA)', priority: 'P4', subject: 'Can you check the frontend from inside the cluster and from your laptop?',
    body: [
      'We suspect a proxy issue. Please verify from inside a frontend pod that /healthz answers, print the pod\'s environment, and then port-forward the frontend to your workstation and fetch the home page with curl.',
      'There is also a debug pod (tools) in freight if you need a shell with curl and nslookup.',
    ],
  },
  concepts: [
    { title: 'kubectl exec', body: 'Run a command inside a running container: `kubectl exec POD -- CMD`. Add `-it` for an interactive shell (`-- sh`). Use `-c NAME` to choose the container in multi-container Pods. The `--` separates kubectl flags from the container command.', example: 'kubectl exec POD -- env\nkubectl exec -it POD -- sh' },
    { title: 'kubectl port-forward', body: 'Tunnels a local port to a Pod (or Service) port through the API server, without exposing anything. It blocks the terminal — run it in the background with `&` (or a second terminal) and `curl localhost:PORT`. Ctrl+C / `kill %1` stops it.', example: 'kubectl port-forward pod/NAME 8080:8080 &\ncurl localhost:8080' },
    { title: 'Service DNS only resolves inside', body: 'From inside the cluster `curl http://frontend.freight.svc.cluster.local` works via cluster DNS. From your workstation that name does not resolve — use port-forward, a NodePort or a LoadBalancer.', example: 'kubectl exec tools -- nslookup frontend.freight' },
  ],
  cluster: {
    seed: 34, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.0`, replicas: 2, port: 8080, env: [{ name: 'FEATURE_FLAGS', value: 'new-checkout,dark-mode' }] }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
      { ageSeconds: 3600, object: pod({ name: 'tools', ns: 'freight', image: `${REG}/debug:1.0`, labels: { run: 'tools' } }) },
    ],
    traffic: [{ id: 'customers', service: 'freight/frontend', rps: 4, label: 'customers' }],
  },
  objectives: [
    { id: 'env', text: 'Print the environment of a frontend pod with kubectl exec', check: (c) => usedCmd(c, /^kubectl exec .*frontend-.* -- (env|printenv)/) && outputHad(c, /FEATURE_FLAGS=/) },
    { id: 'healthz', text: 'From inside a pod, fetch http://frontend/healthz (exec + curl or wget)', check: (c) => usedCmd(c, /^kubectl exec .* -- (curl|wget).*frontend.*healthz/) && outputHad(c, /^ok/m) },
    { id: 'pf', text: 'Port-forward the frontend to localhost and curl it from your workstation', check: (c) => usedCmd(c, /^kubectl port-forward\b.*frontend/) && usedCmd(c, /^curl .*localhost:\d+/) && outputHad(c, /freight-frontend 1\.4\.0 ok/) },
    { id: 'dns', text: 'Bonus: resolve frontend.freight.svc.cluster.local from the tools pod', optional: true, check: (c) => usedCmd(c, /^kubectl exec .*tools.* -- nslookup frontend/) },
  ],
  hints: [
    { text: '`kubectl exec <frontend-pod> -n freight -- env`. Tab completes the pod name.', cost: 80 },
    { text: '`kubectl exec <frontend-pod> -n freight -- curl -s http://frontend/healthz` — inside the cluster the Service name resolves.', cost: 100 },
    { text: '`kubectl port-forward deploy/frontend 8080:8080 -n freight &` then `curl localhost:8080`. Stop it with `kill %1`.', cost: 100 },
  ],
  par: { timeSec: 240, commands: 7 },
  solution: ['kubectl exec $(kubectl get pods -n freight -l app=frontend -o name | head -1 | cut -d/ -f2) -n freight -- env', 'kubectl exec tools -n freight -- curl -s http://frontend/healthz', 'kubectl exec tools -n freight -- nslookup frontend.freight.svc.cluster.local', 'kubectl port-forward deploy/frontend 8080:8080 -n freight &', 'sleep 1', 'curl -s localhost:8080', 'kill %1'],
  debrief: { proTips: ['`kubectl exec -it POD -- sh` gives you a shell; `exit` leaves it.', 'Images without a shell (distroless) need `kubectl debug` with an ephemeral container — Chapter 3.', '`kubectl port-forward svc/frontend 8080:80` forwards through the Service port mapping.'] },
};

export const chapter2: Mission[] = [m2_1, m2_2, m2_3, m2_4];
