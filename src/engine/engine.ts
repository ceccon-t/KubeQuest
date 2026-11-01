/** The simulated cluster: clock, store, runtime state, controllers, traffic. Pure and deterministic. */
import { Clock } from './clock.ts';
import { Rng } from './rng.ts';
import { ClusterStore } from './store.ts';
import { baseCatalog, makeCatalog, type ContainerBehaviour, type ImageCatalog } from './images.ts';
import type { KubeObject, Node, Pod, Taint, Namespace } from './types.ts';
import type { PodRuntime, NodeRuntime } from './runtime.ts';
import { runKubelet } from './controllers/kubelet.ts';
import { runScheduler } from './controllers/scheduler.ts';
import { runNodeLifecycle } from './controllers/node.ts';
import { runReplicaSetController } from './controllers/replicaset.ts';
import { runDeploymentController } from './controllers/deployment.ts';
import { runEndpointsController, runServiceController } from './controllers/service.ts';
import { runJobController, runCronJobController } from './controllers/job.ts';
import { runDaemonSetController } from './controllers/daemonset.ts';
import { runGarbageCollector } from './controllers/gc.ts';
import { TrafficSim, type TrafficSource } from './traffic.ts';
import { applyDefaults } from './defaults.ts';

export interface NodeSetup {
  name: string;
  roles?: string[];
  cpu?: string;
  memory?: string;
  pods?: number;
  labels?: Record<string, string>;
  taints?: Taint[];
  ready?: boolean;
  unschedulable?: boolean;
  version?: string;
}

export interface ClusterSetup {
  seed?: number;
  /** Game "now" as ms since epoch. Defaults to 2026-10-05T09:00:00Z. */
  epochMs?: number;
  /** How old the cluster is when the mission starts (nodes/namespaces age). */
  clusterAgeSeconds?: number;
  nodes: NodeSetup[];
  namespaces?: string[];
  images?: Record<string, ContainerBehaviour>;
  /** Objects that exist at mission start, created `ageSeconds` before "now" and reconciled. */
  objects?: { ageSeconds?: number; object: KubeObject }[];
  traffic?: TrafficSource[];
  /** Seconds a pod survives on a NotReady node before eviction (default tolerations). Real default: 300. */
  evictionSeconds?: number;
  kubernetesVersion?: string;
  clusterName?: string;
  /** Cluster-level time scale (1 = real time). */
  timeScale?: number;
}

export const DEFAULT_EPOCH_MS = Date.UTC(2026, 9, 5, 9, 0, 0);

export class Engine {
  readonly clock: Clock;
  readonly rng: Rng;
  readonly store: ClusterStore;
  readonly images: ImageCatalog;
  readonly traffic: TrafficSim;
  readonly podRuntimes = new Map<string, PodRuntime>();
  readonly nodeRuntimes = new Map<string, NodeRuntime>();
  /** Controller-private state keyed by string (never serialised into objects). */
  readonly scratch = new Map<string, unknown>();
  readonly evictionSeconds: number;
  readonly version: string;
  readonly clusterName: string;
  readonly timeScale: number;
  /** Tick counter (100ms quanta). */
  ticks = 0;
  /** Current kubeconfig context state. */
  currentNamespace = 'default';
  private ipCounters = new Map<string, number>();
  private clusterIpCounter = 10;
  private nodePortCounter = 30000;
  private podCidrIndex = 0;

  constructor(setup: ClusterSetup) {
    const epoch = setup.epochMs ?? DEFAULT_EPOCH_MS;
    const age = setup.clusterAgeSeconds ?? 14 * 86400;
    this.clock = new Clock(epoch - age * 1000);
    this.rng = new Rng(setup.seed ?? 42);
    this.store = new ClusterStore(this.clock);
    this.images = baseCatalog();
    if (setup.images) for (const [k, v] of makeCatalog(setup.images)) this.images.set(k, v);
    this.evictionSeconds = setup.evictionSeconds ?? 300;
    this.version = setup.kubernetesVersion ?? 'v1.32.3';
    this.clusterName = setup.clusterName ?? 'orbital-prod';
    this.timeScale = setup.timeScale ?? 1;
    this.traffic = new TrafficSim(this);

    for (const ns of ['default', 'kube-system', 'kube-public', 'kube-node-lease', ...(setup.namespaces ?? [])]) this.ensureNamespace(ns);
    for (const n of setup.nodes) this.addNode(n);

    // Pre-existing objects, oldest first, reconciled by fast-forwarding the clock.
    const objs = [...(setup.objects ?? [])].sort((a, b) => (b.ageSeconds ?? 0) - (a.ageSeconds ?? 0));
    for (const o of objs) {
      const at = epoch - (o.ageSeconds ?? 0) * 1000;
      this.fastForwardTo(at);
      const obj = applyDefaults(structuredClone(o.object), this);
      this.store.create(obj);
    }
    this.fastForwardTo(epoch);
    for (const t of setup.traffic ?? []) this.traffic.addSource(t);
  }

  /** Advance to an absolute time using coarse steps when far away (setup only). */
  private fastForwardTo(targetMs: number): void {
    while (this.clock.nowMs < targetMs) {
      const remaining = targetMs - this.clock.nowMs;
      const step = remaining > 3_600_000 ? 600_000 : remaining > 120_000 ? 30_000 : remaining > 10_000 ? 1000 : Math.min(remaining, 100);
      this.tick(step);
    }
  }

