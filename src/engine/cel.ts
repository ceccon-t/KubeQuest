/**
 * A small subset of the Common Expression Language, enough for typical ValidatingAdmissionPolicy rules:
 * literals, field/index access, `has()`, comparisons, arithmetic, `&&`/`||`/`!`, `in`, the ternary, the
 * comprehension macros (`all`, `exists`, `exists_one`, `filter`, `map`) and common string functions.
 * Anything else raises CelUnsupported so the caller can refuse honestly instead of guessing.
 */

export class CelError extends Error {}
export class CelUnsupported extends Error {}

type Tok = { t: 'num' | 'str' | 'id' | 'op' | 'end'; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9]/.test(ch)) { let j = i; while (j < src.length && /[0-9.]/.test(src[j] as string)) j++; out.push({ t: 'num', v: src.slice(i, j) }); i = j; continue; }
    if (ch === '"' || ch === "'") {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== ch) { if (src[j] === '\\' && j + 1 < src.length) { const n = src[j + 1] as string; s += n === 'n' ? '\n' : n === 't' ? '\t' : n; j += 2; } else { s += src[j]; j++; } }
      if (j >= src.length) throw new CelError('unterminated string literal');
      out.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    if (/[A-Za-z_]/.test(ch)) { let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j++; out.push({ t: 'id', v: src.slice(i, j) }); i = j; continue; }
    const two = src.slice(i, i + 2);
    if (['&&', '||', '==', '!=', '<=', '>='].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('()[]{}.,:?!<>+-*/%'.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue; }
    throw new CelError(`Syntax error: token recognition error at: '${ch}'`);
  }
  out.push({ t: 'end', v: '' });
  return out;
}

type Node =
  | { k: 'lit'; v: unknown }
  | { k: 'id'; name: string }
  | { k: 'member'; obj: Node; name: string }
  | { k: 'index'; obj: Node; idx: Node }
  | { k: 'call'; target?: Node; name: string; args: Node[] }
  | { k: 'unary'; op: string; arg: Node }
  | { k: 'binary'; op: string; l: Node; r: Node }
  | { k: 'cond'; c: Node; a: Node; b: Node }
  | { k: 'list'; items: Node[] }
  | { k: 'map'; entries: [Node, Node][] };

class Parser {
  private toks: Tok[];
  private p = 0;
  constructor(toks: Tok[]) { this.toks = toks; }
  private peek(): Tok { return this.toks[this.p] as Tok; }
  private next(): Tok { return this.toks[this.p++] as Tok; }
  private is(v: string): boolean { const t = this.peek(); return t.t === 'op' && t.v === v; }
  private eat(v: string): void { if (!this.is(v)) throw new CelError(`Syntax error: expected '${v}' but found '${this.peek().v || '<EOF>'}'`); this.p++; }
  parse(): Node { const n = this.cond(); if (this.peek().t !== 'end') throw new CelError(`Syntax error: extraneous input '${this.peek().v}'`); return n; }
  private cond(): Node {
    const c = this.or();
    if (!this.is('?')) return c;
    this.p++;
    const a = this.or();
    this.eat(':');
    return { k: 'cond', c, a, b: this.cond() };
  }
  private or(): Node { let l = this.and(); while (this.is('||')) { this.p++; l = { k: 'binary', op: '||', l, r: this.and() }; } return l; }
  private and(): Node { let l = this.rel(); while (this.is('&&')) { this.p++; l = { k: 'binary', op: '&&', l, r: this.rel() }; } return l; }
  private rel(): Node {
    let l = this.add();
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) { this.p++; l = { k: 'binary', op: t.v, l, r: this.add() }; }
      else if (t.t === 'id' && t.v === 'in') { this.p++; l = { k: 'binary', op: 'in', l, r: this.add() }; }
      else return l;
    }
  }
  private add(): Node { let l = this.mul(); while (this.is('+') || this.is('-')) { const op = this.next().v; l = { k: 'binary', op, l, r: this.mul() }; } return l; }
  private mul(): Node { let l = this.unary(); while (this.is('*') || this.is('/') || this.is('%')) { const op = this.next().v; l = { k: 'binary', op, l, r: this.unary() }; } return l; }
  private unary(): Node {
    if (this.is('!') || this.is('-')) { const op = this.next().v; return { k: 'unary', op, arg: this.unary() }; }
    return this.postfix();
  }
  private args(): Node[] {
    const a: Node[] = [];
    if (this.is(')')) { this.p++; return a; }
    for (;;) { a.push(this.cond()); if (this.is(',')) { this.p++; continue; } this.eat(')'); return a; }
  }
  private postfix(): Node {
    let n = this.primary();
    for (;;) {
      if (this.is('.')) {
        this.p++;
        const id = this.next();
        if (id.t !== 'id') throw new CelError(`Syntax error: expected identifier after '.'`);
        if (this.is('(')) { this.p++; n = { k: 'call', target: n, name: id.v, args: this.args() }; }
        else n = { k: 'member', obj: n, name: id.v };
      } else if (this.is('[')) { this.p++; const idx = this.cond(); this.eat(']'); n = { k: 'index', obj: n, idx }; }
      else return n;
    }
  }
  private primary(): Node {
    const t = this.next();
    if (t.t === 'num') return { k: 'lit', v: parseFloat(t.v) };
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'id') {
      if (t.v === 'true') return { k: 'lit', v: true };
      if (t.v === 'false') return { k: 'lit', v: false };
      if (t.v === 'null') return { k: 'lit', v: null };
      if (this.is('(')) { this.p++; return { k: 'call', name: t.v, args: this.args() }; }
      return { k: 'id', name: t.v };
    }
    if (t.t === 'op' && t.v === '(') { const n = this.cond(); this.eat(')'); return n; }
    if (t.t === 'op' && t.v === '[') {
      const items: Node[] = [];
      if (this.is(']')) { this.p++; return { k: 'list', items }; }
      for (;;) { items.push(this.cond()); if (this.is(',')) { this.p++; continue; } this.eat(']'); return { k: 'list', items }; }
    }
    if (t.t === 'op' && t.v === '{') {
      const entries: [Node, Node][] = [];
      if (this.is('}')) { this.p++; return { k: 'map', entries }; }
      for (;;) { const key = this.cond(); this.eat(':'); entries.push([key, this.cond()]); if (this.is(',')) { this.p++; continue; } this.eat('}'); return { k: 'map', entries }; }
    }
    throw new CelError(`Syntax error: mismatched input '${t.v || '<EOF>'}'`);
  }
}

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function equal(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (isMap(a) && isMap(b)) { const ka = Object.keys(a); return ka.length === Object.keys(b).length && ka.every((k) => equal(a[k], b[k])); }
  return a === b;
}

