import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/engine/engine.ts';
import { makeShell, runLine } from '../../src/engine/testing.ts';

const DEPLOY_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels:
    app: web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: web
        image: nginx:1.27
        ports:
        - containerPort: 80
`;

function setup() {
  const engine = new Engine({ seed: 7, nodes: [{ name: 'cp-1', roles: ['control-plane'] }, { name: 'worker-a' }, { name: 'worker-b' }], clusterAgeSeconds: 3 * 86400 });
  return { engine, ...makeShell(engine, { 'web.yaml': DEPLOY_YAML }) };
}

test('get nodes layout and errors mirror kubectl', async () => {
  const { shell, host } = setup();
  const r = await runLine(shell, host, 'kubectl get nodes');
  assert.equal(r.stdout, `NAME       STATUS   ROLES           AGE   VERSION
cp-1       Ready    control-plane   3d    v1.32.3
worker-a   Ready    <none>          3d    v1.32.3
worker-b   Ready    <none>          3d    v1.32.3
`);
  const e1 = await runLine(shell, host, 'kubectl get foo');
  assert.equal(e1.stderr, 'error: the server doesn\'t have a resource type "foo"\n');
  assert.equal(e1.code, 1);
  const e2 = await runLine(shell, host, 'kubectl get pod nope');
  assert.equal(e2.stderr, 'Error from server (NotFound): pods "nope" not found\n');
  const e3 = await runLine(shell, host, 'kubectl get pods');
  assert.equal(e3.stderr, 'No resources found in default namespace.\n');
  const e4 = await runLine(shell, host, 'kubectl get pods --bogus');
  assert.equal(e4.stderr, 'error: unknown flag: --bogus\n');
  const e5 = await runLine(shell, host, 'kubectl gte pods');
  assert.match(e5.stderr, /unknown command "gte" for "kubectl"/);
  assert.match(e5.stderr, /Did you mean this\?\n\tget/);
});

test('apply, get pods/deploy/rs/svc, describe, rollout, logs, exec, delete', async () => {
  const { shell, host, engine } = setup();
  let r = await runLine(shell, host, 'kubectl apply -f web.yaml');
  assert.equal(r.stdout, 'deployment.apps/web created\n');
  r = await runLine(shell, host, 'kubectl apply -f web.yaml');
  assert.equal(r.stdout, 'deployment.apps/web unchanged\n');
  engine.advance(12);
  r = await runLine(shell, host, 'kubectl get pods');
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines[0], 'NAME                   READY   STATUS    RESTARTS   AGE');
  assert.equal(lines.length, 4);
  for (const l of lines.slice(1)) assert.match(l, /^web-[a-z0-9]+-[a-z0-9]{5}\s+1\/1\s+Running\s+0\s+1[0-2]s$/);
  r = await runLine(shell, host, 'kubectl get deploy');
  assert.equal(r.stdout, `NAME   READY   UP-TO-DATE   AVAILABLE   AGE
