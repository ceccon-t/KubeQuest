/** Builders and the Orbital Logistics image catalogue shared by missions. */
import type { ContainerBehaviour } from '../engine/images.ts';
import type { KubeObject, Container, Probe, ResourceRequirements, EnvVar } from '../engine/types.ts';
import type { ObjectiveContext } from '../game/mission.ts';
import type { ExecRecord } from '../engine/shell.ts';
import type { NodeSetup } from '../engine/engine.ts';

export const REG = 'registry.orbital.local/freight';

/** Images that exist in Orbital's registry. Behaviours drive the simulation. */
export const ORBITAL_IMAGES: Record<string, ContainerBehaviour> = {
  [`${REG}/frontend:1.4.0`]: {
    ports: [8080], memoryMiB: 64, cpuMillis: 30, startMs: 1200, sizeBytes: 52_000_000,
    http: { '/': { status: 200, body: 'freight-frontend 1.4.0 ok\n' }, '/healthz': { status: 200, body: 'ok' }, '/readyz': { status: 200, body: 'ok' } },
    logs: { start: ['{"level":"info","msg":"freight-frontend 1.4.0 starting","port":8080}', '{"level":"info","msg":"listening","addr":":8080"}'], loop: ['{"level":"info","msg":"GET / 200","latency_ms":12}', '{"level":"info","msg":"GET /api/shipments 200","latency_ms":41}'], loopEveryMs: 4000, onStop: ['{"level":"info","msg":"SIGTERM received, draining"}'] },
    description: 'Freight scheduling frontend 1.4.0',
  },
  [`${REG}/frontend:1.4.1`]: {
    ports: [8080], memoryMiB: 66, cpuMillis: 30, startMs: 1300, sizeBytes: 52_400_000,
    http: { '/': { status: 200, body: 'freight-frontend 1.4.1 ok\n' }, '/healthz': { status: 200, body: 'ok' }, '/readyz': { status: 200, body: 'ok' } },
    logs: { start: ['{"level":"info","msg":"freight-frontend 1.4.1 starting","port":8080}', '{"level":"info","msg":"listening","addr":":8080"}'], loop: ['{"level":"info","msg":"GET / 200","latency_ms":11}'], loopEveryMs: 4000, onStop: ['{"level":"info","msg":"SIGTERM received, draining"}'] },
  },
  [`${REG}/frontend:1.4.2-rc1`]: {
    ports: [8080], memoryMiB: 70, cpuMillis: 35, startMs: 1500, readyAfterMs: 12_000, sizeBytes: 53_000_000,
    http: { '/': { status: 200, body: 'freight-frontend 1.4.2-rc1 ok\n', warmupMs: 12_000 }, '/healthz': { status: 200, body: 'ok', warmupMs: 0 }, '/readyz': { status: 200, body: 'ok', warmupMs: 12_000 } },
    logs: { start: ['{"level":"info","msg":"freight-frontend 1.4.2-rc1 starting","port":8080}', '{"level":"info","msg":"listening","addr":":8080"}', '{"level":"info","msg":"warming route cache (this takes ~12s)"}'], loop: ['{"level":"info","msg":"GET / 200","latency_ms":9}'], loopEveryMs: 4000, onStop: ['{"level":"info","msg":"SIGTERM received, draining"}'] },
  },
  [`${REG}/frontend:1.5.0`]: {
    ports: [8080], memoryMiB: 68, cpuMillis: 30, startMs: 1200, crashAfterMs: 2500, sizeBytes: 54_000_000,
    http: { '/': { status: 200, body: 'freight-frontend 1.5.0 ok\n' }, '/healthz': { status: 200, body: 'ok' }, '/readyz': { status: 200, body: 'ok' } },
    logs: { start: ['{"level":"info","msg":"freight-frontend 1.5.0 starting","port":8080}', '{"level":"info","msg":"listening","addr":":8080"}'], onCrash: ['{"level":"error","msg":"template parse error: routes/shipment.tmpl:17: unexpected \\"}\\" in operand"}', 'panic: template: shipment.tmpl:17: unexpected "}" in operand', '', 'goroutine 1 [running]:', 'main.mustParse(...)', '\t/src/frontend/main.go:88 +0x1d4'] },
  },
  [`${REG}/cargo-api:2.1.0`]: {
    ports: [8080], memoryMiB: 96, cpuMillis: 40, startMs: 900, sizeBytes: 61_000_000, requiresEnv: ['CARGO_DB_URL'], echoEnv: ['CARGO_DB_URL'],
    http: { '/': { status: 200, body: '{"service":"cargo-api","version":"2.1.0"}\n' }, '/healthz': { status: 200, body: 'ok' }, '/readyz': { status: 200, body: 'ok' }, '/api/cargo': { status: 200, body: '[{"id":"CRG-1042","dest":"Luna Port 3"}]\n' } },
    logs: { start: ['cargo-api 2.1.0 booting', 'loading config from environment'], loop: ['GET /api/cargo 200 23ms'], loopEveryMs: 5000 },
  },
  [`${REG}/cargo-api:2.1.1`]: {
    ports: [8080], memoryMiB: 98, cpuMillis: 40, startMs: 900, sizeBytes: 61_300_000, requiresEnv: ['CARGO_DB_URL'], echoEnv: ['CARGO_DB_URL'],
    http: { '/': { status: 200, body: '{"service":"cargo-api","version":"2.1.1"}\n' }, '/healthz': { status: 200, body: 'ok' }, '/readyz': { status: 200, body: 'ok' }, '/api/cargo': { status: 200, body: '[{"id":"CRG-1042","dest":"Luna Port 3"}]\n' } },
    logs: { start: ['cargo-api 2.1.1 booting', 'loading config from environment'], loop: ['GET /api/cargo 200 21ms'], loopEveryMs: 5000 },
  },
  [`${REG}/scheduler:3.0.2`]: {
    ports: [9000], memoryMiB: 300, cpuMillis: 60, startMs: 1500, sizeBytes: 88_000_000,
    http: { '/': { status: 200, body: 'scheduler 3.0.2\n' }, '/healthz': { status: 200, body: 'ok' } },
    logs: { start: ['scheduler 3.0.2 starting', 'loading route graph into memory (312 MiB)'], loop: ['planned 14 routes in 230ms'], loopEveryMs: 6000 },
  },
  [`${REG}/notifier:1.2.0`]: {
    ports: [8080], memoryMiB: 40, cpuMillis: 10, startMs: 700, sizeBytes: 31_000_000,
    http: { '/': { status: 200, body: 'notifier 1.2.0\n' }, '/healthz': { status: 200, body: 'ok' } },
    logs: { start: ['notifier 1.2.0 ready'], loop: ['sent 3 notifications'], loopEveryMs: 7000 },
  },
  [`${REG}/rate-limiter:0.3.1`]: {
    ports: [8080], memoryMiB: 24, cpuMillis: 10, startMs: 600, crashAfterMs: 4000, sizeBytes: 19_000_000,
    logs: { start: ['rate-limiter 0.3.1 starting'], onCrash: ['fatal: redis: dial tcp: lookup redis-cache on 10.96.0.10:53: no such host'] },
  },
  [`${REG}/manifest-worker:0.9.0`]: {
    ports: [], memoryMiB: 32, cpuMillis: 50, startMs: 300, sizeBytes: 24_000_000, runToCompletion: { durationMs: 4000 },
    logs: { start: ['manifest-worker 0.9.0: processing batch', 'reindexed 2,140 shipments'] },
  },
  [`${REG}/log-agent:2.4.0`]: {
    ports: [], memoryMiB: 28, cpuMillis: 15, startMs: 500, sizeBytes: 22_000_000,
    logs: { start: ['log-agent 2.4.0 tailing /var/log/containers'], loop: ['shipped 1203 lines'], loopEveryMs: 8000 },
  },
  [`${REG}/debug:1.0`]: {
    ports: [], memoryMiB: 8, cpuMillis: 2, startMs: 200, sizeBytes: 5_000_000,
    logs: { start: ['debug shell ready (sleep infinity)'] },
    description: 'busybox + curl + nslookup, sleeps forever',
  },
};

