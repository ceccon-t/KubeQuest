/** Top bar (timer, SLO, score) and the side panel (Objectives / Ticket / Concepts / Pager). */
import type { MissionRuntime } from '../game/runtime.ts';
import type { Mission } from '../game/mission.ts';
import { h, clear, mdLite, fmtTime } from './dom.ts';
import { brand } from './screens.ts';

export class TopBar {
  el: HTMLElement;
  private title: HTMLElement;
  private brandEl: HTMLElement;
  private timer: HTMLElement;
  private sloVal: HTMLElement;
  private sloBar: HTMLElement;
  private cmds: HTMLElement;
  private hintBtn: HTMLButtonElement;
  private pauseBtn: HTMLButtonElement;
  constructor(opts: { onMenu: () => void; onHint: () => void; onSettings: () => void; onPause: () => void; onRestart: () => void }) {
    this.title = h('div', { class: 'title' });
    this.timer = h('div', { class: 'value' }, '0:00');
    this.sloVal = h('div', { class: 'value good' }, '100%');
    this.sloBar = h('div');
    this.cmds = h('div', { class: 'value' }, '0');
    this.hintBtn = h('button', { onclick: opts.onHint, title: 'Reveal the next hint (costs score)' }, '💡 Hint');
    this.pauseBtn = h('button', { onclick: opts.onPause, title: 'Pause / resume the whole simulation', 'aria-pressed': 'false' }, '⏸ Pause');
    const restartBtn = h('button', { onclick: opts.onRestart, title: 'Restart this ticket from its initial state' }, '↺ Restart');
    this.brandEl = brand(h('div', { class: 'logo' }, 'KUBEQUEST'), '');
    this.el = h('header', { class: 'topbar' },
      this.brandEl,
      this.title,
      h('div', { class: 'spacer' }),
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Elapsed'), this.timer),
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Commands'), this.cmds),
      h('div', { class: 'stat slo' }, h('div', { class: 'label' }, 'SLO (last 60s)'), this.sloVal, h('div', { class: 'bar' }, this.sloBar)),
      this.hintBtn,
      this.pauseBtn,
      restartBtn,
      h('button', { class: 'ghost', onclick: opts.onSettings, title: 'Settings' }, '⚙'),
      h('button', { class: 'ghost', onclick: opts.onMenu }, 'Campaign'),
    );
  }
  setVersion(version: string): void {
    const v = this.brandEl.querySelector('.version');
    if (v) v.textContent = version ? `v${version}` : '';
  }
  setMission(m: Mission): void {
    clear(this.title);
    this.title.append(h('span', { class: `chip ${m.ticket.priority}` }, m.ticket.priority), ' ', `${m.id} ${m.title}`);
    this.hintBtn.style.display = m.hints.length ? '' : 'none';
  }
  setPaused(paused: boolean): void {
    this.pauseBtn.textContent = paused ? '▶ Resume' : '⏸ Pause';
    this.pauseBtn.classList.toggle('primary', paused);
    this.pauseBtn.setAttribute('aria-pressed', String(paused));
  }

  update(rt: MissionRuntime): void {
    const el = rt.elapsedMs / 1000;
    this.timer.textContent = fmtTime(el);
    this.timer.className = 'value' + (rt.mission.timeLimitSec ? (el > rt.mission.timeLimitSec ? ' bad' : el > rt.mission.timeLimitSec * 0.8 ? ' warn' : '') : '');
    if (rt.mission.timeLimitSec) this.timer.title = `SLA: ${fmtTime(rt.mission.timeLimitSec)}`;
    this.cmds.textContent = String(rt.shell.history.length);
    const hasTraffic = (rt.mission.cluster.traffic ?? []).length > 0;
    const s = rt.engine.traffic.stats();
    const pct = s.availability * 100;
    this.sloVal.textContent = hasTraffic ? `${pct.toFixed(1)}%` : '—';
    this.sloVal.className = 'value ' + (!hasTraffic ? '' : pct >= 99 ? 'good' : pct >= 90 ? 'warn' : 'bad');
    this.sloBar.style.width = `${hasTraffic ? pct : 0}%`;
    this.sloBar.style.background = pct >= 99 ? 'var(--green)' : pct >= 90 ? 'var(--amber)' : 'var(--red)';
    this.hintBtn.textContent = `💡 Hint (${rt.mission.hints.length - rt.hintsUsed} left)`;
    this.hintBtn.disabled = rt.hintsUsed >= rt.mission.hints.length;
  }
}

export type PagerKind = 'alert' | 'hint' | 'ok';

export class SidePanel {
  el: HTMLElement;
  private tabs: Record<string, HTMLButtonElement> = {};
  private panels: Record<string, HTMLElement> = {};
  private active = 'objectives';
  private unread = 0;
  private pagerBadge: HTMLElement;
  private insightBadge: HTMLElement;
  private insightUnread = 0;
  private insightCount = 0;
  private rt: MissionRuntime | null = null;

