/** Terminal component: prompt, scrollback, history, Tab completion, streaming output, Ctrl+C, interactive sessions. */
import type { OutputChunk, ShellHost } from '../engine/kubectl/context.ts';
import type { Shell } from '../engine/shell.ts';
import { h } from './dom.ts';

export interface TerminalOptions {
  openEditor: (initial: string, filename: string) => Promise<string | null>;
  onCommandDone?: (line: string, code: number) => void;
  hintFor?: (line: string, stderr: string) => string | undefined;
}

export class Terminal {
  el: HTMLElement;
  host: ShellHost;
  private out: HTMLElement;
  private input: HTMLInputElement;
  private promptEl: HTMLElement;
  private line: HTMLElement;
  private shell: Shell | null = null;
  private histIdx = -1;
  private draft = '';
  private busy = false;
  private abortFlag = false;
  private interactiveResolve: ((s: string | null) => void) | null = null;
  private opts: TerminalOptions;
  private lastTab = '';
  private paused = false;

  constructor(opts: TerminalOptions) {
    this.opts = opts;
    this.out = h('div', { class: 'term-out', role: 'log' });
    this.promptEl = h('span', { class: 'prompt' }, this.prompt());
    this.input = h('input', { class: 'term-in', type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'terminal input' });
    this.line = h('div', { class: 'term-line' }, this.promptEl, this.input);
    const resizer = h('div', { class: 'resizer' });
    this.el = h('section', { class: 'terminal' }, resizer, this.out, this.line);
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('mouseup', () => { if (!window.getSelection()?.toString()) this.input.focus(); });
    this.setupResize(resizer);
    this.host = {
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      backgroundSleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      editor: (initial, filename) => this.opts.openEditor(initial, filename),
      readLine: (prompt) => this.readLine(prompt),
      aborted: () => this.abortFlag,
    };
  }

  attach(shell: Shell): void {
    this.shell = shell;
    shell.onBackgroundOutput = (c) => this.print(c.text, c.stream === 'stderr' ? 'err bg' : 'bg');
    this.histIdx = -1;
    this.promptEl.textContent = this.prompt();
  }

  private prompt(): string {
    const cwd = this.shell ? this.shell.vfs.display(this.shell.vfs.cwd) : '~';
    return `oncall@orbital:${cwd === '' ? '~' : cwd === this.shell?.vfs.cwd ? '~' : cwd}$ `;
  }

  focus(): void {
    this.input.focus();
  }