export interface DeploymentOpts {
  name: string;
  ns: string;
  image: string;
  replicas?: number;
  labels?: Record<string, string>;
  containerName?: string;
  port?: number;
  env?: EnvVar[];
  resources?: ResourceRequirements;
  readinessProbe?: Probe;
  livenessProbe?: Probe;
  strategy?: { type?: 'RollingUpdate' | 'Recreate'; rollingUpdate?: { maxSurge?: number | string; maxUnavailable?: number | string } };
  annotations?: Record<string, string>;
  nodeSelector?: Record<string, string>;
  extraContainers?: Container[];
}

export function deployment(o: DeploymentOpts): KubeObject {
  const labels = o.labels ?? { app: o.name };
  const c: Container = { name: o.containerName ?? o.name, image: o.image };
  if (o.port) c.ports = [{ containerPort: o.port, name: 'http', protocol: 'TCP' }];
  if (o.env) c.env = o.env;
  if (o.resources) c.resources = o.resources;
  if (o.readinessProbe) c.readinessProbe = o.readinessProbe;
  if (o.livenessProbe) c.livenessProbe = o.livenessProbe;
  return {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: o.name, namespace: o.ns, labels: { ...labels }, ...(o.annotations ? { annotations: o.annotations } : {}) },
    spec: { replicas: o.replicas ?? 1, selector: { matchLabels: { ...labels } }, ...(o.strategy ? { strategy: o.strategy } : {}), template: { metadata: { labels: { ...labels } }, spec: { containers: [c, ...(o.extraContainers ?? [])], ...(o.nodeSelector ? { nodeSelector: o.nodeSelector } : {}) } } },
    status: {},
  };
}

