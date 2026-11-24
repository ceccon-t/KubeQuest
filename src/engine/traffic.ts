/** Traffic generator: synthetic requests to Services with SLO accounting and visual packet events. */
import type { Engine } from './engine.ts';
import type { Service, Pod } from './types.ts';
import { serviceBackends, resolveTargetPort } from './controllers/service.ts';
import { requestPod } from './appsim.ts';
import { EXTERNAL, podPeer, dnsAllowed, type Peer } from './netpol.ts';
import { parseSelectorString, matches } from './selector.ts';
import { certProblem } from './http.ts';

export interface TrafficSource {
  id: string;
  /** `namespace/service` — the Service the client talks to (ignored when `http` is set). */
  service: string;
  /** Requests that enter through an Ingress or Gateway instead of a Service: host/path/scheme as the client sends them. */
  http?: { host: string; path?: string; tls?: boolean };
  /** The client is a pod inside the cluster (`namespace/label=value`); NetworkPolicies see it as that peer. */
  from?: string;
  port?: number;
  path?: string;
  rps: number;
  /** Human label shown on the map (e.g. "customers"). */
  label?: string;
}

export interface Packet {
  at: number;
  sourceId: string;
  service: string;
  podUid?: string;
  outcome: 'ok' | 'error' | 'dropped';
  status?: number;
}

export interface SloStats {
  served: number;
  failed: number;
  dropped: number;
  /** Availability over the rolling window, 0..1 (1 when no traffic). */
  availability: number;
  /** Lifetime totals. */
  total: { served: number; failed: number; dropped: number };
}

const WINDOW_MS = 60_000;
const RATE_WINDOW_S = 5;

export class TrafficSim {
  private engine: Engine;
  private sources: TrafficSource[] = [];
  private accumulators = new Map<string, number>();
  private rr = new Map<string, number>();
  private history: { at: number; ok: boolean }[] = [];
  /** Requests routed to each pod in one-second buckets (drives per-pod load, CPU usage and the HPA). */
  private hits = new Map<string, { second: number; counts: number[] }>();
  /** Packets generated since the UI last drained them (capped). */
  packets: Packet[] = [];
  total = { served: 0, failed: 0, dropped: 0 };
  /** When false, no traffic is generated (e.g. during briefing). */
  enabled = true;

  constructor(engine: Engine) {
    this.engine = engine;
  }

  addSource(src: TrafficSource): void {
    this.sources = this.sources.filter((s) => s.id !== src.id);
    this.sources.push(src);
  }
  removeSource(id: string): void {
    this.sources = this.sources.filter((s) => s.id !== id);
  }
  setRps(id: string, rps: number): void {
    const s = this.sources.find((x) => x.id === id);
    if (s) s.rps = rps;
  }
  list(): TrafficSource[] {
    return this.sources;
  }

  recordHit(uid: string, now: number): void {
    const second = Math.floor(now / 1000);
    let h = this.hits.get(uid);
    if (!h) { h = { second, counts: new Array<number>(RATE_WINDOW_S).fill(0) }; this.hits.set(uid, h); }
    const gap = second - h.second;
    if (gap > 0) { for (let i = 0; i < Math.min(gap, RATE_WINDOW_S); i++) h.counts[(h.second + 1 + i) % RATE_WINDOW_S] = 0; h.second = second; }
    h.counts[second % RATE_WINDOW_S] = (h.counts[second % RATE_WINDOW_S] ?? 0) + 1;
  }

  /** Requests per second a pod received over the last few seconds. */
  podRate(uid: string): number {
    const h = this.hits.get(uid);
    if (!h) return 0;
    const second = Math.floor(this.engine.clock.nowMs / 1000);
    let total = 0;
    for (let i = 0; i < RATE_WINDOW_S; i++) { const s = second - i; if (s > h.second || h.second - s >= RATE_WINDOW_S) continue; total += h.counts[((s % RATE_WINDOW_S) + RATE_WINDOW_S) % RATE_WINDOW_S] ?? 0; }
    return total / RATE_WINDOW_S;
  }

  /** Hand the accumulated packets to the UI and reset the buffer. */
  drain(): Packet[] {
    const p = this.packets;
    this.packets = [];
    return p;
  }