web    3/3     3            3           12s
`);
  r = await runLine(shell, host, 'kubectl get rs -o wide');
  assert.match(r.stdout, /^NAME             DESIRED   CURRENT   READY   AGE   CONTAINERS   IMAGES       SELECTOR\nweb-[a-z0-9]+\s+3\s+3\s+3\s+12s\s+web\s+nginx:1.27\s+app=web,pod-template-hash=[a-z0-9]+\n$/);
  r = await runLine(shell, host, 'kubectl expose deployment web --port=80');
  assert.equal(r.stdout, 'service/web exposed\n');
  engine.advance(1);
  r = await runLine(shell, host, 'kubectl get svc');
  assert.match(r.stdout, /^NAME   TYPE        CLUSTER-IP   EXTERNAL-IP   PORT\(S\)   AGE\nweb    ClusterIP   10\.96\.\d+\.\d+   <none>        80\/TCP    1s\n$/);
  r = await runLine(shell, host, 'kubectl get endpoints web');
  assert.match(r.stdout, /^NAME   ENDPOINTS\s+AGE\nweb    10\.244\.\d+\.\d+:80,10\.244\.\d+\.\d+:80,10\.244\.\d+\.\d+:80   1s\n$/);
  r = await runLine(shell, host, 'kubectl describe deploy web');
  assert.match(r.stdout, /^Name:\s+web\nNamespace:\s+default\nCreationTimestamp:\s+\w{3}, \d{2} \w{3} 2026 \d{2}:\d{2}:\d{2} \+0000\nLabels:\s+app=web\nAnnotations:\s+deployment.kubernetes.io\/revision: 1\n\s+kubectl.kubernetes.io\/last-applied-configuration: \{.*\.\.\.\nSelector:\s+app=web\nReplicas:\s+3 desired \| 3 updated \| 3 total \| 3 available \| 0 unavailable\n/);
  assert.match(r.stdout, /Events:\n  Type    Reason             Age   From                   Message\n  ----    ------             ----  ----                   -------\n  Normal  ScalingReplicaSet  13s   deployment-controller  Scaled up replica set web-[a-z0-9]+ from 0 to 3\n$/);
  // rolling update under rollout status
  r = await runLine(shell, host, 'kubectl set image deployment/web web=nginx:1.25');
  assert.equal(r.stdout, 'deployment.apps/web image updated\n');
  r = await runLine(shell, host, 'kubectl rollout status deployment/web');
  assert.match(r.stdout, /Waiting for deployment "web" rollout to finish: \d out of 3 new replicas have been updated\.\.\.\n/);
  assert.match(r.stdout, /deployment "web" successfully rolled out\n$/);
  r = await runLine(shell, host, 'kubectl rollout history deployment/web');
  assert.equal(r.stdout, 'deployment.apps/web \nREVISION  CHANGE-CAUSE\n1         <none>\n2         <none>\n');
  r = await runLine(shell, host, 'kubectl rollout undo deployment/web');
  assert.equal(r.stdout, 'deployment.apps/web rolled back\n');
  r = await runLine(shell, host, 'kubectl rollout status deploy web');
  assert.match(r.stdout, /successfully rolled out/);
  r = await runLine(shell, host, 'kubectl rollout history deployment/web');
  assert.equal(r.stdout, 'deployment.apps/web \nREVISION  CHANGE-CAUSE\n2         <none>\n3         <none>\n');
  const podName = engine.store.list('Pod', 'default')[0]!.metadata.name;
  r = await runLine(shell, host, `kubectl logs ${podName}`);
  assert.match(r.stdout, /Configuration complete/);
  r = await runLine(shell, host, `kubectl exec ${podName} -- env`);
  assert.match(r.stdout, /HOSTNAME=web-/);
  r = await runLine(shell, host, `kubectl exec ${podName} -- nslookup web`);
  assert.match(r.stdout, /Name:\tweb.default.svc.cluster.local\nAddress: 10\.96\./);
  r = await runLine(shell, host, `kubectl exec ${podName} -- curl -s http://web`);
  assert.match(r.stdout, /Welcome to nginx/);
  r = await runLine(shell, host, 'kubectl get pods -o name | head -1 | xargs kubectl delete');
  assert.match(r.stdout, /^pod "web-[a-z0-9-]+" deleted\n$/);
  r = await runLine(shell, host, 'kubectl get pods --no-headers | wc -l');
  assert.equal(r.stdout, '3\n');
  r = await runLine(shell, host, 'kubectl scale deployment web --replicas=1');
  assert.equal(r.stdout, 'deployment.apps/web scaled\n');
  engine.advance(5);
  r = await runLine(shell, host, 'kubectl get pods --no-headers | wc -l');
  assert.equal(r.stdout, '1\n');
  r = await runLine(shell, host, 'kubectl delete -f web.yaml');
  assert.equal(r.stdout, 'deployment.apps "web" deleted\n');
  engine.advance(3);
  r = await runLine(shell, host, 'kubectl get all');
  assert.match(r.stdout, /^NAME          TYPE        CLUSTER-IP/);
  assert.doesNotMatch(r.stdout, /pod\//);
});