export function service(o: { name: string; ns: string; selector: Record<string, string>; port: number; targetPort?: number; type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer'; labels?: Record<string, string> }): KubeObject {
  return {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name: o.name, namespace: o.ns, labels: o.labels ?? { app: o.name } },
    spec: { selector: o.selector, ports: [{ name: 'http', port: o.port, targetPort: o.targetPort ?? o.port, protocol: 'TCP' }], type: o.type ?? 'ClusterIP' },
    status: {},
  };
}

export function pod(o: { name: string; ns: string; image: string; labels?: Record<string, string>; env?: EnvVar[]; command?: string[]; resources?: ResourceRequirements; port?: number }): KubeObject {
  const c: Container = { name: o.name, image: o.image };
  if (o.env) c.env = o.env;
  if (o.command) c.command = o.command;
  if (o.resources) c.resources = o.resources;
  if (o.port) c.ports = [{ containerPort: o.port, protocol: 'TCP' }];
  return { apiVersion: 'v1', kind: 'Pod', metadata: { name: o.name, namespace: o.ns, labels: o.labels ?? { run: o.name } }, spec: { containers: [c] }, status: {} };
}

export function configMap(name: string, ns: string, data: Record<string, string>): KubeObject {
  return { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: ns }, data };
}

/** The standard Orbital production cluster: 1 control plane + 3 workers. */
export function orbitalNodes(opts: { workers?: number; memory?: string; cpu?: string } = {}): NodeSetup[] {
  const n = opts.workers ?? 3;
  const nodes: NodeSetup[] = [{ name: 'orbital-cp-1', roles: ['control-plane'], cpu: '4', memory: '8Gi', labels: { 'topology.kubernetes.io/zone': 'dock-a' } }];
  const zones = ['dock-a', 'dock-b', 'dock-c'];
  for (let i = 0; i < n; i++) nodes.push({ name: `orbital-worker-${String.fromCharCode(97 + i)}`, cpu: opts.cpu ?? '4', memory: opts.memory ?? '8Gi', labels: { 'topology.kubernetes.io/zone': zones[i % 3] as string, 'node.orbital.local/pool': 'general' } });
  return nodes;
}

