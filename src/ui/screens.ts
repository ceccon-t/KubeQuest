/** Campaign screen, briefing, debrief, settings, toasts. */
import type { Mission } from '../game/mission.ts';
import type { ScoreBreakdown } from '../game/scoring.ts';
import type { Progress } from '../game/progress.ts';
import { CHAPTERS, isUnlocked } from '../missions/index.ts';
import { SANDBOX } from '../missions/sandbox.ts';
import { h, mdLite, stars, fmtTime, clear } from './dom.ts';

export function toast(text: string, kind: 'ok' | 'warn' | '' = ''): void {
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

export function campaignScreen(progress: Progress, opts: { onPlay: (m: Mission) => void; onSettings: () => void }): HTMLElement {
  const starsOf: Record<string, number> = {};
  for (const [id, r] of Object.entries(progress.data.missions)) starsOf[id] = r.stars;
  const total = Object.values(starsOf).reduce((n, s) => n + s, 0);
  const unlockAll = progress.data.settings.unlockAll;
  const el = h('div', { class: 'campaign' },
    h('header', null, h('h1', null, 'KUBEQUEST'), h('span', { class: 'muted' }, 'On-call at Orbital Logistics · real kubectl, simulated cluster'), h('div', { style: { flex: '1' } }), h('span', { class: 'muted' }, `★ ${total}`), h('button', { onclick: opts.onSettings }, '⚙ Settings')),
  );
  for (const ch of CHAPTERS) {
    const grid = h('div', { class: 'missions' });
    for (const m of ch.missions) {
      const rec = progress.data.missions[m.id];
      const unlocked = isUnlocked(m.id, starsOf, unlockAll);
      const card = h('div', { class: `mcard${unlocked ? '' : ' locked'}`, role: 'button', tabindex: unlocked ? '0' : '-1', 'aria-disabled': String(!unlocked), onclick: () => { if (unlocked) opts.onPlay(m); }, onkeydown: (e: KeyboardEvent) => { if (unlocked && (e.key === 'Enter' || e.key === ' ')) opts.onPlay(m); } },
        h('div', { class: 'id' }, `${m.id} · ${m.ticket.priority}${m.tutorial ? ' · tutorial' : ''}${!unlocked ? ' · 🔒' : ''}`),
        h('h3', null, m.title),
        h('div', { class: 'tag' }, m.tagline),
        h('div', { class: 'foot' }, stars(rec?.stars ?? 0), h('span', { class: 'muted' }, rec?.bestScore ? `best ${rec.bestScore}` : unlocked ? 'not played' : 'finish the previous ticket')),
      );
      grid.append(card);
    }
    el.append(h('section', { class: 'chapter' }, h('h2', null, `Chapter ${ch.number} · `, h('span', null, ch.title), ` — ${ch.subtitle}`), grid));
  }
  const sb = h('div', { class: 'mcard', role: 'button', tabindex: '0', onclick: () => opts.onPlay(SANDBOX) }, h('div', { class: 'id' }, 'free play'), h('h3', null, 'Sandbox'), h('div', { class: 'tag' }, SANDBOX.tagline), h('div', { class: 'foot' }, h('span', { class: 'muted' }, 'no scoring')));
  el.append(h('section', { class: 'chapter' }, h('h2', null, h('span', null, 'Sandbox')), h('div', { class: 'missions' }, sb)));
  el.append(h('p', { class: 'muted', style: { fontSize: '12px' } }, 'Chapters 5–8 of the curriculum (configuration, storage, security, production operations, platform) are planned for later releases.'));
  return el;
}

export function briefingModal(m: Mission, onStart: () => void): HTMLElement {
  const back = h('div', { class: 'modal-back' });
  const start = () => { back.remove(); onStart(); };
  const lesson = m.lesson?.length ? h('section', { class: 'lesson' }, h('h3', null, 'Field notes', h('span', { class: 'muted' }, ' — read before you take the ticket')), ...m.lesson.map((p) => mdLite(p))) : null;
  const concepts = m.concepts.length ? h('div', null, h('h3', { style: { marginTop: '14px' } }, 'Concept cards', h('span', { class: 'muted' }, ' — reference, also in the Concepts tab')), ...m.concepts.map((c) => h('details', { class: 'card' }, h('summary', { style: { cursor: 'pointer', fontWeight: '600' } }, c.title), mdLite(c.body), c.example ? h('pre', null, c.example) : null))) : null;
  back.append(h('div', { class: 'modal', role: 'dialog', 'aria-label': `briefing ${m.title}` },
    h('div', { class: 'muted', style: { fontSize: '12px' } }, `Ticket ${m.id} · from ${m.ticket.from}`),
    h('h2', null, h('span', { class: `chip ${m.ticket.priority}` }, m.ticket.priority), ' ', m.ticket.subject),
    h('div', { class: 'ticket' }, ...m.ticket.body.map((p) => mdLite(p))),
    lesson,
    concepts,
    h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '10px' } }, m.sandbox ? 'Nothing is scored in the sandbox.' : `Par: ${fmtTime(m.par.timeSec)} and ${m.par.commands} commands${m.timeLimitSec ? ` · SLA ${fmtTime(m.timeLimitSec)}` : ''}${m.slo ? ` · SLO ≥ ${(m.slo.minAvailability * 100).toFixed(1)}%` : ''}. Hints cost score. The clock starts when you take the ticket.`),
    h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: start, autofocus: true }, m.sandbox ? 'Enter sandbox' : 'Take the ticket')),
  ));
  back.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
  return back;
}