test('imperative create, dry-run yaml, namespaces, labels, config set-context', async () => {
  const { shell, host, engine } = setup();
  let r = await runLine(shell, host, 'kubectl create namespace freight');
  assert.equal(r.stdout, 'namespace/freight created\n');
  r = await runLine(shell, host, 'kubectl run probe --image=nginx:1.27 -n freight --labels=app=probe,tier=debug');
  assert.equal(r.stdout, 'pod/probe created\n');
  r = await runLine(shell, host, 'kubectl get pods');
  assert.equal(r.stderr, 'No resources found in default namespace.\n');
  r = await runLine(shell, host, 'kubectl config set-context --current --namespace=freight');
  assert.equal(r.stdout, 'Context "kubequest" modified.\n');
  engine.advance(5);
  r = await runLine(shell, host, 'kubectl get pods --show-labels');
  assert.match(r.stdout, /^NAME    READY   STATUS    RESTARTS   AGE   LABELS\nprobe   1\/1     Running   0          5s    app=probe,tier=debug\n$/);
  r = await runLine(shell, host, 'kubectl label pod probe triage=done');
  assert.equal(r.stdout, 'pod/probe labeled\n');
  r = await runLine(shell, host, 'kubectl label pod probe triage=again');
  assert.equal(r.stderr, "error: 'triage' already has a value (done), and --overwrite is false\n");
  r = await runLine(shell, host, 'kubectl get pods -A -l tier=debug');
  assert.match(r.stdout, /^NAMESPACE   NAME    READY   STATUS    RESTARTS   AGE\nfreight     probe   1\/1     Running   0          5s\n$/);
  r = await runLine(shell, host, 'kubectl create deployment api --image=registry.orbital.local/freight/frontend:1.4.0 --replicas=2 --dry-run=client -o yaml');
  assert.equal(r.stdout, `apiVersion: apps/v1
kind: Deployment
metadata:
  creationTimestamp: null
  labels:
    app: api
  name: api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api
  strategy: {}
  template:
    metadata:
      creationTimestamp: null
      labels:
        app: api
    spec:
      containers:
      - image: registry.orbital.local/freight/frontend:1.4.0
        name: frontend
        resources: {}
status: {}
`);
  r = await runLine(shell, host, 'kubectl create deployment api --image=nginx:1.27 --dry-run=client -o yaml > api.yaml && kubectl apply -f api.yaml');
  assert.equal(r.stdout, 'deployment.apps/api created\n');
  engine.advance(1);
  r = await runLine(shell, host, 'kubectl get pod probe -o jsonpath=\'{.status.phase}\'');
  assert.equal(r.stdout, 'Running');
  r = await runLine(shell, host, "kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name}{\"\\n\"}{end}'");
  assert.match(r.stdout, /^api-[a-z0-9]+-[a-z0-9]{5}\nprobe\n$/);
  r = await runLine(shell, host, 'kubectl get pod probe -o yaml | grep -c "kind: Pod"');
  assert.equal(r.stdout, '1\n');
});

