import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/engine/engine.ts';
import type { Deployment, Pod, ReplicaSet, Service, Endpoints } from '../../src/engine/types.ts';
import { applyDefaults } from '../../src/engine/defaults.ts';
import { setNodeReady } from '../../src/engine/controllers/node.ts';
import { isPodReady } from '../../src/engine/controllers/kubelet.ts';

function deployment(name: string, image: string, replicas = 3, extra: Partial<Deployment['spec']> = {}, env?: { name: string; value: string }[]): Deployment {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: 'default' },
    spec: {
      replicas,
      selector: { matchLabels: { app: name } },
      template: { metadata: { labels: { app: name } }, spec: { containers: [{ name, image, ...(env ? { env } : {}) }] } },
      ...extra,
    },
    status: {},
  };
}

function newEngine(extra: Partial<ConstructorParameters<typeof Engine>[0]> = {}): Engine {
  return new Engine({ seed: 1, nodes: [{ name: 'node-a' }, { name: 'node-b' }, { name: 'node-c' }], clusterAgeSeconds: 3600, ...extra });
}

test('deployment creates RS and pods that become ready', () => {
  const e = newEngine();
  e.store.create(applyDefaults(deployment('web', 'nginx:1.27'), e));
  e.advance(15);
  const pods = e.store.list<Pod>('Pod', 'default');
  assert.equal(pods.length, 3);
  assert.ok(pods.every((p) => p.status.phase === 'Running' && isPodReady(p)));
  const rs = e.store.list<ReplicaSet>('ReplicaSet', 'default');
  assert.equal(rs.length, 1);
  assert.match(rs[0]!.metadata.name, /^web-[a-z0-9]+$/);
  assert.equal(rs[0]!.status.readyReplicas, 3);
  const d = e.store.get<Deployment>('Deployment', 'default', 'web')!;
  assert.equal(d.status.availableReplicas, 3);
  assert.equal(d.status.conditions?.find((c) => c.type === 'Progressing')?.reason, 'NewReplicaSetAvailable');
  assert.equal(d.metadata.annotations?.['deployment.kubernetes.io/revision'], '1');
  // pods spread across nodes
  assert.equal(new Set(pods.map((p) => p.spec.nodeName)).size, 3);
});

test('rolling update keeps minimum availability and rolls back', () => {
  const e = newEngine();
  e.store.create(applyDefaults(deployment('web', 'nginx:1.27', 4), e));
  e.advance(15);
  const d = e.store.get<Deployment>('Deployment', 'default', 'web')!;
  d.spec.template.spec.containers[0]!.image = 'nginx:1.25';
  e.store.update(d, { specChanged: true });
  let minAvailable = Infinity;
  let maxTotal = 0;
  for (let i = 0; i < 600; i++) {
    e.tick(100);
    const pods = e.store.list<Pod>('Pod', 'default').filter((p) => !p.metadata.deletionTimestamp);
    const ready = pods.filter(isPodReady).length;
    minAvailable = Math.min(minAvailable, ready);
    maxTotal = Math.max(maxTotal, pods.length);
  }
  // replicas=4 ⇒ maxSurge=1, maxUnavailable=1
  assert.ok(minAvailable >= 3, `min available ${minAvailable}`);
  assert.ok(maxTotal <= 5, `max total ${maxTotal}`);
  const rss = e.store.list<ReplicaSet>('ReplicaSet', 'default');
  assert.equal(rss.length, 2);
  const pods = e.store.list<Pod>('Pod', 'default');
  assert.ok(pods.every((p) => p.spec.containers[0]!.image === 'nginx:1.25'));
  assert.equal(e.store.get<Deployment>('Deployment', 'default', 'web')!.metadata.annotations?.['deployment.kubernetes.io/revision'], '2');
});

test('unknown image tag goes to ImagePullBackOff', () => {
  const e = newEngine();
  e.store.create(applyDefaults(deployment('web', 'nginx:9.99', 1), e));
  e.advance(20);
  const p = e.store.list<Pod>('Pod', 'default')[0]!;
  assert.equal(p.status.phase, 'Pending');
  assert.equal(p.status.containerStatuses?.[0]?.state.waiting?.reason, 'ImagePullBackOff');
  const events = e.store.eventsFor(p).map((ev) => ev.reason);
  assert.ok(events.includes('Failed') && events.includes('BackOff'));
});

test('missing env var crash-loops with growing restart count and previous logs', () => {
  const e = newEngine({ images: { 'registry.orbital.local/x/api:1.0': { requiresEnv: ['DB_URL'], logs: { start: ['api starting'] } } } });
  e.store.create(applyDefaults(deployment('api', 'registry.orbital.local/x/api:1.0', 1), e));
  e.advance(40);
  const p = e.store.list<Pod>('Pod', 'default')[0]!;
  const cs = p.status.containerStatuses![0]!;
  assert.ok(cs.restartCount >= 2, `restarts ${cs.restartCount}`);
  assert.ok(['CrashLoopBackOff', undefined].includes(cs.state.waiting?.reason) || cs.state.terminated);
  const rt = e.podRuntime(p).containers[0]!;
  assert.ok(rt.prevLogs.some((l) => l.includes('DB_URL')));
});

