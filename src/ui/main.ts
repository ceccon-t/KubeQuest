/** App entry: screens, mission loop, wiring between engine/game and UI. */
import { MissionRuntime, type RuntimeEvent } from '../game/runtime.ts';
import { Progress } from '../game/progress.ts';
import { detectStorage } from '../game/storage.ts';
import { resolveVersion, BUILD_VERSION } from '../game/version.ts';
import type { Mission } from '../game/mission.ts';
import { MISSIONS } from '../missions/index.ts';
import { SANDBOX } from '../missions/sandbox.ts';
import { Terminal } from './terminal.ts';
import { openEditor } from './editor.ts';
import { ClusterMap } from './map.ts';
import { TopBar, SidePanel } from './panels.ts';
import { campaignScreen, briefingModal, debriefModal, settingsModal, toast } from './screens.ts';
import { h, clear } from './dom.ts';

const TICK_MS = 100;

class App {
  root: HTMLElement;
  progress = new Progress(detectStorage());
  rt: MissionRuntime | null = null;
  version = BUILD_VERSION;
  terminal: Terminal;
  map: ClusterMap;
  top: TopBar;
  side: SidePanel;
  private acc = 0;
  private last = 0;
  private raf = 0;
  private uiTick = 0;
  private pauseBanner: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.terminal = new Terminal({ openEditor, hintFor: (line, stderr) => this.nudge(line, stderr), onCommandDone: () => { this.progress.data.stats.commands++; this.rt?.evaluate(); this.side.renderObjectives(); } });
    this.map = new ClusterMap(() => this.progress.data.settings.reducedMotion);
    this.top = new TopBar({ onMenu: () => this.confirmLeave(), onHint: () => this.hint(), onSettings: () => this.openSettings(), onPause: () => this.togglePause(), onRestart: () => this.restart() });
    this.pauseBanner = h('div', { class: 'paused-banner', role: 'status', style: { display: 'none' } }, h('div', null, '⏸ PAUSED'), h('div', { class: 'muted' }, 'Simulation, traffic and timer are frozen.'));
    this.map.el.append(this.pauseBanner);
    this.side = new SidePanel();
  }

  async start(): Promise<void> {
    [this.version] = await Promise.all([resolveVersion(), this.progress.load()]);
    this.top.setVersion(this.version);
    this.applySettings();
    // Dev/demo deep link: ?mission=3.2&script=kubectl get pods;kubectl get nodes  (skips the briefing)
    const params = new URLSearchParams(location.search);
    const mid = params.get('mission');
    const m = mid ? (mid === 'sandbox' ? SANDBOX : MISSIONS.find((x) => x.id === mid)) : undefined;
    if (m) {
      this.play(m, { skipBriefing: params.get('briefing') !== '1' });
      const tab = params.get('tab');
      if (tab) this.side.show(tab);
      const script = params.get('script');
      if (script) for (const line of script.split(';')) if (line.trim()) await this.terminal.run(line.trim());
      if (params.get('paused') === '1') this.togglePause();
      return;
    }
    this.showCampaign();
  }

  applySettings(): void {
    document.documentElement.dataset.font = this.progress.data.settings.fontSize;
  }

  openSettings(): void {
    document.body.append(settingsModal(this.progress, () => { this.applySettings(); if (!this.rt) this.showCampaign(); }));
  }

  showCampaign(): void {
    this.stopLoop();
    this.rt = null;
    this.map.setRuntime(null);
    clear(this.root);
    this.root.append(campaignScreen(this.progress, { version: this.version, onPlay: (m) => this.play(m), onSettings: () => this.openSettings() }));
  }

  togglePause(): void {
    const rt = this.rt;
    if (!rt || !rt.started || rt.completed) return;
    rt.paused = !rt.paused;
    this.top.setPaused(rt.paused);
    this.terminal.setPaused(rt.paused);
    this.pauseBanner.style.display = rt.paused ? '' : 'none';
  }

  restart(): void {
    const rt = this.rt;
    if (!rt) return;
    const idle = rt.shell.history.length === 0 && rt.elapsedMs < 1000;
    if (!idle && !rt.completed && !confirm('Restart this ticket from scratch? Current progress on it is lost.')) return;
    this.play(rt.mission, { skipBriefing: true });
    toast('Ticket restarted from its initial state.', 'ok');
  }

  confirmLeave(): void {
    if (!this.rt || this.rt.completed || this.rt.mission.sandbox || confirm('Leave this ticket? Progress on it is lost.')) this.showCampaign();
  }

  play(m: Mission, opts: { skipBriefing?: boolean } = {}): void {
    this.stopLoop();
    const rt = new MissionRuntime(m, this.terminal.host);
    this.rt = rt;
    this.progress.attempt(m.id);
    void this.progress.save();
    clear(this.root);
    const game = h('div', { class: 'game' }, this.top.el, this.map.el, this.side.el, this.terminal.el);
    this.root.append(game);
    this.terminal.setPaused(false);
    this.top.setPaused(false);
    this.pauseBanner.style.display = 'none';
    this.terminal.attach(rt.shell);
    this.terminal.clear();
    this.terminal.print(`Connected to ${rt.engine.clusterName} (Kubernetes ${rt.engine.version}). Context "kubequest", namespace "${rt.engine.currentNamespace}".\nType kubectl commands. Tab completes, ↑ recalls history, "help" lists workstation commands.\n\n`, 'bg');
    this.top.setMission(m);
    this.side.setMission(rt);
    this.map.setRuntime(rt);
    rt.on((e) => this.onRuntimeEvent(e));
    if (opts.skipBriefing) { rt.start(); this.terminal.focus(); }
    else document.body.append(briefingModal(m, () => { rt.start(); this.terminal.focus(); toast(m.sandbox ? 'Sandbox ready.' : 'Ticket taken — the clock is running.', 'ok'); }));
    this.startLoop();
  }

  private onRuntimeEvent(e: RuntimeEvent): void {
    const rt = this.rt;
    if (!rt) return;
    switch (e.type) {
      case 'objective':
        toast(e.insight ? `✓ ${e.text} — new insight` : `✓ ${e.text}`, 'ok');
        this.side.renderObjectives();
        if (e.insight) this.side.insight(e.text, e.insight);
        break;
      case 'objective-reverted': this.side.renderObjectives(); break;
      case 'chaos': this.side.pager(e.from, e.text, 'alert'); this.side.show('pager'); toast(`📟 ${e.from}: ${e.text}`, 'warn'); this.side.renderObjectives(); break;
      case 'hint': this.side.pager(`Hint ${e.index}`, e.text, 'hint'); this.side.show('pager'); break;
      case 'sla-breached': toast('⏰ SLA breached — stars capped at 1. Keep going!', 'warn'); break;
      case 'complete': this.onComplete(e.score, e.elapsedSec); break;
    }
  }

  private onComplete(score: import('../game/scoring.ts').ScoreBreakdown, elapsedSec: number): void {
    const rt = this.rt as MissionRuntime;
    const m = rt.mission;
    this.progress.record(m.id, score.total, score.stars, elapsedSec);
    this.progress.data.stats.hintsUsed += rt.hintsUsed;
    void this.progress.save();
    const idx = MISSIONS.findIndex((x) => x.id === m.id);
    const next = idx >= 0 ? MISSIONS[idx + 1] : undefined;
    setTimeout(() => {
      document.body.append(debriefModal(m, score, elapsedSec, rt.shell.history.map((x) => x.line), { onReplay: () => this.play(m), onNext: next ? () => this.play(next) : null, onCampaign: () => this.showCampaign() }));
    }, 600);
  }

  private hint(): void {
    const rt = this.rt;
    if (!rt) return;
    const text = rt.hint();
    if (!text) toast('No more hints for this ticket.', 'warn');
  }

  /** Gentle nudge below a faithful kubectl error (PRD §5.4), only for common beginner mistakes. */
  private nudge(line: string, stderr: string): string | undefined {
    if (!stderr) return undefined;
    if (/the server doesn't have a resource type/.test(stderr)) return 'resource types are plural or short names: pods/po, deployments/deploy, services/svc, replicasets/rs. `kubectl api-resources` lists them.';
    if (/No resources found in (\S+) namespace/.test(stderr) && !/-n|--namespace|-A/.test(line)) return 'nothing here in the current namespace — try `-A` for all namespaces or `-n <namespace>`.';
    if (/unknown flag: --(\S+)/.test(stderr)) return 'check `kubectl <command> --help`; flags go after the command and names.';
    if (/is not supported anymore\. Use exec \[POD\] -- \[COMMAND\]/.test(stderr)) return 'put `--` between the pod name and the command: `kubectl exec POD -- CMD`.';
    if (/error parsing .*yaml: line (\d+)/.test(stderr)) return 'YAML indentation uses spaces, and list items under a key need consistent indentation. Open the file again and check that line.';
    if (/unknown field "(\S+)"/.test(stderr)) return 'that field name is not in the schema (typo?). `kubectl explain <kind>.<path>` shows valid fields.';
    if (/`selector` does not match template `labels`/.test(stderr)) return 'spec.selector.matchLabels must be a subset of spec.template.metadata.labels.';
    if (/previous terminated container .* not found/.test(stderr)) return 'there is no earlier run yet; drop --previous, or wait for the container to restart.';
    if (/command not found/.test(stderr) && /^(kubectl|k)[a-z]/.test(line)) return 'put a space after kubectl.';
    return undefined;
  }

  private startLoop(): void {
    this.last = performance.now();
    this.acc = 0;
    const frame = (now: number) => {
      this.raf = requestAnimationFrame(frame);
      const rt = this.rt;
      if (!rt) return;
      const dt = Math.min(500, now - this.last);
      this.last = now;
      this.acc += dt;
      let steps = 0;
      while (this.acc >= TICK_MS && steps < 5) { rt.tick(TICK_MS); this.acc -= TICK_MS; steps++; }
      if (steps === 5) this.acc = 0; // tab was hidden: do not spiral
      this.map.render(dt);
      if (++this.uiTick % 15 === 0) { this.top.update(rt); }
      if (this.uiTick % 30 === 0) this.side.renderObjectivesIfChanged();
    };
    this.raf = requestAnimationFrame(frame);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}

const root = document.getElementById('app');
if (root) void new App(root).start();