export function debriefModal(m: Mission, score: ScoreBreakdown, elapsedSec: number, commands: string[], opts: { onReplay: () => void; onNext: (() => void) | null; onCampaign: () => void }): HTMLElement {
  const back = h('div', { class: 'modal-back' });
  const row = (label: string, v: number) => h('tr', null, h('td', null, label), h('td', null, (v >= 0 ? '+' : '') + v));
  back.append(h('div', { class: 'modal', role: 'dialog', 'aria-label': 'debrief' },
    h('div', { class: 'muted', style: { fontSize: '12px' } }, `Ticket ${m.id} resolved in ${fmtTime(elapsedSec)} with ${commands.length} commands`),
    h('h2', null, m.title),
    stars(score.stars),
    h('table', { class: 'score' }, h('tbody', null, row('Objectives', score.objectives), row('Time', score.time), row('Efficiency', score.efficiency), m.cluster.traffic?.length ? row('Availability (SLO)', score.slo) : null, score.bonus ? row('Optional objectives', score.bonus) : null, score.hints ? row('Hints', score.hints) : null, h('tr', { class: 'total' }, h('td', null, 'Total'), h('td', null, String(score.total))))),
    h('ul', { class: 'muted', style: { fontSize: '13px' } }, ...score.notes.map((n) => h('li', null, n))),
    h('h3', null, 'Pro tips'),
    h('ul', null, ...m.debrief.proTips.map((t) => h('li', null, mdLite(t)))),
    h('details', null, h('summary', { style: { cursor: 'pointer' } }, 'Commands you ran'), h('pre', { style: { fontSize: '12px', maxHeight: '200px', overflow: 'auto' } }, commands.join('\n'))),
    h('div', { class: 'actions' }, h('button', { onclick: () => { back.remove(); opts.onCampaign(); } }, 'Campaign'), h('button', { onclick: () => { back.remove(); opts.onReplay(); } }, 'Replay'), opts.onNext ? h('button', { class: 'primary', onclick: () => { back.remove(); opts.onNext?.(); } }, 'Next ticket →') : null),
  ));
  return back;
}

export function settingsModal(progress: Progress, onChange: () => void): HTMLElement {
  const back = h('div', { class: 'modal-back' });
  const s = progress.data.settings;
  const check = (key: 'reducedMotion' | 'unlockAll', label: string) => {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = s[key];
    cb.onchange = () => { s[key] = cb.checked; void progress.save(); onChange(); };
    return [h('label', null, label), cb];
  };
  const font = h('select', null, ...(['small', 'normal', 'large'] as const).map((f) => h('option', { value: f, selected: s.fontSize === f ? true : undefined }, f)));
  font.onchange = () => { s.fontSize = font.value as typeof s.fontSize; void progress.save(); onChange(); };
  const exportBtn = h('button', { onclick: () => { const blob = new Blob([progress.export()], { type: 'application/json' }); const a = h('a', { href: URL.createObjectURL(blob), download: 'kubequest-progress.json' }); a.click(); } }, 'Export progress');
  const importInput = h('input', { type: 'file', accept: 'application/json', style: { display: 'none' } });
  importInput.onchange = async () => { const f = importInput.files?.[0]; if (!f) return; try { progress.import(await f.text()); await progress.save(); onChange(); toast('Progress imported', 'ok'); } catch (e) { toast(`Import failed: ${(e as Error).message}`, 'warn'); } };
  const importBtn = h('button', { onclick: () => importInput.click() }, 'Import progress');
  const resetBtn = h('button', { onclick: () => { if (confirm('Reset all progress? This cannot be undone.')) { progress.data.missions = {}; void progress.save(); onChange(); back.remove(); } } }, 'Reset progress');
  back.append(h('div', { class: 'modal', role: 'dialog', 'aria-label': 'settings' },
    h('h2', null, 'Settings'),
    h('div', { class: 'settings-grid' }, ...check('reducedMotion', 'Reduced motion (no packets / pulses)'), h('label', null, 'Terminal font size'), font, ...check('unlockAll', 'Unlock all missions')),
    h('h3', { style: { marginTop: '18px' } }, 'Data'),
    h('p', { class: 'muted', style: { fontSize: '13px' } }, 'Progress is stored inside the game folder (desktop) or this browser (web). Nothing leaves your machine.'),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, exportBtn, importBtn, importInput, resetBtn),
    h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => back.remove() }, 'Close')),
  ));
  return back;
}

export { clear };
