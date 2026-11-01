/** Tiny DOM helpers (no framework). */

type Child = Node | string | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v as Record<string, string>);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'html') el.innerHTML = String(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Minimal markdown: paragraphs, **bold**, *italic*, `code`. Safe (text nodes only). */
export function mdLite(text: string): HTMLElement {
  const wrap = h('div');
  for (const para of text.split(/\n\s*\n/)) {
    const p = h('p');
    const parts = para.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g);
    for (const part of parts) {
      if (part.startsWith('**') && part.endsWith('**')) p.append(h('strong', null, part.slice(2, -2)));
      else if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) p.append(h('em', null, part.slice(1, -1)));
      else if (part.startsWith('`') && part.endsWith('`')) p.append(h('code', null, part.slice(1, -1)));
      else p.append(document.createTextNode(part));
    }
    wrap.append(p);
  }
  return wrap;
}

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function stars(n: number, max = 3): HTMLElement {
  const el = h('span', { class: 'stars', 'aria-label': `${n} of ${max} stars` });
  for (let i = 0; i < max; i++) el.append(h('span', { class: i < n ? '' : 'off' }, '★'));
  return el;
}