  /** While paused the simulation is frozen; typing is blocked so no command can mutate a frozen cluster. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.input.disabled = paused;
    this.line.classList.toggle('busy', paused || this.busy);
    this.promptEl.textContent = paused ? '⏸ paused — press Resume to continue ' : this.busy ? '' : this.prompt();
    if (!paused) this.focus();
  }

  clear(): void {
    this.out.textContent = '';
  }

  print(text: string, cls?: string): void {
    if (text.includes('\x1bc')) { this.clear(); text = text.split('\x1bc').pop() ?? ''; }
    if (!text) return;
    const span = h('span', { class: cls ?? '' }, text);
    this.out.append(span);
    this.trim();
    this.out.scrollTop = this.out.scrollHeight;
  }

  private trim(): void {
    while (this.out.childNodes.length > 2500) this.out.removeChild(this.out.firstChild as Node);
  }

  private setBusy(b: boolean): void {
    this.busy = b;
    this.line.classList.toggle('busy', b);
    this.promptEl.textContent = b ? '' : this.prompt();
  }

  private readLine(prompt: string): Promise<string | null> {
    this.promptEl.textContent = prompt;
    this.input.value = '';
    return new Promise((resolve) => { this.interactiveResolve = resolve; });
  }

  /** Submit a line as if typed (used by hints' "run this" buttons). */
  async run(line: string): Promise<void> {
    if (this.busy || !this.shell) return;
    this.input.value = '';
    this.print(`${this.prompt()}${line}\n`, 'cmd');
    this.setBusy(true);
    this.abortFlag = false;
    let stderr = '';
    try {
      const gen = this.shell.exec(line);
      let r = await gen.next();
      while (!r.done) {
        const c: OutputChunk = r.value;
        if (c.stream === 'stderr') stderr += c.text;
        this.print(c.text, c.stream === 'stderr' ? 'err' : undefined);
        r = await gen.next();
      }
      const hint = this.opts.hintFor?.(line, stderr);
      if (hint) this.print(`hint: ${hint}\n`, 'hintline');
      this.opts.onCommandDone?.(line, r.value);
    } catch (e) {
      this.print(`${(e as Error).message}\n`, 'err');
    } finally {
      this.setBusy(false);
      this.interactiveResolve = null;
      this.focus();
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (this.paused) { e.preventDefault(); return; }
    if (e.ctrlKey && e.key === 'c') {
      e.preventDefault();
      if (this.busy) { this.abortFlag = true; this.print('^C\n'); if (this.interactiveResolve) { const r = this.interactiveResolve; this.interactiveResolve = null; r(null); } }
      else { this.print(`${this.prompt()}${this.input.value}^C\n`, 'cmd'); this.input.value = ''; }
      return;
    }
    if (e.ctrlKey && e.key === 'd' && this.interactiveResolve) { e.preventDefault(); const r = this.interactiveResolve; this.interactiveResolve = null; r(null); return; }
    if (e.ctrlKey && e.key === 'l') { e.preventDefault(); this.clear(); return; }
    if (e.ctrlKey && e.key === 'u') { e.preventDefault(); this.input.value = ''; return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const line = this.input.value;
      if (this.interactiveResolve) {
        this.print(`${this.promptEl.textContent}${line}\n`);
        this.input.value = '';
        const r = this.interactiveResolve;
        this.interactiveResolve = null;
        r(line);
        return;
      }
      if (this.busy) return;
      this.histIdx = -1;
      if (!line.trim()) { this.print(`${this.prompt()}\n`, 'cmd'); return; }
      void this.run(line);
      return;
    }
    if (this.busy && !this.interactiveResolve) return;
    const hist = this.shell?.history ?? [];
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hist.length) return;
      if (this.histIdx === -1) { this.draft = this.input.value; this.histIdx = hist.length; }
      this.histIdx = Math.max(0, this.histIdx - 1);
      this.input.value = hist[this.histIdx]?.line ?? '';
      requestAnimationFrame(() => this.input.setSelectionRange(this.input.value.length, this.input.value.length));
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.histIdx === -1) return;
      this.histIdx++;
      if (this.histIdx >= hist.length) { this.histIdx = -1; this.input.value = this.draft; }
      else this.input.value = hist[this.histIdx]?.line ?? '';
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (!this.shell) return;
      const value = this.input.value;
      const { candidates, prefix } = this.shell.complete(value);
      if (candidates.length === 0) return;
      if (candidates.length === 1) {
        const c = candidates[0] as string;
        this.input.value = value.slice(0, value.length - prefix.length) + c + (c.endsWith('/') ? '' : ' ');
        this.lastTab = '';
        return;
      }
      // longest common prefix
      let lcp = candidates[0] as string;
      for (const c of candidates) { let i = 0; while (i < lcp.length && i < c.length && lcp[i] === c[i]) i++; lcp = lcp.slice(0, i); }
      if (lcp.length > prefix.length) { this.input.value = value.slice(0, value.length - prefix.length) + lcp; this.lastTab = ''; return; }
      if (this.lastTab === value) { this.print(`${this.prompt()}${value}\n${candidates.join('  ')}\n`); this.lastTab = ''; }
      else this.lastTab = value;
    }
  }

  private setupResize(handle: HTMLElement): void {
    let startY = 0, startH = 0;
    const move = (e: MouseEvent) => { this.el.style.height = `${Math.max(120, startH - (e.clientY - startY))}px`; };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    handle.addEventListener('mousedown', (e) => { startY = e.clientY; startH = this.el.getBoundingClientRect().height; window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); e.preventDefault(); });
  }
}
