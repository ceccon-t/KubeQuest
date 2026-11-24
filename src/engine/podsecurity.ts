/** Pod Security Standards checks with upstream reason/detail strings. upstream: staging/src/k8s.io/pod-security-admission/policy */
import type { PodSpec, Container, KubeObject } from './types.ts';

export type PssLevel = 'privileged' | 'baseline' | 'restricted';
export interface PssViolation { reason: string; detail: string }

const DEFAULT_CAPS = new Set(['AUDIT_WRITE', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'MKNOD', 'NET_BIND_SERVICE', 'SETFCAP', 'SETGID', 'SETPCAP', 'SETUID', 'SYS_CHROOT']);
const RESTRICTED_VOLUMES = ['configMap', 'csi', 'downwardAPI', 'emptyDir', 'ephemeral', 'persistentVolumeClaim', 'projected', 'secret'];

const quoted = (names: string[]): string => names.map((n) => `"${n}"`).join(', ');
const cWord = (names: string[]): string => `${names.length > 1 ? 'containers' : 'container'} ${quoted(names)}`;

/** Violations of a Pod Security Standard level, in the order the admission plugin reports them. */
export function checkPodSecurity(level: PssLevel, spec: PodSpec): PssViolation[] {
  if (level === 'privileged') return [];
  const restricted = level === 'restricted';
  const containers: Container[] = [...spec.containers, ...(spec.initContainers ?? []), ...(spec.ephemeralContainers ?? [])];
  const out: PssViolation[] = [];
  const names = (pred: (c: Container) => boolean): string[] => containers.filter(pred).map((c) => c.name);
  // --- baseline (sorted by check id) ---
  if (!restricted) {
    const bad = containers.map((c) => ({ c: c.name, caps: (c.securityContext?.capabilities?.add ?? []).filter((x) => !DEFAULT_CAPS.has(x)) })).filter((x) => x.caps.length);
    if (bad.length) out.push({ reason: 'non-default capabilities', detail: bad.map((b) => `container "${b.c}" must not include ${quoted(b.caps)} in securityContext.capabilities.add`).join('; ') });
  }
  const host = [spec.hostNetwork ? 'hostNetwork=true' : '', spec.hostPID ? 'hostPID=true' : '', spec.hostIPC ? 'hostIPC=true' : ''].filter((x) => x);
  if (host.length) out.push({ reason: 'host namespaces', detail: host.join(', ') });
  const hostPaths = (spec.volumes ?? []).filter((v) => v.hostPath).map((v) => v.name);
  if (hostPaths.length && !restricted) out.push({ reason: 'hostPath volumes', detail: `${hostPaths.length > 1 ? 'volumes' : 'volume'} ${quoted(hostPaths)}` });
  const hp = containers.map((c) => ({ c: c.name, ports: (c.ports ?? []).filter((p) => p.hostPort).map((p) => p.hostPort as number) })).filter((x) => x.ports.length);
  if (hp.length) {
    const ports = hp.flatMap((x) => x.ports);
    out.push({ reason: 'hostPort', detail: `${cWord(hp.map((x) => x.c))} ${hp.length > 1 ? 'use' : 'uses'} ${ports.length > 1 ? 'hostPorts' : 'hostPort'} ${ports.join(', ')}` });
  }
  const priv = names((c) => c.securityContext?.privileged === true);
  if (priv.length) out.push({ reason: 'privileged', detail: `${cWord(priv)} must not set securityContext.privileged=true` });
  if (!restricted) {
    const unconfined = names((c) => (c.securityContext?.seccompProfile?.type ?? spec.securityContext?.seccompProfile?.type) === 'Unconfined');
    if (unconfined.length) out.push({ reason: 'seccompProfile', detail: `${cWord(unconfined)} must not set securityContext.seccompProfile.type to "Unconfined"` });
    return out;
  }
  // --- restricted (sorted by check id) ---
  const ape = names((c) => c.securityContext?.allowPrivilegeEscalation !== false);
  if (ape.length) out.push({ reason: 'allowPrivilegeEscalation != false', detail: `${cWord(ape)} must set securityContext.allowPrivilegeEscalation=false` });
  const noDrop = names((c) => !(c.securityContext?.capabilities?.drop ?? []).includes('ALL'));
  const badAdd = containers.map((c) => ({ c: c.name, caps: (c.securityContext?.capabilities?.add ?? []).filter((x) => x !== 'NET_BIND_SERVICE') })).filter((x) => x.caps.length);
  if (noDrop.length || badAdd.length) {
    const parts: string[] = [];
    if (noDrop.length) parts.push(`${cWord(noDrop)} must set securityContext.capabilities.drop=["ALL"]`);
    for (const b of badAdd) parts.push(`container "${b.c}" must not include ${quoted(b.caps)} in securityContext.capabilities.add`);
    out.push({ reason: 'unrestricted capabilities', detail: parts.join('; ') });
  }
  const badVols = (spec.volumes ?? []).map((v) => ({ v: v.name, type: Object.keys(v).find((k) => k !== 'name') ?? '' })).filter((x) => x.type && !RESTRICTED_VOLUMES.includes(x.type));
  if (badVols.length) out.push({ reason: 'restricted volume types', detail: badVols.map((b) => `volume "${b.v}" uses restricted volume type "${b.type}"`).join(', ') });
  const podNonRoot = spec.securityContext?.runAsNonRoot;
  const nonRoot = names((c) => (c.securityContext?.runAsNonRoot ?? podNonRoot) !== true);
  if (nonRoot.length) out.push({ reason: 'runAsNonRoot != true', detail: `pod or ${cWord(nonRoot)} must set securityContext.runAsNonRoot=true` });
  const asRoot = names((c) => c.securityContext?.runAsUser === 0);
  if (spec.securityContext?.runAsUser === 0 || asRoot.length) out.push({ reason: 'runAsUser=0', detail: [spec.securityContext?.runAsUser === 0 ? 'pod must not set runAsUser=0' : '', asRoot.length ? `${cWord(asRoot)} must not set runAsUser=0` : ''].filter((x) => x).join('; ') });
  const seccomp = names((c) => !['RuntimeDefault', 'Localhost'].includes(c.securityContext?.seccompProfile?.type ?? spec.securityContext?.seccompProfile?.type ?? ''));
  if (seccomp.length) out.push({ reason: 'seccompProfile', detail: `pod or ${cWord(seccomp)} must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost"` });
  return out;
}

