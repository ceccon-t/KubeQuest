/**
 * Minimal YAML 1.2 (core schema) parser/emitter covering the subset used by Kubernetes
 * manifests: block mappings/sequences, flow `[]`/`{}`, quoted & plain scalars, block
 * scalars (`|`, `|-`, `>`, `>-`), comments, multi-document streams (`---`).
 * Not supported: anchors/aliases, tags, complex keys. Errors mimic go-yaml messages.
 */

export type YamlValue = null | boolean | number | string | YamlValue[] | { [k: string]: YamlValue };

export class YamlError extends Error {
  line: number;
  constructor(line: number, message: string) {
    super(`yaml: line ${line}: ${message}`);
    this.line = line;
  }
}

interface Line { indent: number; text: string; no: number; raw: string }

function stripComment(raw: string): string {
  let inS = false, inD = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) { if (raw[i - 1] !== '\\') inD = !inD; }
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(raw[i - 1] as string))) return raw.slice(0, i);
  }
  return raw;
}

function toLines(src: string): Line[] {
  const out: Line[] = [];
  const rows = src.replace(/\r\n?/g, '\n').split('\n');
  rows.forEach((raw, i) => {
    if (raw.includes('\t') && /^\s*\t/.test(raw)) throw new YamlError(i + 1, 'found character that cannot start any token');
    const text = stripComment(raw).replace(/\s+$/, '');
    const indent = raw.length - raw.replace(/^ */, '').length;
    out.push({ indent, text, no: i + 1, raw });
  });
  return out;
}

/** Split a YAML stream into documents. Returns parsed values (empty docs are skipped). */
export function parseAllDocuments(src: string): YamlValue[] {
  const docs: YamlValue[] = [];
  const chunks: string[] = [];
  let cur: string[] = [];
  for (const row of src.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^---(\s|$)/.test(row)) { chunks.push(cur.join('\n')); cur = []; continue; }
    if (/^\.\.\.\s*$/.test(row)) { chunks.push(cur.join('\n')); cur = []; continue; }
    cur.push(row);
  }
  chunks.push(cur.join('\n'));
  for (const c of chunks) {
    if (c.trim() === '') continue;
    const v = parseDocument(c);
    if (v !== null) docs.push(v);
  }
  return docs;
}

export function parseDocument(src: string): YamlValue {
  const lines = toLines(src).filter((l) => l.text.trim() !== '');
  if (lines.length === 0) return null;
  const p = new Parser(lines);
  const v = p.parseNode(lines[0]!.indent);
  if (p.pos < lines.length) throw new YamlError(lines[p.pos]!.no, `did not find expected key`);
  return v;
}

class Parser {
  pos = 0;
  private lines: Line[];
  constructor(lines: Line[]) {
    this.lines = lines;
  }
  private peek(): Line | undefined { return this.lines[this.pos]; }

  parseNode(indent: number): YamlValue {
    const l = this.peek();
    if (!l) return null;
    if (l.indent < indent) return null;
    const t = l.text.trim();
    if (t === '-' || t.startsWith('- ')) return this.parseSequence(l.indent);
    if (findKeyColon(t) >= 0) return this.parseMapping(l.indent);
    // bare scalar node (possibly multi-line plain)
    this.pos++;
    return parseScalar(t, l.no);
  }