  constructor() {
    this.pagerBadge = h('span', { class: 'badge', style: { display: 'none' } }, '0');
    this.insightBadge = h('span', { class: 'badge', style: { display: 'none' } }, '0');
    const tabBar = h('div', { class: 'tabs', role: 'tablist' });
    for (const [key, label] of [['objectives', 'Objectives'], ['insights', 'Insights'], ['ticket', 'Ticket'], ['concepts', 'Concepts'], ['pager', 'Pager']] as const) {
      const b = h('button', { role: 'tab', onclick: () => this.show(key) }, label, key === 'pager' ? this.pagerBadge : key === 'insights' ? this.insightBadge : null);
      this.tabs[key] = b;
      this.panels[key] = h('div', { class: 'tabpanel', role: 'tabpanel' });
      tabBar.append(b);
    }
    this.el = h('aside', { class: 'side' }, tabBar, ...Object.values(this.panels));
    this.show('objectives');
  }

  show(key: string): void {
    this.active = key;
    for (const [k, b] of Object.entries(this.tabs)) { b.classList.toggle('active', k === key); (this.panels[k] as HTMLElement).style.display = k === key ? '' : 'none'; }
    if (key === 'pager') { this.unread = 0; this.pagerBadge.style.display = 'none'; }
    if (key === 'insights') { this.insightUnread = 0; this.insightBadge.style.display = 'none'; }
  }

  setMission(rt: MissionRuntime): void {
    this.rt = rt;
    const m = rt.mission;
    const ticket = this.panels.ticket as HTMLElement;
    clear(ticket);
    ticket.append(h('div', { class: 'ticket' }, h('div', { class: 'from' }, `From: ${m.ticket.from}`), h('h3', null, h('span', { class: `chip ${m.ticket.priority}` }, m.ticket.priority), ' ', m.ticket.subject), ...m.ticket.body.map((p) => mdLite(p))));
    const concepts = this.panels.concepts as HTMLElement;
    clear(concepts);
    if (m.lesson?.length) concepts.append(h('details', { class: 'card lesson', open: true }, h('summary', { style: { cursor: 'pointer', fontWeight: '600' } }, 'Field notes'), ...m.lesson.map((p) => mdLite(p))));
    if (!m.concepts.length && !m.lesson?.length) concepts.append(h('p', { class: 'muted' }, 'No concept cards for this mission.'));
    for (const c of m.concepts) concepts.append(h('div', { class: 'card' }, h('h3', null, c.title), mdLite(c.body), c.example ? h('pre', null, c.example) : null));
    clear(this.panels.pager as HTMLElement);
    this.unread = 0;
    this.pagerBadge.style.display = 'none';
    const ins = this.panels.insights as HTMLElement;
    clear(ins);
    this.insightUnread = 0;
    this.insightCount = 0;
    this.insightBadge.style.display = 'none';
    ins.append(h('p', { class: 'muted insights-empty' }, m.sandbox ? 'No insights in the sandbox.' : 'A senior engineer is pairing with you. As you complete objectives, their observations appear here — what they noticed, and where they would look next.'));
    this.renderObjectives();
    this.show('objectives');
  }

  private lastKey = '';
  renderObjectivesIfChanged(): void {
    const rt = this.rt;
    if (!rt) return;
    const key = rt.objectives().map((o) => `${o.id}:${o.done ? 1 : 0}:${o.visible ? 1 : 0}`).join('|');
    if (key === this.lastKey) return;
    this.renderObjectives();
  }

  renderObjectives(): void {
    const rt = this.rt;
    const el = this.panels.objectives as HTMLElement;
    clear(el);
    if (!rt) return;
    this.lastKey = rt.objectives().map((o) => `${o.id}:${o.done ? 1 : 0}:${o.visible ? 1 : 0}`).join('|');
    if (rt.mission.sandbox) { el.append(h('p', { class: 'muted' }, 'Sandbox: no objectives. Use the Ticket tab for ideas and `kubectl help` for the command list.')); return; }
    for (const o of rt.objectives()) {
      if (!o.visible) continue;
      el.append(h('div', { class: `objective${o.done ? ' done' : ''}${o.optional ? ' optional' : ''}` }, h('div', { class: 'box' }, o.done ? '✓' : ''), h('div', null, o.text, o.optional ? h('span', { class: 'opt' }, 'optional') : null)));
    }
    if (rt.mission.slo) el.append(h('p', { class: 'muted', style: { fontSize: '12px', marginTop: '10px' } }, `SLO for 3 stars: availability ≥ ${(rt.mission.slo.minAvailability * 100).toFixed(1)}% over the whole mission.`));
    if (rt.mission.timeLimitSec) el.append(h('p', { class: 'muted', style: { fontSize: '12px' } }, `SLA: finish within ${fmtTime(rt.mission.timeLimitSec)} or stars are capped at 1.`));
  }

  /** Add a senior-engineer insight unlocked by a completed objective. */
  insight(objectiveText: string, text: string): void {
    const el = this.panels.insights as HTMLElement;
    el.querySelector('.insights-empty')?.remove();
    this.insightCount++;
    el.append(h('div', { class: 'insight' }, h('div', { class: 'from' }, `#${this.insightCount} · after: ${objectiveText}`), mdLite(text)));
    el.scrollTop = el.scrollHeight;
    if (this.active !== 'insights') { this.insightUnread++; this.insightBadge.textContent = String(this.insightUnread); this.insightBadge.style.display = ''; }
  }

  pager(from: string, text: string, kind: PagerKind = 'alert'): void {
    const p = this.panels.pager as HTMLElement;
    p.prepend(h('div', { class: `pager ${kind}` }, h('div', { class: 'from' }, from), mdLite(text)));
    if (this.active !== 'pager') { this.unread++; this.pagerBadge.textContent = String(this.unread); this.pagerBadge.style.display = ''; }
  }
}
