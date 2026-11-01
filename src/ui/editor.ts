/** YAML editor modal: textarea + line numbers, Ctrl+S saves, Esc cancels, vim-style :wq / :q! in the command strip. */
import { h } from './dom.ts';

export function openEditor(initial: string, filename: string): Promise<string | null> {
  return new Promise((resolve) => {
    const gutter = h('div', { class: 'gutter' });
    const ta = h('textarea', { spellcheck: 'false', 'aria-label': `editing ${filename}` });
    ta.value = initial;
    const status = h('span', { class: 'muted' }, 'Ctrl+S save · Esc cancel · :wq / :q! below');
    const cmd = h('input', { type: 'text', placeholder: ':wq to save and quit, :q! to discard', 'aria-label': 'editor command' });
    const back = h('div', { class: 'modal-back' });
    const finish = (value: string | null) => { back.remove(); resolve(value); };
    const save = () => finish(ta.value);
    const cancel = () => finish(null);
    const modal = h('div', { class: 'modal editor', role: 'dialog', 'aria-label': `editor ${filename}` },
      h('div', { class: 'toolbar' }, h('strong', { class: 'mono' }, filename), h('span', { class: 'spacer', style: { flex: '1' } }), status, h('button', { class: 'primary', onclick: save }, 'Save (Ctrl+S)'), h('button', { onclick: cancel }, 'Cancel (Esc)')),
      h('div', { class: 'body' }, gutter, ta),
      h('div', { class: 'cmdline' }, h('span', null, ':'), cmd),
    );
    back.append(modal);
    const renumber = () => {
      const n = ta.value.split('\n').length;
      gutter.textContent = Array.from({ length: n }, (_, i) => String(i + 1)).join('\n');
      gutter.scrollTop = ta.scrollTop;
    };
    ta.addEventListener('input', renumber);
    ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
    ta.addEventListener('keydown', (e) => {
      if (e.ctrlKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); return; }
      if (e.key === 'Escape') { e.preventDefault(); cmd.focus(); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart, end = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(end);
        ta.selectionStart = ta.selectionEnd = s + 2;
        renumber();
      }
    });
    cmd.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); ta.focus(); return; }
      if (e.key !== 'Enter') return;
      const v = cmd.value.trim().replace(/^:/, '');
      cmd.value = '';
      if (v === 'wq' || v === 'x' || v === 'w' ) { if (v === 'w') { status.textContent = 'written (still editing)'; return; } save(); }
      else if (v === 'q!' ) cancel();
      else if (v === 'q') { if (ta.value === initial) cancel(); else status.textContent = 'E37: No write since last change (add ! to override)'; }
      else status.textContent = `E492: Not an editor command: ${v}`;
    });
    document.body.append(back);
    renumber();
    ta.focus();
    ta.setSelectionRange(0, 0);
  });
}