/** Objects every Orbital cluster has in kube-system (makes `get pods -A` look real). */
export function systemWorkloads(): { ageSeconds: number; object: KubeObject }[] {
  const age = 14 * 86400;
  return [
    { ageSeconds: age, object: deployment({ name: 'coredns', ns: 'kube-system', image: 'nginx:1.27', replicas: 2, labels: { 'k8s-app': 'kube-dns' }, containerName: 'coredns', port: 53 }) },
    { ageSeconds: age, object: { apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: 'kube-proxy', namespace: 'kube-system', labels: { 'k8s-app': 'kube-proxy' } }, spec: { selector: { matchLabels: { 'k8s-app': 'kube-proxy' } }, template: { metadata: { labels: { 'k8s-app': 'kube-proxy' } }, spec: { containers: [{ name: 'kube-proxy', image: 'nginx:1.27' }], tolerations: [{ operator: 'Exists' }] } } }, status: {} } },
  ];
}

/** Normalise a typed command line (`k` alias → `kubectl`, collapse whitespace). */
export function norm(line: string): string {
  return line.trim().replace(/^k\s+/, 'kubectl ').replace(/\s+/g, ' ');
}

/** A successful command matching the regex (tested against the normalised line) was run. */
export function usedCmd(ctx: ObjectiveContext, re: RegExp): boolean {
  return ctx.history.some((h) => h.code === 0 && (re.test(norm(h.line)) || re.test(norm(h.expanded))));
}
/** A single successful command matching every regex. */
export function usedCmdAll(ctx: ObjectiveContext, ...res: RegExp[]): boolean {
  return ctx.history.some((h) => h.code === 0 && (res.every((re) => re.test(norm(h.line))) || res.every((re) => re.test(norm(h.expanded)))));
}
export function usedCmdAny(ctx: ObjectiveContext, re: RegExp): boolean {
  return ctx.history.some((h) => re.test(norm(h.line)) || re.test(norm(h.expanded)));
}
export function outputHad(ctx: ObjectiveContext, re: RegExp): boolean {
  return ctx.history.some((h: ExecRecord) => re.test(h.stdout));
}

export const PROBES = {
  readiness: (path: string, port: number, period = 5): Probe => ({ httpGet: { path, port }, periodSeconds: period, initialDelaySeconds: 2 }),
  liveness: (path: string, port: number, period = 10): Probe => ({ httpGet: { path, port }, periodSeconds: period, initialDelaySeconds: 5 }),
};

export function yamlOf(o: KubeObject): string {
  // Deterministic, hand-ordered YAML for files the player edits (kind/metadata/spec order like humans write it).
  const strip = structuredClone(o);
  delete strip.status;
  const order = ['apiVersion', 'kind', 'metadata', 'spec', 'data'];
  const lines: string[] = [];
  for (const k of order) if (strip[k] !== undefined) emitYaml(k, strip[k], 0, lines);
  return lines.join('\n') + '\n';
}

function emitYaml(key: string | null, v: unknown, indent: number, out: string[]): void {
  const pad = ' '.repeat(indent);
  const scalar = (x: unknown): string => {
    if (x === null) return 'null';
    if (typeof x === 'string') return /^[-\w./:]+$/.test(x) && !/^(true|false|null|\d+)$/.test(x) ? x : JSON.stringify(x);
    return String(x);
  };
  if (Array.isArray(v)) {
    if (key !== null) out.push(`${pad}${key}:`);
    for (const item of v) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const entries = Object.entries(item as Record<string, unknown>);
        entries.forEach(([k, val], i) => {
          if (i === 0) {
            if (val && typeof val === 'object') { out.push(`${pad}- ${k}:`); emitChild(val, indent + 4, out); }
            else out.push(`${pad}- ${k}: ${scalar(val)}`);
          } else emitYaml(k, val, indent + 2, out);
        });
      } else out.push(`${pad}- ${scalar(item)}`);
    }
    return;
  }
  if (v && typeof v === 'object') {
    if (key !== null) out.push(`${pad}${key}:`);
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) emitYaml(k, val, key === null ? indent : indent + 2, out);
    return;
  }
  out.push(`${pad}${key}: ${scalar(v)}`);
}
function emitChild(v: unknown, indent: number, out: string[]): void {
  if (Array.isArray(v)) { emitYaml(null, v, indent, out); return; }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) emitYaml(k, val, indent, out);
}