test('service endpoints follow readiness and traffic flows', () => {
  const e = newEngine({ images: { 'registry.orbital.local/x/slow:1.0': { readyAfterMs: 5000, http: { '/': { status: 200, body: 'ok' }, '/ready': { status: 200, body: 'ok' } } } } });
  const d = deployment('web', 'registry.orbital.local/x/slow:1.0', 2);
  d.spec.template.spec.containers[0]!.readinessProbe = { httpGet: { path: '/ready', port: 8080 }, periodSeconds: 1 };
  e.store.create(applyDefaults(d, e));
  const svc: Service = { apiVersion: 'v1', kind: 'Service', metadata: { name: 'web', namespace: 'default' }, spec: { selector: { app: 'web' }, ports: [{ port: 80, targetPort: 8080 }] }, status: {} };
  e.store.create(applyDefaults(svc, e));
  e.traffic.addSource({ id: 't', service: 'default/web', rps: 20 });
  e.advance(5);
  let ep = e.store.get<Endpoints>('Endpoints', 'default', 'web')!;
  assert.ok(!ep.subsets?.[0]?.addresses, 'no ready addresses during warm-up');
  assert.ok(e.traffic.total.dropped > 0);
  e.advance(10);
  ep = e.store.get<Endpoints>('Endpoints', 'default', 'web')!;
  assert.equal(ep.subsets?.[0]?.addresses?.length, 2);
  const before = e.traffic.total.served;
  e.advance(5);
  assert.ok(e.traffic.total.served > before + 50);
  assert.match(e.store.get<Service>('Service', 'default', 'web')!.spec.clusterIP!, /^10\.96\./);
});

test('node failure marks pods not ready, evicts after tolerationSeconds, RS replaces', () => {
  const e = newEngine({ evictionSeconds: 20 });
  e.store.create(applyDefaults(deployment('web', 'nginx:1.27', 3), e));
  e.advance(15);
  const victim = e.store.list<Pod>('Pod', 'default')[0]!;
  const node = victim.spec.nodeName!;
  setNodeReady(e, node, false);
  e.advance(2);
  assert.equal(isPodReady(e.store.get<Pod>('Pod', 'default', victim.metadata.name)!), false);
  assert.equal(e.store.list<Pod>('Pod', 'default').length, 3, 'not evicted yet');
  e.advance(25);
  assert.ok(e.store.get<Pod>('Pod', 'default', victim.metadata.name)?.metadata.deletionTimestamp, 'evicted');
  e.advance(45);
  const pods = e.store.list<Pod>('Pod', 'default').filter((p) => !p.metadata.deletionTimestamp);
  assert.equal(pods.length, 3);
  assert.ok(pods.every((p) => p.spec.nodeName !== node && isPodReady(p)));
  setNodeReady(e, node, true);
  e.advance(2);
});

test('OOMKilled when limit is below usage; Pending when requests exceed node', () => {
  const e = newEngine({ images: { 'registry.orbital.local/x/fat:1.0': { memoryMiB: 256 } } });
  const d = deployment('fat', 'registry.orbital.local/x/fat:1.0', 1);
  d.spec.template.spec.containers[0]!.resources = { limits: { memory: '128Mi' } };
  e.store.create(applyDefaults(d, e));
  e.advance(8);
  const p = e.store.list<Pod>('Pod', 'default')[0]!;
  const cs = p.status.containerStatuses![0]!;
  assert.ok(cs.lastState.terminated?.reason === 'OOMKilled' || cs.state.terminated?.reason === 'OOMKilled');
  const big = deployment('big', 'nginx:1.27', 1);
  big.spec.template.spec.containers[0]!.resources = { requests: { memory: '64Gi' } };
  e.store.create(applyDefaults(big, e));
  e.advance(2);
  const bp = e.store.list<Pod>('Pod', 'default').find((x) => x.metadata.name.startsWith('big-'))!;
  assert.equal(bp.status.phase, 'Pending');
  assert.equal(bp.spec.nodeName, undefined);
  const ev = e.store.eventsFor(bp).find((x) => x.reason === 'FailedScheduling')!;
  assert.equal(ev.message, '0/3 nodes are available: 3 Insufficient memory. preemption: 0/3 nodes are available: 3 No preemption victims found for incoming pod.');
});

test('job runs to completion with parallelism; cronjob schedules', () => {
  const e = newEngine({ images: { 'registry.orbital.local/x/task:1.0': { runToCompletion: { durationMs: 2000 }, ports: [] } } });
  e.store.create(applyDefaults({ apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'reindex', namespace: 'default' }, spec: { completions: 4, parallelism: 2, template: { metadata: {}, spec: { containers: [{ name: 'task', image: 'registry.orbital.local/x/task:1.0' }], restartPolicy: 'Never' } } }, status: {} } as never, e));
  e.advance(3);
  assert.equal(e.store.list<Pod>('Pod', 'default').filter((p) => p.status.phase !== 'Succeeded').length, 2);
  e.advance(20);
  const job = e.store.get('Job', 'default', 'reindex') as unknown as { status: { succeeded?: number; conditions?: { type: string }[] } };
  assert.equal(job.status.succeeded, 4);
  assert.ok(job.status.conditions?.some((c) => c.type === 'Complete'));
  e.store.create(applyDefaults({ apiVersion: 'batch/v1', kind: 'CronJob', metadata: { name: 'tick', namespace: 'default' }, spec: { schedule: '* * * * *', jobTemplate: { spec: { template: { metadata: {}, spec: { containers: [{ name: 'task', image: 'registry.orbital.local/x/task:1.0' }], restartPolicy: 'Never' } } } } }, status: {} } as never, e));
  e.advance(130);
  assert.ok(e.store.list('Job', 'default').filter((j) => j.metadata.name.startsWith('tick-')).length >= 2);
});