export interface PssPolicy { enforce?: PssLevel; warn?: PssLevel; audit?: PssLevel; versions: Record<string, string> }

/** Read the `pod-security.kubernetes.io/*` labels of a namespace. */
export function namespacePolicy(ns: KubeObject | undefined): PssPolicy {
  const labels = ns?.metadata.labels ?? {};
  const p: PssPolicy = { versions: {} };
  for (const mode of ['enforce', 'warn', 'audit'] as const) {
    const v = labels[`pod-security.kubernetes.io/${mode}`];
    if (v === 'privileged' || v === 'baseline' || v === 'restricted') p[mode] = v;
    p.versions[mode] = labels[`pod-security.kubernetes.io/${mode}-version`] ?? 'latest';
  }
  return p;
}

export function violationText(v: PssViolation[]): string {
  return v.map((x) => `${x.reason} (${x.detail})`).join(', ');
}

/** The pod template embedded in a workload object, if it has one. */
export function podSpecOf(obj: KubeObject): PodSpec | undefined {
  const spec = obj.spec as { template?: { spec?: PodSpec }; jobTemplate?: { spec?: { template?: { spec?: PodSpec } } } } | undefined;
  switch (obj.kind) {
    case 'Pod': return obj.spec as unknown as PodSpec;
    case 'Deployment': case 'ReplicaSet': case 'DaemonSet': case 'StatefulSet': case 'Job': return spec?.template?.spec;
    case 'CronJob': return spec?.jobTemplate?.spec?.template?.spec;
    default: return undefined;
  }
}
