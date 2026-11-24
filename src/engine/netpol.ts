/**
 * NetworkPolicy evaluation as a policy-enforcing CNI (Cilium, Calico) would do it: a pod selected by any policy
 * of a direction is isolated for that direction and only the union of the matching rules is allowed.
 * Kubelet probes are not subject to it (traffic from the pod's own node is always allowed).
 */
import type { Engine } from './engine.ts';
import type { Pod, NetworkPolicy, NetworkPolicyPeer, NetworkPolicyPort, Namespace } from './types.ts';
import { fromLabelSelector, matches } from './selector.ts';

/** One end of a connection. `external` peers are clients outside the cluster network. */
export interface Peer { namespace?: string; labels?: Record<string, string>; ip?: string; external?: boolean }

export function podPeer(pod: Pod): Peer {
  return { namespace: pod.metadata.namespace, labels: pod.metadata.labels ?? {}, ip: pod.status.podIP };
}
export const EXTERNAL: Peer = { external: true, ip: '198.51.100.7' };

function ipToInt(ip: string): number | undefined {
  const p = ip.split('.').map((x) => parseInt(x, 10));
  if (p.length !== 4 || p.some((x) => Number.isNaN(x) || x < 0 || x > 255)) return undefined;
  return ((p[0] as number) * 2 ** 24) + ((p[1] as number) << 16) + ((p[2] as number) << 8) + (p[3] as number);
}
function inCidr(ip: string | undefined, cidr: string): boolean {
  if (!ip) return false;
  const [base, bitsRaw] = cidr.split('/') as [string, string | undefined];
  const bits = bitsRaw === undefined ? 32 : parseInt(bitsRaw, 10);
  const a = ipToInt(ip), b = ipToInt(base);
  if (a === undefined || b === undefined) return false;
  if (bits === 0) return true;
  const size = 2 ** (32 - bits);
  return Math.floor(a / size) === Math.floor(b / size);
}

function peerMatches(engine: Engine, rule: NetworkPolicyPeer, peer: Peer, policyNs: string): boolean {
  if (rule.ipBlock) return inCidr(peer.ip, rule.ipBlock.cidr) && !(rule.ipBlock.except ?? []).some((c) => inCidr(peer.ip, c));
  if (peer.external || peer.namespace === undefined) return false;
  if (rule.namespaceSelector) {
    const ns = engine.store.get<Namespace>('Namespace', undefined, peer.namespace);
    if (!matches(fromLabelSelector(rule.namespaceSelector), ns?.metadata.labels)) return false;
  } else if (peer.namespace !== policyNs) return false;
  return !rule.podSelector || matches(fromLabelSelector(rule.podSelector), peer.labels);
}

function portMatches(ports: NetworkPolicyPort[] | undefined, port: number, protocol: string, named: (name: string) => number | undefined): boolean {
  if (!ports?.length) return true;
  return ports.some((p) => {
    if ((p.protocol ?? 'TCP') !== protocol) return false;
    if (p.port === undefined) return true;
    const from = typeof p.port === 'number' ? p.port : /^\d+$/.test(p.port) ? parseInt(p.port, 10) : named(p.port);
    if (from === undefined) return false;
    return p.endPort !== undefined ? port >= from && port <= p.endPort : port === from;
  });
}

function policiesFor(engine: Engine, pod: Pod, direction: 'Ingress' | 'Egress'): NetworkPolicy[] {
  return engine.store.list<NetworkPolicy>('NetworkPolicy', pod.metadata.namespace).filter((np) => {
    // policyTypes defaults to [Ingress], plus Egress when the policy has egress rules
    const types = np.spec.policyTypes ?? (np.spec.egress ? ['Ingress', 'Egress'] : ['Ingress']);
    return types.includes(direction) && matches(fromLabelSelector(np.spec.podSelector), pod.metadata.labels);
  });
}

/** May `src` open a connection to `dst` on this port? */
export function ingressAllowed(engine: Engine, src: Peer, dst: Pod, port: number, protocol = 'TCP'): boolean {
  if (!engine.networkPolicyEnforced) return true;
  const policies = policiesFor(engine, dst, 'Ingress');
  if (!policies.length) return true;
  const named = (name: string): number | undefined => dst.spec.containers.flatMap((c) => c.ports ?? []).find((p) => p.name === name)?.containerPort;
  return policies.some((np) => (np.spec.ingress ?? []).some((rule) => portMatches(rule.ports, port, protocol, named) && (!rule.from?.length || rule.from.some((f) => peerMatches(engine, f, src, np.metadata.namespace as string)))));
}

/** May the pod `src` open a connection to `dst` on this port? */
export function egressAllowed(engine: Engine, src: Pod, dst: Peer, port: number, protocol = 'TCP'): boolean {
  if (!engine.networkPolicyEnforced) return true;
  const policies = policiesFor(engine, src, 'Egress');
  if (!policies.length) return true;
  return policies.some((np) => (np.spec.egress ?? []).some((rule) => portMatches(rule.ports, port, protocol, () => undefined) && (!rule.to?.length || rule.to.some((t) => peerMatches(engine, t, dst, np.metadata.namespace as string)))));
}

/** Can the pod reach cluster DNS (UDP/53 to the kube-dns pods)? A default-deny egress policy breaks name resolution first. */
export function dnsAllowed(engine: Engine, src: Pod): boolean {
  if (!engine.networkPolicyEnforced) return true;
  const dns = engine.store.list<Pod>('Pod', 'kube-system').find((p) => p.metadata.labels?.['k8s-app'] === 'kube-dns');
  const peer: Peer = dns ? podPeer(dns) : { namespace: 'kube-system', labels: { 'k8s-app': 'kube-dns' }, ip: '10.96.0.10' };
  return egressAllowed(engine, src, peer, 53, 'UDP');
}

/** Full check for a connection to a pod: egress of the source (when it is a pod) and ingress of the destination. */
export function connectionAllowed(engine: Engine, src: Peer, srcPod: Pod | undefined, dst: Pod, port: number): boolean {
  if (srcPod && srcPod.metadata.uid === dst.metadata.uid) return true;
  if (srcPod && !egressAllowed(engine, srcPod, podPeer(dst), port)) return false;
  return ingressAllowed(engine, src, dst, port);
}
