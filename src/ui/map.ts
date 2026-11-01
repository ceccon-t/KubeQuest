/** Cluster map renderer (Canvas 2D): nodes as racks, pods as tiles, services as hubs, traffic as packets. */
import type { MissionRuntime } from '../game/runtime.ts';
import type { Pod, Node, Service, Event } from '../engine/types.ts';
import type { Packet } from '../engine/traffic.ts';
import { podStatusReason } from '../engine/kubectl/printers.ts';
import { isPodReady } from '../engine/controllers/kubelet.ts';
import { serviceBackends } from '../engine/controllers/service.ts';
import { parseCpuMillis, parseMemoryBytes } from '../engine/duration.ts';
import { nodeRequested } from '../engine/controllers/scheduler.ts';

interface Tile { uid: string; x: number; y: number; w: number; h: number; born: number; dying?: number; pod: Pod }
interface Hub { key: string; x: number; y: number; svc: Service; label: string }
interface Flight { from: { x: number; y: number }; to: { x: number; y: number }; via?: { x: number; y: number }; t0: number; dur: number; outcome: Packet['outcome'] }

const COLORS = { ready: '#3ddc84', running: '#ffb020', amber: '#ffb020', pending: '#8b97b8', crash: '#ff4d5e', pull: '#b388ff', terminating: '#5b6b8f', node: '#141d33', nodeDown: '#3a1b2a', line: '#2a3658', text: '#e6ecff', muted: '#8b97b8', hub: '#5b8def' };

function shortName(pod: Pod): { title: string; sub: string } {
  const owner = pod.metadata.ownerReferences?.find((r) => r.controller);
  const n = pod.metadata.name;
  if (owner?.kind === 'ReplicaSet') { const parts = n.split('-'); return { title: parts.slice(0, -2).join('-'), sub: parts.slice(-1)[0] ?? '' }; }
  if (owner) { const parts = n.split('-'); return { title: parts.slice(0, -1).join('-'), sub: parts.slice(-1)[0] ?? '' }; }
  return { title: n, sub: '' };
}

function podColor(pod: Pod): { fill: string; pulse: boolean; glyph: string } {
  const reason = podStatusReason(pod);
  if (pod.metadata.deletionTimestamp) return { fill: COLORS.terminating, pulse: false, glyph: '…' };
  if (reason === 'Running' && isPodReady(pod)) return { fill: COLORS.ready, pulse: false, glyph: '' };
  if (reason === 'CrashLoopBackOff' || reason === 'Error' || reason === 'OOMKilled') return { fill: COLORS.crash, pulse: true, glyph: '!' };
  if (reason === 'ImagePullBackOff' || reason === 'ErrImagePull' || reason === 'CreateContainerConfigError' || reason === 'ErrImageNeverPull') return { fill: COLORS.pull, pulse: true, glyph: '?' };
  if (reason === 'Completed' || pod.status.phase === 'Succeeded') return { fill: '#2f8f5b', pulse: false, glyph: '✓' };
  if (reason === 'Pending' || reason === 'ContainerCreating') return { fill: COLORS.pending, pulse: false, glyph: '◌' };
  return { fill: COLORS.running, pulse: false, glyph: '◐' };
}

export class ClusterMap {
  el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private rt: MissionRuntime | null = null;
  private tiles = new Map<string, Tile>();
  private hubs = new Map<string, Hub>();
  private flights: Flight[] = [];
  private showSystem = false;
  private hover: Tile | null = null;
  private tooltip: HTMLElement;
  private time = 0;
  private reduced: () => boolean;
  private warnings: { text: string; at: number }[] = [];
  private seenEvents = new Set<string>();

  constructor(reduced: () => boolean) {
    this.reduced = reduced;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'map-hint';
    const toggle = document.createElement('div');
    toggle.className = 'map-toggle';
    const sys = document.createElement('button');
    sys.textContent = 'system pods';
    sys.setAttribute('aria-pressed', 'false');
    sys.onclick = () => { this.showSystem = !this.showSystem; sys.setAttribute('aria-pressed', String(this.showSystem)); sys.classList.toggle('primary', this.showSystem); };
    toggle.append(sys);
    this.el = document.createElement('section');
    this.el.className = 'map';
    this.el.setAttribute('aria-label', 'cluster map');
    this.el.append(this.canvas, toggle, this.tooltip);
    this.canvas.addEventListener('mousemove', (e) => this.onMove(e));
    this.canvas.addEventListener('mouseleave', () => { this.hover = null; this.tooltip.textContent = ''; });
  }

  setRuntime(rt: MissionRuntime | null): void {
    this.rt = rt;
    this.tiles.clear();
    this.hubs.clear();
    this.flights = [];
    this.warnings = [];
    this.seenEvents.clear();
  }