  parseSequence(indent: number): YamlValue[] {
    const arr: YamlValue[] = [];
    while (true) {
      const l = this.peek();
      if (!l || l.indent !== indent) break;
      const t = l.text.trim();
      if (!(t === '-' || t.startsWith('- '))) break;
      const rest = t === '-' ? '' : t.slice(2).trim();
      if (rest === '') {
        this.pos++;
        const nxt = this.peek();
        if (nxt && nxt.indent > indent) arr.push(this.parseNode(nxt.indent));
        else arr.push(null);
        continue;
      }
      // inline content after "- ": either a mapping start, a nested sequence, or a scalar
      const innerIndent = indent + (l.text.length - l.text.trimStart().length === indent ? 2 : 2) + (t.length - 1 - rest.length - 1);
      if (rest.startsWith('- ') || rest === '-') {
        // nested sequence on the same line: rewrite line virtually
        this.lines[this.pos] = { ...l, indent: innerIndent, text: ' '.repeat(innerIndent) + rest };
        arr.push(this.parseSequence(innerIndent));
        continue;
      }
      if (findKeyColon(rest) >= 0 && !isFlowStart(rest) && !isQuotedScalarOnly(rest)) {
        this.lines[this.pos] = { ...l, indent: innerIndent, text: ' '.repeat(innerIndent) + rest };
        arr.push(this.parseMapping(innerIndent));
        continue;
      }
      this.pos++;
      if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-' || rest === '|+' || rest === '>+') {
        arr.push(this.parseBlockScalar(rest, indent));
      } else arr.push(parseScalar(rest, l.no));
    }
    return arr;
  }

  parseMapping(indent: number): { [k: string]: YamlValue } {
    const obj: { [k: string]: YamlValue } = {};
    while (true) {
      const l = this.peek();
      if (!l) break;
      if (l.indent < indent) break;
      if (l.indent > indent) throw new YamlError(l.no, 'mapping values are not allowed in this context');
      const t = l.text.trim();
      if (t === '-' || t.startsWith('- ')) break;
      const ci = findKeyColon(t);
      if (ci < 0) throw new YamlError(l.no, `could not find expected ':'`);
      const rawKey = t.slice(0, ci).trim();
      const key = unquoteKey(rawKey, l.no);
      const rest = t.slice(ci + 1).trim();
      if (Object.prototype.hasOwnProperty.call(obj, key)) throw new YamlError(l.no, `mapping key "${key}" already defined`);
      if (rest === '') {
        this.pos++;
        const nxt = this.peek();
        if (nxt && (nxt.indent > indent || (nxt.indent === indent && (nxt.text.trim() === '-' || nxt.text.trim().startsWith('- '))))) {
          obj[key] = this.parseNode(nxt.indent);
        } else obj[key] = null;
        continue;
      }
      if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-' || rest === '|+' || rest === '>+') {
        this.pos++;
        obj[key] = this.parseBlockScalar(rest, indent);
        continue;
      }
      this.pos++;
      obj[key] = parseScalar(rest, l.no);
    }
    return obj;
  }

  parseBlockScalar(indicator: string, parentIndent: number): string {
    const literal = indicator.startsWith('|');
    const chomp = indicator.endsWith('-') ? 'strip' : indicator.endsWith('+') ? 'keep' : 'clip';
    const collected: string[] = [];
    let blockIndent = -1;
    while (true) {
      const l = this.lines[this.pos];
      if (!l) break;
      if (l.raw.trim() === '') { collected.push(''); this.pos++; continue; }
      if (l.indent <= parentIndent) break;
      if (blockIndent < 0) blockIndent = l.indent;
      if (l.indent < blockIndent) break;
      collected.push(l.raw.slice(blockIndent).replace(/\s+$/, ''));
      this.pos++;
    }
    // trailing blank lines handling
    let body = collected;
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') { body = body.slice(0, -1); trailing++; }
    // if we consumed trailing blank lines that actually belong to the following node, give them back (they are blank anyway)
    let text: string;
    if (literal) text = body.join('\n');
    else {
      // folded: join consecutive non-empty lines with spaces; blank lines become newlines
      const parts: string[] = [];
      let para: string[] = [];
      for (const line of body) {
        if (line === '') { parts.push(para.join(' ')); para = []; parts.push(''); }
        else para.push(line);
      }
      parts.push(para.join(' '));
      text = parts.join('\n').replace(/\n\n/g, '\n');
    }
    if (chomp === 'clip') text += body.length ? '\n' : '';
    else if (chomp === 'keep') text += '\n'.repeat(trailing + (body.length ? 1 : 0));
    return text;
  }
}

function isFlowStart(s: string): boolean { return s.startsWith('[') || s.startsWith('{'); }
function isQuotedScalarOnly(s: string): boolean {
  return (s.startsWith('"') && s.endsWith('"') && s.indexOf('"', 1) === s.length - 1) || (s.startsWith("'") && s.endsWith("'") && s.indexOf("'", 1) === s.length - 1);
}