  tick(dtMs: number): void {
    if (this.packets.length > 400) this.packets.splice(0, this.packets.length - 400);
    if (!this.enabled) return;
    const now = this.engine.clock.nowMs;
    for (const src of this.sources) {
      const acc = (this.accumulators.get(src.id) ?? 0) + (src.rps * dtMs) / 1000;
      let n = Math.floor(acc);
      // light jitter
      if (n > 0 && this.engine.rng.next() < 0.15) n = Math.max(0, n + (this.engine.rng.next() < 0.5 ? -1 : 1));
      this.accumulators.set(src.id, acc - Math.floor(acc));
      for (let i = 0; i < n; i++) this.request(src, now);
    }
    const cutoff = now - WINDOW_MS;
    while (this.history.length && (this.history[0] as { at: number }).at < cutoff) this.history.shift();
  }

  /** The network identity of a traffic source: an in-cluster client pod, or a client outside the cluster. */
  private client(src: TrafficSource): { peer: Peer; pod?: Pod } {
    if (!src.from) return { peer: EXTERNAL };
    const [ns, sel] = src.from.split('/') as [string, string | undefined];
    const reqs = parseSelectorString(sel ?? '');
    const pod = this.engine.store.list<Pod>('Pod', ns).find((p) => matches(reqs, p.metadata.labels) && !p.metadata.deletionTimestamp);
    const labels: Record<string, string> = {};
    for (const r of reqs) if (r.op === 'in' && r.values[0] !== undefined) labels[r.key] = r.values[0];
    return { peer: pod ? podPeer(pod) : { namespace: ns, labels }, pod };
  }

  /** One synthetic request through the service (as kube-proxy would route it). */
  request(src: TrafficSource, now: number): Packet {
    const [ns, name] = src.service.split('/') as [string, string];
    const svc = this.engine.store.get<Service>('Service', ns, name);
    let pkt: Packet;
    const dropped = (): Packet => ({ at: now, sourceId: src.id, service: src.service, outcome: 'dropped' });
    if (!svc) pkt = dropped();
    else {
      const { ready } = serviceBackends(this.engine, svc);
      const wantPort = src.port ?? (src.http ? (src.http.tls ? 443 : 80) : undefined);
      const port = (svc.spec.ports ?? []).find((p) => wantPort === undefined || p.port === wantPort) ?? (src.http ? undefined : svc.spec.ports?.[0]);
      const who = this.client(src);
      if (!ready.length || !port) pkt = dropped();
      else if (who.pod && !dnsAllowed(this.engine, who.pod)) pkt = dropped();
      else {
        const i = (this.rr.get(src.id) ?? 0) % ready.length;
        this.rr.set(src.id, i + 1);
        const pod = ready[i] as Pod;
        const target = resolveTargetPort(svc, port, pod);
        const r = requestPod(this.engine, pod, target, src.http?.path ?? src.path ?? '/', { host: src.http?.host, tls: src.http?.tls, from: who.peer, fromPod: who.pod, load: true });
        // an untrusted or mismatching certificate fails the client's TLS handshake
        const tlsOk = !src.http?.tls || (r.ok && !!r.cert && certProblem(this.engine, r.cert, src.http.host) === undefined);
        // a user behind an Ingress/Gateway needs the page (2xx/3xx); a 404 from the proxy is a failure for them
        const ok = r.ok && r.status < (src.http ? 400 : 500) && tlsOk;
        pkt = { at: now, sourceId: src.id, service: src.service, podUid: (r.ok ? r.servedBy : undefined) ?? pod.metadata.uid, outcome: ok ? 'ok' : 'error', status: r.ok ? r.status : undefined };
      }
    }
    this.packets.push(pkt);
    this.history.push({ at: now, ok: pkt.outcome === 'ok' });
    if (pkt.outcome === 'ok') this.total.served++;
    else if (pkt.outcome === 'error') this.total.failed++;
    else this.total.dropped++;
    return pkt;
  }

  /** Start a fresh measurement (a mission that deliberately breaks things first, then measures the steady state). */
  resetStats(): void {
    this.history = [];
    this.total = { served: 0, failed: 0, dropped: 0 };
  }

  stats(): SloStats {
    let served = 0, bad = 0;
    for (const h of this.history) if (h.ok) served++; else bad++;
    const n = served + bad;
    return { served, failed: bad, dropped: 0, availability: n === 0 ? 1 : served / n, total: { ...this.total } };
  }
}