  private onMove(e: MouseEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    this.hover = null;
    for (const t of this.tiles.values()) if (x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h) this.hover = t;
    if (this.hover) {
      const p = this.hover.pod;
      const rc = (p.status.containerStatuses ?? []).reduce((n, c) => n + c.restartCount, 0);
      this.tooltip.textContent = `${p.metadata.namespace}/${p.metadata.name} · ${podStatusReason(p)} · ready ${isPodReady(p) ? 'yes' : 'no'} · restarts ${rc} · ${p.status.podIP ?? 'no IP'} · ${p.spec.containers.map((c) => c.image.split('/').pop()).join(', ')}`;
    } else this.tooltip.textContent = '';
  }

  render(dtMs: number): void {
    const dpr = window.devicePixelRatio || 1;
    const W = this.el.clientWidth, H = this.el.clientHeight;
    if (this.canvas.width !== Math.floor(W * dpr) || this.canvas.height !== Math.floor(H * dpr)) {
      this.canvas.width = Math.floor(W * dpr);
      this.canvas.height = Math.floor(H * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    this.time = performance.now();
    void dtMs;
    const rt = this.rt;
    if (!rt) return;
    const engine = rt.engine;
    const nodes = engine.store.list<Node>('Node');
    const pods = engine.store.list<Pod>('Pod').filter((p) => this.showSystem || p.metadata.namespace !== 'kube-system');
    const services = engine.store.list<Service>('Service').filter((s) => s.metadata.namespace !== 'kube-system' && s.metadata.name !== 'kubernetes');

    // ---- layout: services strip on top, nodes below
    const top = 14, stripH = 64;
    const nodeTop = top + stripH + 26;
    const gap = 14;
    const cpWidth = Math.min(150, W * 0.16);
    const workers = nodes.filter((n) => !n.metadata.labels?.['node-role.kubernetes.io/control-plane']);
    const cps = nodes.filter((n) => !!n.metadata.labels?.['node-role.kubernetes.io/control-plane']);
    const workerW = Math.max(120, (W - gap * (workers.length + 1) - (cps.length ? cpWidth + gap : 0)) / Math.max(1, workers.length));
    const nodeH = Math.max(120, H - nodeTop - 46);
    const nodeRects: { node: Node; x: number; y: number; w: number; h: number }[] = [];
    let cx = gap;
    for (const n of cps) { nodeRects.push({ node: n, x: cx, y: nodeTop, w: cpWidth, h: nodeH }); cx += cpWidth + gap; }
    for (const n of workers) { nodeRects.push({ node: n, x: cx, y: nodeTop, w: workerW, h: nodeH }); cx += workerW + gap; }

    // ---- services strip
    const hubGap = 14;
    const hubW = Math.min(170, Math.max(110, (W - hubGap * (services.length + 1) - 120) / Math.max(1, services.length)));
    let hx = 120;
    const liveHubs = new Set<string>();
    for (const s of services) {
      const key = `${s.metadata.namespace}/${s.metadata.name}`;
      liveHubs.add(key);
      let hub = this.hubs.get(key);
      if (!hub) { hub = { key, x: hx, y: top, svc: s, label: s.metadata.name }; this.hubs.set(key, hub); }
      hub.x = hx; hub.y = top; hub.svc = s;
      hx += hubW + hubGap;
    }
    for (const k of [...this.hubs.keys()]) if (!liveHubs.has(k)) this.hubs.delete(k);

    // ---- pods into nodes
    const live = new Set<string>();
    const pending: Pod[] = [];
    for (const r of nodeRects) {
      const onNode = pods.filter((p) => p.spec.nodeName === r.node.metadata.name).sort((a, b) => (`${a.metadata.namespace}/${a.metadata.name}` < `${b.metadata.namespace}/${b.metadata.name}` ? -1 : 1));
      const cols = Math.max(1, Math.floor((r.w - 16) / 96));
      const tileW = (r.w - 16 - (cols - 1) * 6) / cols, tileH = 40;
      onNode.forEach((p, i) => {
        const uid = p.metadata.uid as string;
        live.add(uid);
        const col = i % cols, row = Math.floor(i / cols);
        const x = r.x + 8 + col * (tileW + 6), y = r.y + 44 + row * (tileH + 6);
        let t = this.tiles.get(uid);
        if (!t) { t = { uid, x, y, w: tileW, h: tileH, born: this.time, pod: p }; this.tiles.set(uid, t); }
        t.x += (x - t.x) * 0.25; t.y += (y - t.y) * 0.25; t.w = tileW; t.h = tileH; t.pod = p;
      });
    }
    for (const p of pods) if (!p.spec.nodeName) pending.push(p);
    for (const [uid, t] of this.tiles) {
      if (!live.has(uid) && t.dying === undefined) t.dying = this.time;
      if (t.dying !== undefined && this.time - t.dying > 600) this.tiles.delete(uid);
    }

    // ---- packets → flights
    for (const pk of engine.traffic.drain()) {
      if (this.reduced()) continue;
      const hub = this.hubs.get(pk.service);
      const src = { x: 48, y: top + stripH / 2 };
      if (!hub) continue;
      const hubC = { x: hub.x + hubW / 2, y: hub.y + stripH - 10 };
      if (pk.outcome === 'dropped' || !pk.podUid) { this.flights.push({ from: src, to: { x: hub.x + hubW / 2, y: hub.y + stripH / 2 }, t0: this.time, dur: 380, outcome: 'dropped' }); continue; }
      const tile = this.tiles.get(pk.podUid);
      if (!tile) continue;
      this.flights.push({ from: src, via: hubC, to: { x: tile.x + tile.w / 2, y: tile.y + tile.h / 2 }, t0: this.time, dur: 650, outcome: pk.outcome });
      if (this.flights.length > 240) this.flights.splice(0, this.flights.length - 240);
    }

    // ---- recent warning events (ticker)
    for (const ev of engine.store.list<Event>('Event')) {
      if (ev.type !== 'Warning') continue;
      const key = `${ev.metadata.uid}:${ev.count}`;
      if (this.seenEvents.has(key)) continue;
      this.seenEvents.add(key);
      if (Date.parse(ev.lastTimestamp) < engine.clock.nowMs - 5000) continue;
      this.warnings.push({ text: `${ev.involvedObject.kind.toLowerCase()}/${ev.involvedObject.name}: ${ev.reason} — ${ev.message}`, at: this.time });
      if (this.warnings.length > 4) this.warnings.shift();
    }
    this.warnings = this.warnings.filter((w) => this.time - w.at < 9000);

    // ================= draw =================
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    // traffic source
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = 'center';
    const sources = engine.traffic.list();
    ctx.beginPath(); ctx.arc(48, top + stripH / 2, 18, 0, Math.PI * 2); ctx.fillStyle = '#1a2440'; ctx.fill(); ctx.strokeStyle = COLORS.line; ctx.stroke();
    ctx.fillStyle = COLORS.text; ctx.font = '16px system-ui'; ctx.fillText('🌐', 48, top + stripH / 2 + 1);
    ctx.font = '11px system-ui'; ctx.fillStyle = COLORS.muted; ctx.fillText(sources.length ? `${sources.reduce((n, s) => n + s.rps, 0)} rps` : 'no traffic', 48, top + stripH + 10);

    // hubs
    for (const hub of this.hubs.values()) {
      const s = hub.svc;
      const { ready } = serviceBackends(engine, s);
      const ok = ready.length > 0;
      roundRect(ctx, hub.x, hub.y, hubW, stripH, 10, '#121a2e', ok ? COLORS.hub : COLORS.crash);
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.text; ctx.font = '600 13px system-ui';
      ctx.fillText(s.metadata.name, hub.x + 10, hub.y + 16);
      ctx.fillStyle = COLORS.muted; ctx.font = '11px system-ui';
      ctx.fillText(`${s.metadata.namespace} · ${s.spec.type ?? 'ClusterIP'}`, hub.x + 10, hub.y + 33);
      ctx.fillStyle = ok ? COLORS.ready : COLORS.crash;
      ctx.fillText(`${ready.length} endpoint${ready.length === 1 ? '' : 's'}${(s.spec.ports ?? [])[0] ? ` · :${(s.spec.ports ?? [])[0]!.port}` : ''}`, hub.x + 10, hub.y + 50);
    }

    // nodes
    for (const r of nodeRects) {
      const n = r.node;
      const nrt = engine.nodeRuntime(n.metadata.name);
      const down = !nrt.ready;
      roundRect(ctx, r.x, r.y, r.w, r.h, 12, down ? COLORS.nodeDown : COLORS.node, down ? COLORS.crash : n.spec.unschedulable ? COLORS.amber : COLORS.line);
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.text; ctx.font = '600 13px system-ui';
      ctx.fillText(n.metadata.name.replace('orbital-', ''), r.x + 10, r.y + 16);
      ctx.fillStyle = down ? COLORS.crash : n.spec.unschedulable ? COLORS.amber : COLORS.muted; ctx.font = '11px system-ui';
      const role = n.metadata.labels?.['node-role.kubernetes.io/control-plane'] !== undefined ? 'control-plane' : 'worker';
      ctx.fillText(down ? 'NotReady' : n.spec.unschedulable ? 'SchedulingDisabled' : role, r.x + 10, r.y + 31);
      // capacity bars (requests)
      const used = nodeRequested(engine, n.metadata.name);
      const cpu = parseCpuMillis(n.status.allocatable.cpu ?? '1'), mem = parseMemoryBytes(n.status.allocatable.memory ?? '1');
      bar(ctx, r.x + r.w - 70, r.y + 10, 60, 5, used.cpu / cpu, 'cpu');
      bar(ctx, r.x + r.w - 70, r.y + 24, 60, 5, used.mem / mem, 'mem');
    }

    // tiles
    for (const t of this.tiles.values()) {
      const p = t.pod;
      const { fill, pulse, glyph } = podColor(p);
      const age = this.time - t.born;
      const scale = this.reduced() ? 1 : Math.min(1, age / 250);
      let alpha = 1;
      if (t.dying !== undefined) alpha = Math.max(0, 1 - (this.time - t.dying) / 600);
      else if (pulse && !this.reduced()) alpha = 0.6 + 0.4 * Math.sin(this.time / 180);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(t.x + t.w / 2, t.y + t.h / 2);
      ctx.scale(scale, scale);
      ctx.translate(-(t.x + t.w / 2), -(t.y + t.h / 2));
      roundRect(ctx, t.x, t.y, t.w, t.h, 7, '#0e1528', fill);
      ctx.fillStyle = fill; ctx.fillRect(t.x + 1, t.y + 1, 5, t.h - 2);
      const { title, sub } = shortName(p);
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.text; ctx.font = '600 11.5px system-ui';
      ctx.fillText(ellipsize(ctx, title, t.w - 34), t.x + 11, t.y + 13);
      ctx.fillStyle = COLORS.muted; ctx.font = '10.5px ui-monospace, monospace';
      const reason = podStatusReason(p);
      ctx.fillText(ellipsize(ctx, `${sub ? sub + ' · ' : ''}${reason}`, t.w - 34), t.x + 11, t.y + 28);
      if (glyph) { ctx.textAlign = 'center'; ctx.fillStyle = fill; ctx.font = '600 13px system-ui'; ctx.fillText(glyph, t.x + t.w - 12, t.y + t.h / 2); }
      ctx.restore();
    }

    // pending pods (unscheduled)
    if (pending.length) {
      ctx.textAlign = 'left'; ctx.fillStyle = COLORS.amber; ctx.font = '600 12px system-ui';
      ctx.fillText(`⏳ Pending (unscheduled): ${pending.map((p) => p.metadata.name).join(', ')}`, gap, H - 30);
    }

    // flights
    const now = this.time;
    this.flights = this.flights.filter((f) => now - f.t0 < f.dur + 400);
    for (const f of this.flights) {
      const u = Math.min(1, (now - f.t0) / f.dur);
      let x: number, y: number;
      if (f.via) {
        if (u < 0.4) { const v = u / 0.4; x = f.from.x + (f.via.x - f.from.x) * v; y = f.from.y + (f.via.y - f.from.y) * v; }
        else { const v = (u - 0.4) / 0.6; x = f.via.x + (f.to.x - f.via.x) * v; y = f.via.y + (f.to.y - f.via.y) * v; }
      } else { x = f.from.x + (f.to.x - f.from.x) * u; y = f.from.y + (f.to.y - f.from.y) * u; }
      ctx.beginPath();
      if (u >= 1) {
        if (f.outcome === 'ok') continue;
        const k = (now - f.t0 - f.dur) / 400;
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = COLORS.crash;
        ctx.arc(x, y + k * 14, 4 + k * 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        continue;
      }
      ctx.fillStyle = f.outcome === 'ok' ? COLORS.ready : f.outcome === 'error' ? COLORS.amber : COLORS.crash;
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // warning ticker
    ctx.textAlign = 'left'; ctx.font = '11.5px ui-monospace, monospace';
    this.warnings.forEach((w, i) => {
      const a = Math.min(1, (9000 - (this.time - w.at)) / 1500);
      ctx.globalAlpha = a;
      ctx.fillStyle = COLORS.amber;
      ctx.fillText(ellipsize(ctx, '⚠ ' + w.text, W - 2 * gap), gap, H - 12 - (this.warnings.length - 1 - i) * 15 - (pending.length ? 18 : 0));
    });
    ctx.globalAlpha = 1;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string, stroke: string): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke();
}

function bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, frac: number, label: string): void {
  ctx.fillStyle = '#2a3658'; ctx.fillRect(x, y, w, h);
  const f = Math.max(0, Math.min(1, frac));
  ctx.fillStyle = f > 0.9 ? COLORS.crash : f > 0.7 ? COLORS.amber : COLORS.hub;
  ctx.fillRect(x, y, w * f, h);
  ctx.fillStyle = COLORS.muted; ctx.font = '9px system-ui'; ctx.textAlign = 'right';
  ctx.fillText(label, x - 4, y + h / 2);
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}