function evalNode(n: Node, env: Record<string, unknown>): unknown {
  switch (n.k) {
    case 'lit': return n.v;
    case 'id': {
      if (!Object.prototype.hasOwnProperty.call(env, n.name)) throw new CelError(`undeclared reference to '${n.name}' (in container '')`);
      return env[n.name];
    }
    case 'member': {
      const o = evalNode(n.obj, env);
      if (!isMap(o)) throw new CelError(`no such key: ${n.name}`);
      if (!Object.prototype.hasOwnProperty.call(o, n.name)) throw new CelError(`no such key: ${n.name}`);
      return o[n.name];
    }
    case 'index': {
      const o = evalNode(n.obj, env), i = evalNode(n.idx, env);
      if (Array.isArray(o)) { if (typeof i !== 'number' || i < 0 || i >= o.length) throw new CelError(`index out of bounds: ${String(i)}`); return o[i]; }
      if (isMap(o)) { if (!Object.prototype.hasOwnProperty.call(o, String(i))) throw new CelError(`no such key: ${String(i)}`); return o[String(i)]; }
      throw new CelError('no such overload');
    }
    case 'list': return n.items.map((x) => evalNode(x, env));
    case 'map': return Object.fromEntries(n.entries.map(([k, v]) => [String(evalNode(k, env)), evalNode(v, env)]));
    case 'cond': return evalNode(n.c, env) === true ? evalNode(n.a, env) : evalNode(n.b, env);
    case 'unary': {
      const v = evalNode(n.arg, env);
      if (n.op === '!') { if (typeof v !== 'boolean') throw new CelError('no such overload'); return !v; }
      if (typeof v !== 'number') throw new CelError('no such overload');
      return -v;
    }
    case 'binary': {
      if (n.op === '&&' || n.op === '||') {
        // CEL's logical operators are commutative: an error on one side is absorbed when the other side decides
        let l: unknown, lerr: unknown;
        try { l = evalNode(n.l, env); } catch (e) { lerr = e; }
        if (lerr === undefined && l === (n.op === '||')) return l;
        const r = evalNode(n.r, env);
        if (r === (n.op === '||')) return r;
        if (lerr !== undefined) throw lerr;
        return n.op === '&&' ? l === true && r === true : l === true || r === true;
      }
      const l = evalNode(n.l, env), r = evalNode(n.r, env);
      switch (n.op) {
        case '==': return equal(l, r);
        case '!=': return !equal(l, r);
        case 'in': if (Array.isArray(r)) return r.some((x) => equal(x, l)); if (isMap(r)) return Object.prototype.hasOwnProperty.call(r, String(l)); throw new CelError('no such overload');
        case '+': if (typeof l === 'string' && typeof r === 'string') return l + r; if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r]; break;
        default: break;
      }
      if (typeof l === 'string' && typeof r === 'string') {
        switch (n.op) { case '<': return l < r; case '<=': return l <= r; case '>': return l > r; case '>=': return l >= r; default: throw new CelError('no such overload'); }
      }
      if (typeof l !== 'number' || typeof r !== 'number') throw new CelError('no such overload');
      switch (n.op) {
        case '<': return l < r; case '<=': return l <= r; case '>': return l > r; case '>=': return l >= r;
        case '+': return l + r; case '-': return l - r; case '*': return l * r;
        case '/': if (r === 0) throw new CelError('division by zero'); return Math.trunc(l / r);
        case '%': if (r === 0) throw new CelError('modulus by zero'); return l % r;
        default: throw new CelError('no such overload');
      }
    }
    case 'call': return call(n, env);
  }
}