/** Index of the mapping colon (`: ` or trailing `:`) outside quotes/flow; -1 if none. */
function findKeyColon(t: string): number {
  if (t.startsWith('[') || t.startsWith('{')) return -1;
  let inS = false, inD = false;
  if (t.startsWith('"')) {
    const end = t.indexOf('"', 1);
    if (end > 0 && t[end + 1] === ':' && (t.length === end + 2 || t[end + 2] === ' ')) return end + 1;
    return -1;
  }
  if (t.startsWith("'")) {
    const end = t.indexOf("'", 1);
    if (end > 0 && t[end + 1] === ':' && (t.length === end + 2 || t[end + 2] === ' ')) return end + 1;
    return -1;
  }
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === ':' && !inS && !inD && (i === t.length - 1 || t[i + 1] === ' ')) return i;
  }
  return -1;
}

function unquoteKey(k: string, no: number): string {
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) return String(parseScalar(k, no));
  return k;
}

export function parseScalar(s: string, no: number): YamlValue {
  if (s === '' ) return null;
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new YamlError(no, 'found unexpected end of stream');
    return s.slice(1, -1).replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (_m, g: string) => {
      switch (g[0]) {
        case 'n': return '\n'; case 't': return '\t'; case 'r': return '\r'; case 'b': return '\b'; case 'f': return '\f';
        case 'u': return String.fromCharCode(parseInt(g.slice(1), 16));
        default: return g;
      }
    });
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new YamlError(no, 'found unexpected end of stream');
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('[') || s.startsWith('{')) return parseFlow(s, no);
  if (s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (/^[-+]?(0|[1-9][0-9]*)$/.test(s)) return parseInt(s, 10);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s)) return parseFloat(s);
  if (s === '.inf' || s === '.Inf') return Infinity;
  if (s === '-.inf') return -Infinity;
  if (s === '.nan' || s === '.NaN') return NaN;
  return s;
}

function parseFlow(s: string, no: number): YamlValue {
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i] as string)) i++; };
  const value = (): YamlValue => {
    ws();
    const c = s[i];
    if (c === '[') {
      i++;
      const arr: YamlValue[] = [];
      ws();
      if (s[i] === ']') { i++; return arr; }
      while (true) {
        arr.push(value());
        ws();
        if (s[i] === ',') { i++; ws(); if (s[i] === ']') { i++; return arr; } continue; }
        if (s[i] === ']') { i++; return arr; }
        throw new YamlError(no, `did not find expected ',' or ']'`);
      }
    }
    if (c === '{') {
      i++;
      const obj: { [k: string]: YamlValue } = {};
      ws();
      if (s[i] === '}') { i++; return obj; }
      while (true) {
        ws();
        const k = scalarToken(true);
        ws();
        if (s[i] !== ':') throw new YamlError(no, `could not find expected ':'`);
        i++;
        obj[String(k)] = value();
        ws();
        if (s[i] === ',') { i++; ws(); if (s[i] === '}') { i++; return obj; } continue; }
        if (s[i] === '}') { i++; return obj; }
        throw new YamlError(no, `did not find expected ',' or '}'`);
      }
    }
    return scalarToken(false);
  };
  const scalarToken = (isKey: boolean): YamlValue => {
    ws();
    const c = s[i];
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === q) { if (q === "'" && s[j + 1] === "'") { j += 2; continue; } break; }
        if (q === '"' && s[j] === '\\') j++;
        j++;
      }
      const tok = s.slice(i, j + 1);
      i = j + 1;
      return parseScalar(tok, no);
    }
    let j = i;
    while (j < s.length && !/[,\]}]/.test(s[j] as string) && !(isKey && s[j] === ':')) j++;
    const tok = s.slice(i, j).trim();
    i = j;
    return parseScalar(tok, no);
  };
  const v = value();
  ws();
  if (i < s.length) throw new YamlError(no, `did not find expected ',' or ']'`);
  return v;
}

// ---------------------------------------------------------------------------
// Emitter — matches the look of `kubectl get -o yaml` (sigs.k8s.io/yaml → go-yaml v2):
// sorted keys, 2-space indent, sequences not indented under their key, strings quoted
// only when needed, multi-line strings as `|-` / `|`.
// ---------------------------------------------------------------------------

