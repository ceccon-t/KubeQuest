/** Traffic generator: synthetic requests to Services with SLO accounting and visual packet events. */
import type { Engine } from './engine.ts';
import type { Service, Pod } from './types.ts';
import { serviceBackends, resolveTargetPort } from './controllers/service.ts';
import { requestPod } from './appsim.ts';

export interface TrafficSource {
  id: string;
  /** `namespace/service` */
  service: string;
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

export class TrafficSim {
  private engine: Engine;
  private sources: TrafficSource[] = [];
  private accumulators = new Map<string, number>();
  private rr = new Map<string, number>();
  private history: { at: number; ok: boolean }[] = [];
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

  /** One synthetic request through the service (as kube-proxy would route it). */
  request(src: TrafficSource, now: number): Packet {
    const [ns, name] = src.service.split('/') as [string, string];
    const svc = this.engine.store.get<Service>('Service', ns, name);
    let pkt: Packet;
    if (!svc) pkt = { at: now, sourceId: src.id, service: src.service, outcome: 'dropped' };
    else {
      const { ready } = serviceBackends(this.engine, svc);
      const port = (svc.spec.ports ?? []).find((p) => !src.port || p.port === src.port) ?? svc.spec.ports?.[0];
      if (!ready.length || !port) pkt = { at: now, sourceId: src.id, service: src.service, outcome: 'dropped' };
      else {
        const i = (this.rr.get(src.id) ?? 0) % ready.length;
        this.rr.set(src.id, i + 1);
        const pod = ready[i] as Pod;
        const target = resolveTargetPort(svc, port, pod);
        const r = requestPod(this.engine, pod, target, src.path ?? '/');
        const ok = r.ok && r.status < 500;
        pkt = { at: now, sourceId: src.id, service: src.service, podUid: pod.metadata.uid, outcome: ok ? 'ok' : 'error', status: r.ok ? r.status : undefined };
      }
    }
    this.packets.push(pkt);
    this.history.push({ at: now, ok: pkt.outcome === 'ok' });
    if (pkt.outcome === 'ok') this.total.served++;
    else if (pkt.outcome === 'error') this.total.failed++;
    else this.total.dropped++;
    return pkt;
  }

  stats(): SloStats {
    let served = 0, bad = 0;
    for (const h of this.history) if (h.ok) served++; else bad++;
    const n = served + bad;
    return { served, failed: bad, dropped: 0, availability: n === 0 ? 1 : served / n, total: { ...this.total } };
  }
}
