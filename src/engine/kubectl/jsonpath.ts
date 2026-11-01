/** kubectl jsonpath subset: {.a.b}, {.items[*].x}, {.a[0]}, {range ...}{end}, {"text"}, filters [?(@.x=="y")]. */
import { KubectlError } from './args.ts';

type Node = { kind: 'text'; text: string } | { kind: 'path'; path: string } | { kind: 'range'; path: string; body: Node[] };

function parseTemplate(tpl: string): Node[] {
  const nodes: Node[] = [];
  let i = 0;
  const stack: Node[][] = [nodes];
  while (i < tpl.length) {
    const open = tpl.indexOf('{', i);
    if (open < 0) { stack[stack.length - 1]!.push({ kind: 'text', text: tpl.slice(i) }); break; }
    if (open > i) stack[stack.length - 1]!.push({ kind: 'text', text: tpl.slice(i, open) });
    const close = tpl.indexOf('}', open);
    if (close < 0) throw new KubectlError(`error parsing jsonpath ${tpl}, unclosed action`);
    const expr = tpl.slice(open + 1, close).trim();
    i = close + 1;
    if (expr.startsWith('"') && expr.endsWith('"')) {
      stack[stack.length - 1]!.push({ kind: 'text', text: JSON.parse(expr.replace(/\\n/g, '\n').replace(/\n/g, '\\n')) as string });
    } else if (expr.startsWith('range ')) {
      const node: Node = { kind: 'range', path: expr.slice(6).trim(), body: [] };
      stack[stack.length - 1]!.push(node);
      stack.push(node.body);
    } else if (expr === 'end') {
      if (stack.length === 1) throw new KubectlError(`error parsing jsonpath ${tpl}, not in range, nothing to end`);
      stack.pop();
    } else {
      stack[stack.length - 1]!.push({ kind: 'path', path: expr });
    }
  }
  return nodes;
}

function evalPath(path: string, roots: unknown[]): unknown[] {
  let cur = roots;
  let p = path.trim();
  if (p.startsWith('$')) p = p.slice(1);
  while (p.length) {
    if (p.startsWith('.')) {
      p = p.slice(1);
      const m = /^([^.\[]+)/.exec(p);
      if (!m) continue;
      const key = m[1] as string;
      p = p.slice(key.length);
      cur = cur.flatMap((v) => (v && typeof v === 'object' && !Array.isArray(v) ? [(v as Record<string, unknown>)[key]] : Array.isArray(v) ? v.map((x) => (x as Record<string, unknown>)?.[key]) : [])).filter((v) => v !== undefined);
      continue;
    }
    if (p.startsWith('[')) {
      const end = p.indexOf(']');
      const inner = p.slice(1, end).trim();
      p = p.slice(end + 1);
      if (inner === '*') { cur = cur.flatMap((v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : [])); continue; }
      if (/^-?\d+$/.test(inner)) { const idx = parseInt(inner, 10); cur = cur.flatMap((v) => (Array.isArray(v) ? [v[idx < 0 ? v.length + idx : idx]] : [])).filter((v) => v !== undefined); continue; }
      if (inner.startsWith("'") || inner.startsWith('"')) { const key = inner.slice(1, -1); cur = cur.map((v) => (v as Record<string, unknown>)?.[key]).filter((v) => v !== undefined); continue; }
      const f = /^\?\(@(.*?)\s*(==|!=|>|<|>=|<=)\s*(.*)\)$/.exec(inner);
      if (f) {
        const sub = f[1] as string, op = f[2] as string;
        let rhs: unknown = (f[3] as string).trim();
        if (typeof rhs === 'string' && /^["'].*["']$/.test(rhs)) rhs = rhs.slice(1, -1);
        else if (typeof rhs === 'string' && /^-?\d+(\.\d+)?$/.test(rhs)) rhs = parseFloat(rhs);
        else if (rhs === 'true' || rhs === 'false') rhs = rhs === 'true';
        cur = cur.flatMap((v) => (Array.isArray(v) ? v : [])).filter((item) => {
          const lhs = evalPath(sub, [item])[0];
          switch (op) {
            case '==': return String(lhs) === String(rhs);
            case '!=': return String(lhs) !== String(rhs);
            case '>': return Number(lhs) > Number(rhs);
            case '<': return Number(lhs) < Number(rhs);
            case '>=': return Number(lhs) >= Number(rhs);
            case '<=': return Number(lhs) <= Number(rhs);
            default: return false;
          }
        });
        continue;
      }
      throw new KubectlError(`error parsing jsonpath: unsupported expression [${inner}]`);
    }
    throw new KubectlError(`error parsing jsonpath: unrecognized character in action: U+${p.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
  }
  return cur;
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function jsonpath(template: string, data: unknown): string {
  const nodes = parseTemplate(template);
  const run = (ns: Node[], roots: unknown[]): string => {
    let out = '';
    for (const n of ns) {
      if (n.kind === 'text') out += n.text;
      else if (n.kind === 'path') out += evalPath(n.path, roots).map(fmt).join(' ');
      else {
        const items = evalPath(n.path, roots);
        for (const it of items) out += run(n.body, [it]);
      }
    }
    return out;
  };
  return run(nodes, [data]);
}