export function stringify(v: YamlValue): string {
  const out: string[] = [];
  emit(v, 0, out, false);
  return out.join('\n') + '\n';
}

function needsQuotes(s: string): boolean {
  if (s === '') return true;
  if (/^[\s]|[\s]$/.test(s)) return true;
  if (/^(true|false|null|~|yes|no|on|off|y|n|True|False|Null|NULL|TRUE|FALSE|Yes|No|On|Off|YES|NO|ON|OFF)$/i.test(s)) return true;
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s)) return true;
  if (/^(0x[0-9a-fA-F]+|0o[0-7]+|[-+]?\.(inf|Inf|INF|nan|NaN|NAN))$/.test(s)) return true;
  if (/^[?:,\[\]{}#&*!|>'"%@`]/.test(s)) return true;
  if (s === '-' || s.startsWith('- ') || s.startsWith('---')) return true;
  if (/: |#| $|^-\s|:$/.test(s)) return true;
  if (/[\n\t]/.test(s)) return true;
  // go-yaml also quotes strings that look like timestamps or contain special chars
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return true;
  return false;
}

function quote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
}

function scalar(v: YamlValue): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : v > 0 ? '.inf' : v < 0 ? '-.inf' : '.nan';
  const s = v as string;
  return needsQuotes(s) ? quote(s) : s;
}

function isEmpty(v: YamlValue): boolean {
  return (Array.isArray(v) && v.length === 0) || (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
}

function emit(v: YamlValue, indent: number, out: string[], inSeq: boolean): void {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (v.length === 0) { out.push(pad + '[]'); return; }
    for (const item of v) {
      if (Array.isArray(item) && item.length) {
        out.push(pad + '-');
        emit(item, indent + 2, out, true);
      } else if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length) {
        const keys = Object.keys(item).sort();
        let first = true;
        for (const k of keys) {
          const val = (item as { [k: string]: YamlValue })[k] as YamlValue;
          const prefix = first ? pad + '- ' : pad + '  ';
          emitKeyValue(k, val, prefix, indent + 2, out);
          first = false;
        }
      } else {
        out.push(pad + '- ' + scalarOrBlock(item, indent + 2));
      }
    }
    return;
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    if (keys.length === 0) { out.push(pad + '{}'); return; }
    for (const k of keys) emitKeyValue(k, v[k] as YamlValue, pad, indent, out);
    return;
  }
  out.push(pad + scalarOrBlock(v, indent));
  void inSeq;
}

function emitKeyValue(k: string, val: YamlValue, prefix: string, indent: number, out: string[]): void {
  const key = needsQuotes(k) ? quote(k) : k;
  if (Array.isArray(val)) {
    if (val.length === 0) { out.push(`${prefix}${key}: []`); return; }
    out.push(`${prefix}${key}:`);
    emit(val, indent, out, false); // go-yaml does not indent sequences under their key
    return;
  }
  if (val && typeof val === 'object') {
    if (isEmpty(val)) { out.push(`${prefix}${key}: {}`); return; }
    out.push(`${prefix}${key}:`);
    emit(val, indent + 2, out, false);
    return;
  }
  if (typeof val === 'string' && val.includes('\n')) {
    const lines = val.split('\n');
    const keep = val.endsWith('\n');
    const body = keep ? lines.slice(0, -1) : lines;
    out.push(`${prefix}${key}: ${keep ? '|' : '|-'}`);
    for (const l of body) out.push(' '.repeat(indent + 2) + l);
    return;
  }
  out.push(`${prefix}${key}: ${scalar(val)}`);
}

function scalarOrBlock(v: YamlValue, indent: number): string {
  if (typeof v === 'string' && v.includes('\n')) {
    const lines = v.split('\n');
    const keep = v.endsWith('\n');
    const body = keep ? lines.slice(0, -1) : lines;
    return (keep ? '|' : '|-') + '\n' + body.map((l) => ' '.repeat(indent) + l).join('\n');
  }
  return scalar(v);
}

/** JSON as `kubectl get -o json` prints it: 4-space indent, sorted keys. */
export function toJsonPretty(v: unknown): string {
  return JSON.stringify(sortKeys(v), null, 4);
}
export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = sortKeys((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}