function hasPath(n: Node, env: Record<string, unknown>): boolean {
  if (n.k !== 'member') throw new CelError('invalid argument to has() macro');
  let o: unknown;
  try { o = evalNode(n.obj, env); } catch (e) { if (e instanceof CelError && e.message.startsWith('no such key')) throw e; throw e; }
  return isMap(o) && Object.prototype.hasOwnProperty.call(o, n.name) && o[n.name] !== undefined;
}

function call(n: Extract<Node, { k: 'call' }>, env: Record<string, unknown>): unknown {
  if (!n.target) {
    switch (n.name) {
      case 'has': return hasPath(n.args[0] as Node, env);
      case 'size': { const v = evalNode(n.args[0] as Node, env); return sizeOf(v); }
      case 'int': case 'double': { const v = evalNode(n.args[0] as Node, env); const x = typeof v === 'string' ? parseFloat(v) : v; if (typeof x !== 'number' || Number.isNaN(x)) throw new CelError('type conversion error'); return n.name === 'int' ? Math.trunc(x) : x; }
      case 'string': return String(evalNode(n.args[0] as Node, env));
      default: throw new CelUnsupported(n.name);
    }
  }
  const macro = ['all', 'exists', 'exists_one', 'filter', 'map'].includes(n.name);
  if (macro && n.args.length === 2 && n.args[0]?.k === 'id') {
    const coll = evalNode(n.target, env);
    const items = Array.isArray(coll) ? coll : isMap(coll) ? Object.keys(coll) : undefined;
    if (!items) throw new CelError('no such overload');
    const v = (n.args[0] as { name: string }).name;
    const body = n.args[1] as Node;
    const each = (x: unknown): unknown => evalNode(body, { ...env, [v]: x });
    switch (n.name) {
      case 'all': return items.every((x) => each(x) === true);
      case 'exists': return items.some((x) => each(x) === true);
      case 'exists_one': return items.filter((x) => each(x) === true).length === 1;
      case 'filter': return items.filter((x) => each(x) === true);
      default: return items.map(each);
    }
  }
  const t = evalNode(n.target, env);
  const a = n.args.map((x) => evalNode(x, env));
  if (n.name === 'size' && !a.length) return sizeOf(t);
  if (typeof t === 'string') {
    const s = a[0];
    switch (n.name) {
      case 'startsWith': return typeof s === 'string' && t.startsWith(s);
      case 'endsWith': return typeof s === 'string' && t.endsWith(s);
      case 'contains': return typeof s === 'string' && t.includes(s);
      case 'matches': try { return new RegExp(String(s)).test(t); } catch { throw new CelError(`invalid regular expression: ${String(s)}`); }
      case 'lowerAscii': return t.toLowerCase();
      case 'upperAscii': return t.toUpperCase();
      case 'split': return t.split(String(s));
      case 'trim': return t.trim();
      default: break;
    }
  }
  throw new CelUnsupported(n.name);
}

function sizeOf(v: unknown): number {
  if (typeof v === 'string' || Array.isArray(v)) return v.length;
  if (isMap(v)) return Object.keys(v).length;
  throw new CelError('no such overload');
}

/** Evaluate a CEL expression. Throws CelError (evaluation failed) or CelUnsupported (outside the simulator's subset). */
export function evalCel(expression: string, env: Record<string, unknown>): unknown {
  return evalNode(new Parser(lex(expression)).parse(), env);
}

/** Syntax check only (used when a policy is admitted). */
export function checkCel(expression: string): void {
  new Parser(lex(expression)).parse();
}