  ensureNamespace(name: string): Namespace {
    const existing = this.store.get<Namespace>('Namespace', undefined, name);
    if (existing) return existing;
    const ns: Namespace = {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name, labels: { 'kubernetes.io/metadata.name': name } },
      spec: { finalizers: ['kubernetes'] },
      status: { phase: 'Active' },
    };
    return this.store.create(ns);
  }

  addNode(n: NodeSetup): Node {
    const idx = this.podCidrIndex++;
    const roles = n.roles ?? ['worker'];
    const labels: Record<string, string> = {
      'beta.kubernetes.io/arch': 'amd64',
      'beta.kubernetes.io/os': 'linux',
      'kubernetes.io/arch': 'amd64',
      'kubernetes.io/hostname': n.name,
      'kubernetes.io/os': 'linux',
      ...(n.labels ?? {}),
    };
    for (const r of roles) if (r !== 'worker') labels[`node-role.kubernetes.io/${r}`] = '';
    const cpu = n.cpu ?? '4';
    const memory = n.memory ?? '8Gi';
    const version = n.version ?? this.version;
    const taints: Taint[] = [...(n.taints ?? [])];
    if (roles.includes('control-plane') && !taints.some((t) => t.key === 'node-role.kubernetes.io/control-plane')) {
      taints.push({ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' });
    }
    const node: Node = {
      apiVersion: 'v1',
      kind: 'Node',
      metadata: { name: n.name, labels, annotations: { 'node.alpha.kubernetes.io/ttl': '0', 'volumes.kubernetes.io/controller-managed-attach-detach': 'true' } },
      spec: { podCIDR: `10.244.${idx}.0/24`, podCIDRs: [`10.244.${idx}.0/24`], ...(taints.length ? { taints } : {}), ...(n.unschedulable ? { unschedulable: true } : {}) },
      status: {
        capacity: { cpu, 'ephemeral-storage': '61202244Ki', memory, pods: String(n.pods ?? 110) },
        allocatable: { cpu, 'ephemeral-storage': '56403987978', memory, pods: String(n.pods ?? 110) },
        conditions: [],
        addresses: [
          { type: 'InternalIP', address: `172.18.0.${idx + 2}` },
          { type: 'Hostname', address: n.name },
        ],
        nodeInfo: {
          kubeletVersion: version,
          kubeProxyVersion: version,
          osImage: 'Debian GNU/Linux 12 (bookworm)',
          kernelVersion: '6.8.0-142-generic',
          containerRuntimeVersion: 'containerd://1.7.24',
          operatingSystem: 'linux',
          architecture: 'amd64',
        },
        images: [],
      },
    };
    const created = this.store.create(node);
    this.nodeRuntimes.set(n.name, { name: n.name, ready: n.ready ?? true, imageCache: new Set(), lastHeartbeat: this.clock.nowMs });
    return created;
  }

  nodeRuntime(name: string): NodeRuntime {
    let r = this.nodeRuntimes.get(name);
    if (!r) {
      r = { name, ready: true, imageCache: new Set(), lastHeartbeat: this.clock.nowMs };
      this.nodeRuntimes.set(name, r);
    }
    return r;
  }

  podRuntime(pod: Pod): PodRuntime {
    const uid = pod.metadata.uid as string;
    let r = this.podRuntimes.get(uid);
    if (!r) {
      r = { uid, containers: [] };
      this.podRuntimes.set(uid, r);
    }
    return r;
  }

  /** Allocate a pod IP in the node's CIDR. */
  allocatePodIp(nodeName: string): string {
    const node = this.store.get<Node>('Node', undefined, nodeName);
    const cidr = node?.spec.podCIDR ?? '10.244.99.0/24';
    const base = cidr.split('/')[0] as string;
    const n = (this.ipCounters.get(nodeName) ?? 1) + 1;
    this.ipCounters.set(nodeName, n);
    const parts = base.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.${(n % 250) + 2}`;
  }

  allocateClusterIp(): string {
    this.clusterIpCounter++;
    const c = this.clusterIpCounter;
    return `10.96.${Math.floor(c / 250)}.${(c % 250) + 1}`;
  }

  allocateNodePort(): number {
    this.nodePortCounter += 1 + this.rng.int(7);
    return this.nodePortCounter;
  }

  /** Advance the simulation by dtMs (game time). */
  tick(dtMs: number): void {
    this.clock.advance(dtMs);
    this.ticks++;
    runNodeLifecycle(this);
    runScheduler(this);
    runKubelet(this, dtMs);
    runReplicaSetController(this);
    runDeploymentController(this);
    runDaemonSetController(this);
    runJobController(this);
    runCronJobController(this);
    runServiceController(this);
    runEndpointsController(this);
    runGarbageCollector(this);
    this.traffic.tick(dtMs);
  }

  /** Advance by whole seconds in 100ms steps (tests and scripted solutions). */
  advance(seconds: number, stepMs = 100): void {
    let remaining = seconds * 1000;
    while (remaining > 0) {
      const s = Math.min(stepMs, remaining);
      this.tick(s);
      remaining -= s;
    }
  }

  nowIso(): string {
    return this.clock.iso();
  }
}