test('validation and crashloop diagnostics', async () => {
  const { shell, host, engine, vfs } = setup();
  vfs.write('bad.yaml', DEPLOY_YAML.replace('replicas: 3', 'replica: 3'));
  let r = await runLine(shell, host, 'kubectl apply -f bad.yaml');
  assert.equal(r.stderr, 'error: error validating "bad.yaml": error validating data: ValidationError(Deployment.spec): unknown field "replica" in io.k8s.api.apps.v1.DeploymentSpec; if you choose to ignore these errors, turn validation off with --validate=false\n');
  vfs.write('mismatch.yaml', DEPLOY_YAML.replace('      labels:\n        app: web\n    spec:', '      labels:\n        app: webb\n    spec:'));
  r = await runLine(shell, host, 'kubectl apply -f mismatch.yaml');
  assert.equal(r.stderr, 'The Deployment "web" is invalid: spec.template.metadata.labels: Invalid value: map[string]string{"app":"webb"}: `selector` does not match template `labels`\n');
  vfs.write('broken.yaml', DEPLOY_YAML.replace('  template:', ' template:'));
  r = await runLine(shell, host, 'kubectl apply -f broken.yaml');
  assert.match(r.stderr, /^error: error parsing broken.yaml: error converting YAML to JSON: yaml: line \d+: /);
  // crashloop
  engine.images.set('registry.orbital.local/freight/cargo-api:2.1.0', { requiresEnv: ['CARGO_DB_URL'], logs: { start: ['cargo-api 2.1.0 booting'] } });
  vfs.write('cargo.yaml', DEPLOY_YAML.replace(/web/g, 'cargo').replace('nginx:1.27', 'registry.orbital.local/freight/cargo-api:2.1.0').replace('replicas: 3', 'replicas: 1'));
  r = await runLine(shell, host, 'kubectl apply -f cargo.yaml');
  engine.advance(25);
  r = await runLine(shell, host, 'kubectl get pods');
  assert.match(r.stdout, /cargo-[a-z0-9]+-[a-z0-9]{5}\s+0\/1\s+(CrashLoopBackOff|Error)\s+[1-9] \(\d+s ago\)\s+25s/);
  const pod = engine.store.list('Pod', 'default')[0]!.metadata.name;
  r = await runLine(shell, host, `kubectl logs ${pod} --previous`);
  assert.match(r.stdout, /required environment variable CARGO_DB_URL is not set/);
  r = await runLine(shell, host, `kubectl describe pod ${pod}`);
  assert.match(r.stdout, /Last State:\s+Terminated\n\s+Reason:\s+Error\n\s+Exit Code:\s+1\n/);
  assert.match(r.stdout, /Warning\s+BackOff\s+.*kubelet.*Back-off restarting failed container cargo in pod cargo-/);
  r = await runLine(shell, host, 'kubectl set env deployment/cargo CARGO_DB_URL=postgres://cargo-db:5432/cargo');
  assert.equal(r.stdout, 'deployment.apps/cargo env updated\n');
  r = await runLine(shell, host, 'kubectl rollout status deployment/cargo');
  assert.match(r.stdout, /successfully rolled out/);
  r = await runLine(shell, host, 'kubectl get pods');
  assert.match(r.stdout, /1\/1\s+Running\s+0\s+/);
});

test('edit via editor, port-forward in background with curl, watch -w aborts cleanly', async () => {
  const { shell, host, engine } = setup();
  await runLine(shell, host, 'kubectl apply -f web.yaml');
  engine.advance(10);
  host.editorQueue.push((initial: string) => initial.replace('replicas: 3', 'replicas: 2'));
  let r = await runLine(shell, host, 'kubectl edit deployment web');
  assert.equal(r.stdout, 'deployment.apps/web edited\n');
  engine.advance(5);
  assert.equal(engine.store.list('Pod', 'default').filter((p) => !p.metadata.deletionTimestamp).length, 2);
  const pod = engine.store.list('Pod', 'default')[0]!.metadata.name;
  r = await runLine(shell, host, `kubectl port-forward ${pod} 8080:80 &`);
  assert.match(r.stdout, /^\[1\] 1001\n$/);
  await new Promise((res) => setTimeout(res, 5));
  r = await runLine(shell, host, 'curl -s localhost:8080');
  assert.match(r.stdout, /Welcome to nginx/);
  // regression: URL as the first argument (no flags) used to be mistaken for the value of a missing -o flag
  r = await runLine(shell, host, 'curl localhost:8080');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Welcome to nginx/);
  r = await runLine(shell, host, 'curl -o out.html http://localhost:8080/');
  assert.equal(r.code, 0);
  r = await runLine(shell, host, 'curl -s localhost:9999');
  assert.match(r.stderr, /curl: \(7\) Failed to connect to localhost port 9999/);
  r = await runLine(shell, host, 'kill %1');
  assert.equal(r.code, 0);
  host.maxWaitMs = 3000;
  r = await runLine(shell, host, 'kubectl get pods -w');
  assert.match(r.stdout, /Running/);
});
