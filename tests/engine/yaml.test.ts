import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAllDocuments, parseDocument, stringify, YamlError } from '../../src/engine/yaml.ts';

test('parses a typical deployment manifest', () => {
  const doc = parseDocument(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels: {app: web, tier: "frontend"}
  annotations:
    "kubectl.kubernetes.io/last-applied": '{"a": 1}'
spec:
  replicas: 3   # three of them
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
        image: registry.orbital.local/web:1.2.0
        ports:
          - containerPort: 8080
            protocol: TCP
        env:
        - name: GREETING
          value: "hello: world"
        - name: EMPTY
          value: ""
        args: ["--port", "8080"]
        resources:
          limits: {memory: 128Mi}
`);
  const d = doc as Record<string, unknown>;
  assert.equal(d.kind, 'Deployment');
  const spec = d.spec as Record<string, unknown>;
  assert.equal(spec.replicas, 3);
  const meta = d.metadata as Record<string, unknown>;
  assert.deepEqual(meta.labels, { app: 'web', tier: 'frontend' });
  assert.deepEqual(meta.annotations, { 'kubectl.kubernetes.io/last-applied': '{"a": 1}' });
  const tpl = spec.template as Record<string, unknown>;
  const pspec = tpl.spec as Record<string, unknown>;
  const c0 = (pspec.containers as Record<string, unknown>[])[0]!;
  assert.equal(c0.image, 'registry.orbital.local/web:1.2.0');
  assert.deepEqual(c0.ports, [{ containerPort: 8080, protocol: 'TCP' }]);
  assert.deepEqual(c0.env, [{ name: 'GREETING', value: 'hello: world' }, { name: 'EMPTY', value: '' }]);
  assert.deepEqual(c0.args, ['--port', '8080']);
  assert.deepEqual(c0.resources, { limits: { memory: '128Mi' } });
});

test('multi-document and block scalars', () => {
  const docs = parseAllDocuments(`---
apiVersion: v1
kind: ConfigMap
data:
  script: |
    echo one
    echo two
  folded: >-
    a
    b
---
# just a comment
---
kind: Pod
`);
  assert.equal(docs.length, 2);
  const cm = docs[0] as Record<string, Record<string, string>>;
  assert.equal(cm.data!.script, 'echo one\necho two\n');
  assert.equal(cm.data!.folded, 'a b');
});

test('errors carry line numbers', () => {
  assert.throws(() => parseDocument('a: 1\n  b: 2\n'), (e: unknown) => e instanceof YamlError && e.line === 2);
  assert.throws(() => parseDocument('a: 1\n\tb: 2\n'), YamlError);
});

test('stringify matches kubectl style and round-trips', () => {
  const obj = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'x', labels: { app: 'x' }, annotations: {} },
    spec: { containers: [{ name: 'c', image: 'nginx:1.27', args: ['--x', '80'], env: [{ name: 'A', value: '1' }], ports: [] }], nodeName: null },
    status: { podIP: '10.244.1.2', script: 'a\nb\n', b: true, n: 1.5, yes: 'y' },
  };
  const y = stringify(obj);
  assert.equal(y, `apiVersion: v1
kind: Pod
metadata:
  annotations: {}
  labels:
    app: x
  name: x
spec:
  containers:
  - args:
    - --x
    - "80"
    env:
    - name: A
      value: "1"
    image: nginx:1.27
    name: c
    ports: []
  nodeName: null
status:
  b: true
  "n": 1.5
  podIP: 10.244.1.2
  script: |
    a
    b
  "yes": "y"
`);
  assert.deepEqual(parseDocument(y), obj);
});
