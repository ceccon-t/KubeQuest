import type { Mission } from '../game/mission.ts';
import { ORBITAL_IMAGES, REG, deployment, service, orbitalNodes, systemWorkloads, usedCmd } from './lib.ts';

export const m0_1: Mission = {
  id: '0.1', chapter: 0, order: 1, title: 'Welcome aboard', tagline: 'Your first shift at Orbital Logistics.', tutorial: true,
  ticket: {
    from: 'Chief Helmsman Okafor', priority: 'P4', subject: 'Onboarding: look around before you touch anything',
    body: [
      'Welcome to the on-call rotation. The platform runs on a Kubernetes cluster called orbital-prod.',
      'Before you get paged for real, get your bearings: list the nodes, list the pods in every namespace, and read the details of one of the frontend pods.',
      'The terminal at the bottom is your workstation. The map on the left is a live view of the cluster — watch it react to what you type.',
      'Tip: Tab completes commands and names. ↑ recalls history. `k` is an alias for `kubectl`.',
    ],
  },
  concepts: [
    { title: 'A cluster is nodes + a control plane', body: 'The **control plane** (API server, scheduler, controller manager, etcd) decides *what* should run. **Nodes** (kubelet, kube-proxy, container runtime) actually run it. Everything you do goes through the API server, and `kubectl` is just a client for it.', example: 'kubectl get nodes' },
    { title: 'get, then describe', body: '`kubectl get TYPE` lists objects in a table. `kubectl describe TYPE NAME` shows one object in depth, including its recent **events** — the first place to look when something is wrong.', example: 'kubectl get pods -n freight\nkubectl describe pod <name> -n freight' },
    { title: 'Namespaces', body: 'Objects live in **namespaces**. Without `-n`, kubectl uses your context\'s default namespace (`default`). `-A` shows every namespace at once.', example: 'kubectl get pods -A' },
  ],
  cluster: {
    seed: 11, nodes: orbitalNodes(), namespaces: ['freight', 'billing'],
    images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.0`, replicas: 2, port: 8080 }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
      { ageSeconds: 5 * 86400, object: deployment({ name: 'redis-cache', ns: 'freight', image: 'redis:7', replicas: 1, port: 6379 }) },
      { ageSeconds: 2 * 86400, object: deployment({ name: 'invoicer', ns: 'billing', image: `${REG}/notifier:1.2.0`, replicas: 1, port: 8080 }) },
    ],
    traffic: [{ id: 'customers', service: 'freight/frontend', rps: 4, label: 'customers' }],
  },
  objectives: [
    { id: 'nodes', text: 'List the nodes of the cluster', check: (c) => usedCmd(c, /^kubectl get (nodes?|no)\b/) },
    { id: 'pods-all', text: 'List pods across all namespaces (-A)', check: (c) => usedCmd(c, /^kubectl get (pods?|po) .*(-A|--all-namespaces)/) || usedCmd(c, /^kubectl get (-A|--all-namespaces) (pods?|po)/) },
    { id: 'describe', text: 'Describe one of the frontend pods in the freight namespace', check: (c) => usedCmd(c, /^kubectl describe (pods?|po)[ /]frontend-/) },
    { id: 'deploy', text: 'List the deployments in the freight namespace', check: (c) => usedCmd(c, /^kubectl get (deployments?|deploy)\b.*(-n freight|--namespace[= ]freight)/) || usedCmd(c, /^kubectl get (-n|--namespace) freight (deployments?|deploy)\b/) },
  ],
  hints: [
    { text: 'Start with `kubectl get nodes`. Then `kubectl get pods -A` to see every pod in every namespace.', cost: 50 },
    { text: 'Pick a pod name from the freight namespace and run `kubectl describe pod <name> -n freight`. Tab completion fills names in.', cost: 50 },
    { text: 'Deployments: `kubectl get deployments -n freight` (or `deploy` for short).', cost: 50 },
  ],
  par: { timeSec: 180, commands: 5 },
  solution: ['kubectl get nodes', 'kubectl get pods -A', 'kubectl get pods -n freight', 'kubectl describe pod $(kubectl get pods -n freight -o name | grep frontend | head -1 | cut -d/ -f2) -n freight', 'kubectl get deploy -n freight'],
  debrief: { proTips: ['`kubectl get po -A -o wide` adds node and IP columns — handy during incidents.', 'You can describe several objects at once: `kubectl describe pods -n freight` describes all of them.', 'Set a default namespace so you can drop `-n`: `kubectl config set-context --current --namespace=freight`.'] },
};

export const chapter0: Mission[] = [m0_1];
