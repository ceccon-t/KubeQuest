/**
 * `helm` (v3) for local chart directories: install / upgrade / rollback / uninstall / list / history / status /
 * get / template / show / lint, with releases stored as Secrets like the real thing. Templates support the subset
 * of Go templates and Sprig that ordinary charts use; anything else fails with an honest "not supported" error.
 */
import type { Engine } from './engine.ts';
import type { Vfs } from './vfs.ts';
import type { OutputChunk } from './kubectl/context.ts';
import { out, err } from './kubectl/context.ts';
import type { KubeObject, Pod, Secret } from './types.ts';
import { parseDocument, parseAllDocuments, stringify, sortKeys, YamlError } from './yaml.ts';
import { b64encode, b64decode } from './encoding.ts';
import { ApiError } from './store.ts';
import { resourceByKind } from './registry.ts';
import { applyDefaults } from './defaults.ts';
import { admit } from './admission.ts';
import { validateStructure, validateObject, ValidationError } from './kubectl/validate.ts';

class HelmError extends Error {}
class Unsupported extends Error {}

// ---------------------------------------------------------------------------
// Template engine (Go text/template + Sprig subset)
// ---------------------------------------------------------------------------

type Val = unknown;
type Node =
  | { k: 'text'; text: string }
  | { k: 'action'; pipe: string; line: number }
  | { k: 'if'; branches: { cond: string; body: Node[] }[]; otherwise?: Node[]; line: number }
  | { k: 'range'; pipe: string; body: Node[]; otherwise?: Node[]; line: number }
  | { k: 'with'; pipe: string; body: Node[]; otherwise?: Node[]; line: number };

interface Scope { dot: Val; root: Val; vars: Record<string, Val>; defines: Record<string, Node[]>; file: string }

function lexTemplate(src: string): { text?: string; action?: string; line: number }[] {
  const parts: { text?: string; action?: string; line: number }[] = [];
  let i = 0, line = 1;
  while (i < src.length) {
    const open = src.indexOf('{{', i);
    if (open < 0) { parts.push({ text: src.slice(i), line }); break; }
    let text = src.slice(i, open);
    const close = src.indexOf('}}', open);
    if (close < 0) throw new HelmError(`parse error at (FILE:${line}): unclosed action`);
    let body = src.slice(open + 2, close);
    const trimLeft = body.startsWith('-') && /^-\s/.test(body), trimRight = /\s-$/.test(body);
    if (trimLeft) { body = body.slice(1); text = text.replace(/\s+$/, ''); }
    if (trimRight) body = body.slice(0, -1);
    if (text) parts.push({ text, line });
    line += (src.slice(i, close + 2).match(/\n/g) ?? []).length;
    parts.push({ action: body.trim(), line });
    i = close + 2;
    if (trimRight) { const m = /^\s+/.exec(src.slice(i)); if (m) { line += (m[0].match(/\n/g) ?? []).length; i += m[0].length; } }
  }
  return parts;
}

function parseTemplate(src: string, defines: Record<string, Node[]>): Node[] {
  const parts = lexTemplate(src);
  let p = 0;
  const block = (terminators: string[]): { nodes: Node[]; end: string } => {
    const nodes: Node[] = [];
    while (p < parts.length) {
      const part = parts[p++] as { text?: string; action?: string; line: number };
      if (part.text !== undefined) { nodes.push({ k: 'text', text: part.text }); continue; }
      const a = part.action as string;
      if (a.startsWith('/*')) continue;
      const word = a.split(/\s+/)[0] as string;
      if (terminators.includes(word) || (word === 'else' && terminators.includes('else'))) return { nodes, end: a };
      if (word === 'if') {
        const branches: { cond: string; body: Node[] }[] = [];
        let otherwise: Node[] | undefined;
        let cond = a.slice(2).trim();
        for (;;) {
          const b = block(['else', 'end']);
          branches.push({ cond, body: b.nodes });
          if (b.end === 'end') break;
          const rest = b.end.slice(4).trim();
          if (rest.startsWith('if')) { cond = rest.slice(2).trim(); continue; }
          otherwise = block(['end']).nodes;
          break;
        }
        nodes.push({ k: 'if', branches, otherwise, line: part.line });
      } else if (word === 'range' || word === 'with') {
        const b = block(['else', 'end']);
        const otherwise = b.end === 'end' ? undefined : block(['end']).nodes;
        nodes.push({ k: word, pipe: a.slice(word.length).trim(), body: b.nodes, otherwise, line: part.line });
      } else if (word === 'define') {
        const name = /^define\s+"([^"]+)"/.exec(a)?.[1] ?? '';
        defines[name] = block(['end']).nodes;
      } else if (word === 'template') {
        const m = /^template\s+"([^"]+)"\s*(.*)$/.exec(a);
        nodes.push({ k: 'action', pipe: `include "${m?.[1] ?? ''}" ${m?.[2] || '.'}`, line: part.line });
      } else if (word === 'end' || word === 'else') throw new HelmError(`parse error at (FILE:${part.line}): unexpected {{${word}}}`);
      else nodes.push({ k: 'action', pipe: a, line: part.line });
    }
    if (terminators.length) throw new HelmError('parse error at (FILE:1): unexpected EOF');
    return { nodes, end: '' };
  };
  return block([]).nodes;
}

function tokens(expr: string): string[] {
  const outT: string[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i] as string;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"') { let j = i + 1; while (j < expr.length && expr[j] !== '"') { if (expr[j] === '\\') j++; j++; } outT.push(expr.slice(i, j + 1)); i = j + 1; continue; }
    if (ch === '`') { const j = expr.indexOf('`', i + 1); outT.push(expr.slice(i, j + 1)); i = j + 1; continue; }
    if (ch === '(' || ch === ')' || ch === '|' || ch === ',') { outT.push(ch); i++; continue; }
    if (expr.startsWith(':=', i)) { outT.push(':='); i += 2; continue; }
    let j = i;
    while (j < expr.length && !/[\s()|,]/.test(expr[j] as string) && !expr.startsWith(':=', j)) j++;
    outT.push(expr.slice(i, j));
    i = j;
  }
  return outT;
}

const truthy = (v: Val): boolean => !(v === undefined || v === null || v === false || v === 0 || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0));
const text = (v: Val): string => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function field(base: Val, path: string[], expr: string): Val {
  let cur = base;
  for (const seg of path) {
    if (cur === undefined || cur === null) throw new HelmError(`nil pointer evaluating interface {}.${seg}|${expr}`);
    if (typeof cur !== 'object') throw new HelmError(`can't evaluate field ${seg} in type ${typeof cur}|${expr}`);
    cur = (cur as Record<string, Val>)[seg];
  }
  return cur;
}

function toYaml(v: Val): string {
  if (v === undefined || v === null) return 'null';
  if (typeof v !== 'object') return stringify(v as never).replace(/\n$/, '');
  return stringify(sortKeys(v) as never).replace(/\n$/, '');
}

function evalPipe(expr: string, sc: Scope): Val {
  const toks = tokens(expr);
  // $var := pipeline
  if (toks[1] === ':=' && (toks[0] as string).startsWith('$')) { const v = evalTokens(toks.slice(2), sc); sc.vars[(toks[0] as string).slice(1)] = v; return undefined; }
  return evalTokens(toks, sc);
}

function evalTokens(toks: string[], sc: Scope): Val {
  // split on top-level pipes
  const stages: string[][] = [[]];
  let depth = 0;
  for (const t of toks) {
    if (t === '(') depth++;
    if (t === ')') depth--;
    if (t === '|' && depth === 0) stages.push([]); else (stages[stages.length - 1] as string[]).push(t);
  }
  let value: Val;
  stages.forEach((stage, i) => { value = evalCommand(stage, sc, i > 0 ? [value] : []); });
  return value;
}

function evalCommand(toks: string[], sc: Scope, piped: Val[]): Val {
  // group parenthesised sub-pipelines into single arguments
  const args: (() => Val)[] = [];
  const raw: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as string;
    if (t === '(') {
      let d = 1, j = i + 1;
      while (j < toks.length && d > 0) { if (toks[j] === '(') d++; if (toks[j] === ')') d--; j++; }
      const inner = toks.slice(i + 1, j - 1);
      args.push(() => evalTokens(inner, sc)); raw.push('(');
      i = j - 1;
    } else { args.push(() => term(t, sc)); raw.push(t); }
  }
  const head = raw[0] ?? '';
  const isFn = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(head) && !['true', 'false', 'nil'].includes(head);
  if (!isFn) {
    if (args.length !== 1 || piped.length) { if (args.length === 0 && piped.length) return piped[0]; throw new HelmError(`can't give argument to non-function ${head}`); }
    return (args[0] as () => Val)();
  }
  const a = [...args.slice(1).map((f) => f()), ...piped];
  return callFn(head, a, sc);
}

function term(t: string, sc: Scope): Val {
  if (t.startsWith('"')) return JSON.parse(t) as string;
  if (t.startsWith('`')) return t.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'nil') return null;
  if (t === '.') return sc.dot;
  if (t === '$') return sc.root;
  if (t.startsWith('$')) { const [name, ...path] = t.slice(1).split('.'); if (name === '') return field(sc.root, path, t); if (!(name as string in sc.vars)) throw new HelmError(`undefined variable "$${name}"|${t}`); return field(sc.vars[name as string], path, t); }
  if (t.startsWith('.')) return field(sc.dot, t.slice(1).split('.'), t);
  throw new HelmError(`function "${t}" not defined`);
}

function callFn(name: string, a: Val[], sc: Scope): Val {
  const last = a[a.length - 1];
  const num = (v: Val): number => (typeof v === 'number' ? v : parseFloat(String(v)) || 0);
  switch (name) {
    case 'quote': return a.map((v) => JSON.stringify(text(v))).join(' ');
    case 'squote': return a.map((v) => `'${text(v)}'`).join(' ');
    case 'default': return truthy(last) ? last : a[0];
    case 'required': if (last === undefined || last === null || last === '') throw new HelmError(`REQUIRED|${text(a[0])}`); return last;
    case 'upper': return text(last).toUpperCase();
    case 'lower': return text(last).toLowerCase();
    case 'title': return text(last).replace(/\b\w/g, (c) => c.toUpperCase());
    case 'trim': return text(last).trim();
    case 'trimSuffix': return text(last).endsWith(text(a[0])) ? text(last).slice(0, text(last).length - text(a[0]).length) : text(last);
    case 'trimPrefix': return text(last).startsWith(text(a[0])) ? text(last).slice(text(a[0]).length) : text(last);
    case 'trunc': return text(last).slice(0, num(a[0]));
    case 'replace': return text(last).split(text(a[0])).join(text(a[1]));
    case 'contains': return text(last).includes(text(a[0]));
    case 'hasPrefix': return text(last).startsWith(text(a[0]));
    case 'hasSuffix': return text(last).endsWith(text(a[0]));
    case 'toYaml': return toYaml(last);
    case 'toJson': return JSON.stringify(last ?? null);
    case 'indent': return text(last).split('\n').map((l) => ' '.repeat(num(a[0])) + l).join('\n');
    case 'nindent': return '\n' + text(last).split('\n').map((l) => ' '.repeat(num(a[0])) + l).join('\n');
    case 'int': case 'int64': return Math.trunc(num(last));
    case 'toString': return text(last);
    case 'b64enc': return b64encode(text(last));
    case 'b64dec': return b64decode(text(last)) ?? '';
    case 'printf': { let i = 1; return text(a[0]).replace(/%[sdvq]/g, (m) => { const v = a[i++]; return m === '%q' ? JSON.stringify(text(v)) : text(v); }); }
    case 'print': return a.map(text).join('');
    case 'eq': return a.slice(1).some((x) => x === a[0]);
    case 'ne': return a[0] !== a[1];
    case 'lt': return num(a[0]) < num(a[1]);
    case 'le': return num(a[0]) <= num(a[1]);
    case 'gt': return num(a[0]) > num(a[1]);
    case 'ge': return num(a[0]) >= num(a[1]);
    case 'and': { let v: Val = true; for (const x of a) { v = x; if (!truthy(x)) return x; } return v; }
    case 'or': { let v: Val = false; for (const x of a) { v = x; if (truthy(x)) return x; } return v; }
    case 'not': return !truthy(a[0]);
    case 'len': return typeof last === 'string' || Array.isArray(last) ? last.length : last && typeof last === 'object' ? Object.keys(last).length : 0;
    case 'empty': return !truthy(last);
    case 'hasKey': return !!a[0] && typeof a[0] === 'object' && Object.prototype.hasOwnProperty.call(a[0], text(a[1]));
    case 'list': return a;
    case 'dict': { const d: Record<string, Val> = {}; for (let i = 0; i + 1 < a.length; i += 2) d[text(a[i])] = a[i + 1]; return d; }
    case 'add': return a.reduce((n: number, x) => n + num(x), 0);
    case 'sub': return num(a[0]) - num(a[1]);
    case 'mul': return a.reduce((n: number, x) => n * num(x), 1);
    case 'ternary': return truthy(a[2]) ? a[0] : a[1];
    case 'coalesce': return a.find(truthy);
    case 'include': {
      const body = sc.defines[text(a[0])];
      if (!body) throw new HelmError(`error calling include: template: no template "${text(a[0])}" associated with template "gotpl"`);
      return render(body, { ...sc, dot: a[1], vars: {} });
    }
    default:
      if (['tpl', 'lookup', 'sha256sum', 'now', 'date', 'randAlphaNum', 'genCA', 'fromYaml', 'regexMatch', 'splitList', 'join', 'until', 'merge', 'pick', 'omit', 'kindIs', 'typeOf', 'semverCompare', 'fail', 'toToml', 'get', 'set', 'unset', 'keys', 'values', 'sortAlpha', 'uniq', 'first', 'rest', 'has', 'concat', 'append', 'camelcase', 'snakecase', 'kebabcase', 'abbrev', 'nospace', 'cat', 'repeat', 'substr', 'toStrings', 'atoi', 'float64', 'max', 'min', 'div', 'mod', 'env', 'expandenv', 'urlParse', 'deepCopy', 'mustMerge', 'toPrettyJson', 'fromJson', 'htmlDate', 'dateInZone', 'ago', 'derivePassword', 'genPrivateKey', 'buildCustomCert', 'randAlpha', 'randNumeric', 'uuidv4', 'trimAll', 'wrap', 'indent', 'plural', 'regexReplaceAll', 'regexFind', 'splitn', 'split', 'initials', 'untitle', 'shuffle', 'swapcase', 'last', 'initial', 'reverse', 'compact', 'without', 'dig', 'mustToYaml', 'lookup'].includes(name)) throw new Unsupported(name);
      throw new HelmError(`function "${name}" not defined`);
  }
}

function render(nodes: Node[], sc: Scope): string {
  let outS = '';
  for (const n of nodes) {
    try {
      switch (n.k) {
        case 'text': outS += n.text; break;
        case 'action': { const v = evalPipe(n.pipe, sc); if (!/^\$\w+\s*:=/.test(n.pipe)) outS += text(v); break; }
        case 'if': {
          const hit = n.branches.find((b) => truthy(evalPipe(b.cond, sc)));
          if (hit) outS += render(hit.body, sc); else if (n.otherwise) outS += render(n.otherwise, sc);
          break;
        }
        case 'with': { const v = evalPipe(n.pipe, sc); if (truthy(v)) outS += render(n.body, { ...sc, dot: v }); else if (n.otherwise) outS += render(n.otherwise, sc); break; }
        case 'range': {
          const m = /^(?:\$(\w+)\s*(?:,\s*\$(\w+)\s*)?:=\s*)?([\s\S]+)$/.exec(n.pipe);
          const v = evalPipe((m?.[3] ?? n.pipe).trim(), sc);
          const entries: [Val, Val][] = Array.isArray(v) ? v.map((x, i) => [i, x]) : v && typeof v === 'object' ? Object.keys(v).sort().map((k2) => [k2, (v as Record<string, Val>)[k2]]) : [];
          if (!entries.length) { if (n.otherwise) outS += render(n.otherwise, sc); break; }
          for (const [key, item] of entries) {
            const vars = { ...sc.vars };
            if (m?.[1] && m[2]) { vars[m[1]] = key; vars[m[2]] = item; } else if (m?.[1]) vars[m[1]] = item;
            outS += render(n.body, { ...sc, dot: item, vars });
          }
          break;
        }
      }
    } catch (e) {
      if (e instanceof HelmError && !e.message.startsWith('AT|')) {
        const line = 'line' in n ? n.line : 1;
        const [msg, at] = e.message.split('|') as [string, string | undefined];
        if (msg === 'REQUIRED') throw new HelmError(`AT|execution error at (${sc.file}:${line}:${4}): ${at ?? ''}`);
        throw new HelmError(`AT|template: ${sc.file}:${line}:${4}: executing "${sc.file}" at <${at ?? ('pipe' in n ? n.pipe : '')}>: ${msg}`);
      }
      throw e;
    }
  }
  return outS;
}

// ---------------------------------------------------------------------------
// Charts, values, releases
// ---------------------------------------------------------------------------

interface Chart { dir: string; name: string; version: string; appVersion: string; values: Record<string, Val>; rawValues: string; templates: { path: string; text: string }[] }
interface Release { name: string; namespace: string; version: number; status: string; chart: { name: string; version: string; appVersion: string }; config: Record<string, Val>; manifest: string; notes: string; first: number; last: number; description: string }

function loadChart(vfs: Vfs, ref: string): Chart {
  if (/^(oci|https?):\/\//.test(ref) || (!ref.startsWith('.') && !ref.startsWith('/') && !ref.startsWith('~') && !vfs.isDir(ref))) throw new HelmError(vfs.exists(ref) ? `path "${ref}" is not a chart directory` : `kubequest: chart repositories and OCI registries are not simulated — point helm at a local chart directory (e.g. ./charts/NAME). "${ref}" not found`);
  const dir = vfs.resolve(ref);
  const meta = vfs.read(`${dir}/Chart.yaml`);
  if (meta === undefined) throw new HelmError(`Chart.yaml file is missing`);
  const c = (parseDocument(meta) ?? {}) as { name?: string; version?: string; appVersion?: unknown };
  if (!c.name) throw new HelmError('validation: chart.metadata.name is required');
  const rawValues = vfs.read(`${dir}/values.yaml`) ?? '';
  const templates = Object.entries(vfs.all()).filter(([p]) => p.startsWith(`${dir}/templates/`)).map(([p, t]) => ({ path: `${c.name}/templates/${p.slice(dir.length + 11)}`, text: t })).sort((x, y) => (x.path < y.path ? -1 : 1));
  return { dir, name: c.name, version: String(c.version ?? '0.1.0'), appVersion: String(c.appVersion ?? ''), values: ((rawValues.trim() ? parseDocument(rawValues) : {}) ?? {}) as Record<string, Val>, rawValues, templates };
}

function deepMerge(base: Val, over: Val): Val {
  if (over && typeof over === 'object' && !Array.isArray(over) && base && typeof base === 'object' && !Array.isArray(base)) {
    const o: Record<string, Val> = { ...(base as Record<string, Val>) };
    for (const [k, v] of Object.entries(over as Record<string, Val>)) { if (v === null) delete o[k]; else o[k] = deepMerge(o[k], v); }
    return o;
  }
  return over === undefined ? base : structuredClone(over);
}

function setValue(target: Record<string, Val>, expr: string): void {
  for (const pair of expr.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new HelmError(`failed parsing --set data: key "${pair}" has no value`);
    const path = pair.slice(0, eq).split('.');
    const raw = pair.slice(eq + 1);
    const value: Val = raw === 'true' ? true : raw === 'false' ? false : raw === 'null' ? null : /^-?\d+$/.test(raw) ? parseInt(raw, 10) : raw;
    let cur = target;
    for (const seg of path.slice(0, -1)) { if (!cur[seg] || typeof cur[seg] !== 'object') cur[seg] = {}; cur = cur[seg] as Record<string, Val>; }
    cur[path[path.length - 1] as string] = value;
  }
}

const INSTALL_ORDER = ['PriorityClass', 'Namespace', 'NetworkPolicy', 'ResourceQuota', 'LimitRange', 'PodSecurityPolicy', 'PodDisruptionBudget', 'ServiceAccount', 'Secret', 'SecretList', 'ConfigMap', 'StorageClass', 'PersistentVolume', 'PersistentVolumeClaim', 'CustomResourceDefinition', 'ClusterRole', 'ClusterRoleList', 'ClusterRoleBinding', 'ClusterRoleBindingList', 'Role', 'RoleList', 'RoleBinding', 'RoleBindingList', 'Service', 'DaemonSet', 'Pod', 'ReplicationController', 'ReplicaSet', 'Deployment', 'HorizontalPodAutoscaler', 'StatefulSet', 'Job', 'CronJob', 'IngressClass', 'Ingress', 'APIService'];

interface Rendered { manifest: string; notes: string; objects: KubeObject[] }

function renderChart(chart: Chart, rel: { name: string; namespace: string; revision: number; isInstall: boolean }, values: Record<string, Val>, phase: string): Rendered {
  const defines: Record<string, Node[]> = {};
  const root = { Values: values, Release: { Name: rel.name, Namespace: rel.namespace, Revision: rel.revision, Service: 'Helm', IsInstall: rel.isInstall, IsUpgrade: !rel.isInstall }, Chart: { Name: chart.name, Version: chart.version, AppVersion: chart.appVersion }, Capabilities: { KubeVersion: { Version: 'v1.32.3', Major: '1', Minor: '32' } }, Template: { Name: '', BasePath: `${chart.name}/templates` } };
  const parsed: { path: string; nodes: Node[] }[] = [];
  for (const t of chart.templates) {
    try { parsed.push({ path: t.path, nodes: parseTemplate(t.text, defines) }); }
    catch (e) { if (e instanceof HelmError) throw new HelmError(`${phase}: ${e.message.replace('FILE', t.path)}`); throw e; }
  }
  const docs: { path: string; text: string; obj: KubeObject }[] = [];
  let notes = '';
  for (const t of parsed) {
    const base = t.path.split('/').pop() as string;
    if (base.startsWith('_')) continue;
    let textOut: string;
    try { textOut = render(t.nodes, { dot: { ...root, Template: { ...root.Template, Name: t.path } }, root, vars: {}, defines, file: t.path }).replace(/<no value>/g, ''); }
    catch (e) {
      if (e instanceof Unsupported) throw new HelmError(`kubequest: the template function "${e.message}" (used in ${t.path}) is not supported in the simulator yet`);
      if (e instanceof HelmError) throw new HelmError(`${phase}: ${e.message.replace(/^AT\|/, '')}`);
      throw e;
    }
    if (base === 'NOTES.txt') { notes = textOut.trim(); continue; }
    if (!/\.ya?ml$/.test(base)) continue;
    for (const piece of textOut.split(/^---\s*$/m)) {
      if (!piece.trim()) continue;
      let obj: unknown;
      try { obj = parseDocument(piece); } catch (e) { if (e instanceof YamlError) throw new HelmError(`${phase}: YAML parse error on ${t.path}: error converting YAML to JSON: yaml: ${e.message}`); throw e; }
      if (!obj || typeof obj !== 'object') continue;
      docs.push({ path: t.path, text: piece.trim(), obj: obj as KubeObject });
    }
  }
  const rank = (k: string): number => { const i = INSTALL_ORDER.indexOf(k); return i < 0 ? INSTALL_ORDER.length : i; };
  docs.sort((x, y) => rank(x.obj.kind) - rank(y.obj.kind));
  return { manifest: docs.map((d) => `---\n# Source: ${d.path}\n${d.text}\n`).join(''), notes, objects: docs.map((d) => d.obj) };
}

const secretName = (name: string, version: number): string => `sh.helm.release.v1.${name}.v${version}`;

function releases(engine: Engine, namespace?: string): Release[] {
  const list: Release[] = [];
  for (const s of engine.store.list<Secret>('Secret', namespace)) {
    if (s.type !== 'helm.sh/release.v1') continue;
    try { list.push(JSON.parse(b64decode(s.data?.release ?? '') ?? '') as Release); } catch { /* not a release */ }
  }
  return list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version - b.version));
}

function saveRelease(engine: Engine, r: Release): void {
  const name = secretName(r.name, r.version);
  const existing = engine.store.get<Secret>('Secret', r.namespace, name);
  const obj: Secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: r.namespace, labels: { modifiedAt: String(Math.floor(engine.clock.nowMs / 1000)), name: r.name, owner: 'helm', status: r.status, version: String(r.version) } }, type: 'helm.sh/release.v1', data: { release: b64encode(JSON.stringify(r)) } };
  if (existing) engine.store.update(obj); else engine.store.create(obj);
}

/** Bring the objects of a manifest into the cluster with Helm's ownership metadata. */
function applyManifest(engine: Engine, objects: KubeObject[], r: { name: string; namespace: string }, previous: KubeObject[], adopting: boolean): void {
  const key = (o: KubeObject): string => `${o.kind}|${o.metadata.namespace ?? r.namespace}|${o.metadata.name}`;
  for (const src of objects) {
    const o = structuredClone(src);
    validateStructure(o, '');
    const info = resourceByKind(o.kind);
    if (!info) throw new ApiError('NotFound', `resource mapping not found for name: "${o.metadata?.name ?? ''}" namespace: "${o.metadata?.namespace ?? ''}" from "": no matches for kind "${o.kind}" in version "${o.apiVersion}"\nensure CRDs are installed first`);
    if (info.namespaced) o.metadata.namespace = o.metadata.namespace ?? r.namespace; else delete o.metadata.namespace;
    o.metadata.labels = { ...(o.metadata.labels ?? {}), 'app.kubernetes.io/managed-by': 'Helm' };
    o.metadata.annotations = { ...(o.metadata.annotations ?? {}), 'meta.helm.sh/release-name': r.name, 'meta.helm.sh/release-namespace': r.namespace };
    const live = engine.store.get(o.kind, o.metadata.namespace, o.metadata.name);
    if (!live) { validateObject(o); const d = applyDefaults(o, engine); admit(engine, d, 'CREATE'); engine.store.create(d); continue; }
    const owned = live.metadata.labels?.['app.kubernetes.io/managed-by'] === 'Helm' && live.metadata.annotations?.['meta.helm.sh/release-name'] === r.name && live.metadata.annotations?.['meta.helm.sh/release-namespace'] === r.namespace;
    if (!owned && adopting) throw new ApiError('Conflict', `Unable to continue with install: ${o.kind} "${o.metadata.name}" in namespace "${o.metadata.namespace ?? ''}" exists and cannot be imported into the current release: invalid ownership metadata; label validation error: missing key "app.kubernetes.io/managed-by": must be set to "Helm"; annotation validation error: missing key "meta.helm.sh/release-name": must be set to "${r.name}"; annotation validation error: missing key "meta.helm.sh/release-namespace": must be set to "${r.namespace}"`);
    const merged = structuredClone(live);
    for (const k of Object.keys(o)) if (k !== 'status' && k !== 'metadata') merged[k] = o[k];
    merged.metadata.labels = o.metadata.labels; merged.metadata.annotations = o.metadata.annotations;
    validateObject(merged, live);
    applyDefaults(merged, engine);
    admit(engine, merged, 'UPDATE', { old: live });
    engine.store.update(merged, { specChanged: JSON.stringify(sortKeys(merged.spec ?? null)) !== JSON.stringify(sortKeys(live.spec ?? null)) || JSON.stringify(merged.data ?? null) !== JSON.stringify(live.data ?? null) });
  }
  const keep = new Set(objects.map(key));
  for (const old of previous) {
    if (keep.has(key(old))) continue;
    const live = engine.store.get(old.kind, resourceByKind(old.kind)?.namespaced ? (old.metadata.namespace ?? r.namespace) : undefined, old.metadata.name);
    if (!live) continue;
    if (live.kind === 'Pod') engine.store.markDeleting(live, (live as Pod).spec.terminationGracePeriodSeconds ?? 30); else engine.store.remove(live);
  }
}

function manifestObjects(manifest: string): KubeObject[] {
  try { return parseAllDocuments(manifest).filter((d) => d && typeof d === 'object') as KubeObject[]; } catch { return []; }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function ansic(ms: number): string {
  const d = new Date(ms);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}
function goTime(ms: number): string {
  const iso = new Date(ms).toISOString();
  const frac = iso.slice(20, 23).replace(/0+$/, '');
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}${frac ? `.${frac}` : ''} +0000 UTC`;
}
/** gosuri/uitable: every cell (the last included) is padded to its column width, cells are joined with a tab. */
function uitable(rows: string[][]): string {
  const widths = (rows[0] as string[]).map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length)));
  return rows.map((r) => r.map((cell, c) => cell.padEnd(widths[c] as number)).join('\t')).join('\n') + '\n';
}
function statusBlock(r: Release): string {
  return `NAME: ${r.name}\nLAST DEPLOYED: ${ansic(r.last)}\nNAMESPACE: ${r.namespace}\nSTATUS: ${r.status}\nREVISION: ${r.version}\nTEST SUITE: None\n${r.notes ? `NOTES:\n${r.notes}\n` : ''}`;
}

const VALUE_FLAGS = ['-n', '--namespace', '-f', '--values', '--set', '--set-string', '--version', '--timeout', '-o', '--output', '--max', '--description', '--kube-context', '--revision'];

export function runHelm(engine: Engine, vfs: Vfs, argv: string[]): { chunks: OutputChunk[]; code: number } {
  const flags: Record<string, string[]> = {};
  const bools = new Set<string>();
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--') && a.includes('=')) { const eq = a.indexOf('='); (flags[a.slice(0, eq)] ??= []).push(a.slice(eq + 1)); }
    else if (VALUE_FLAGS.includes(a)) (flags[a] ??= []).push(argv[++i] ?? '');
    else if (a.startsWith('-') && a.length > 1) bools.add(a);
    else pos.push(a);
  }
  const flag = (...names: string[]): string | undefined => { for (const n of names) if (flags[n]?.length) return (flags[n] as string[])[(flags[n] as string[]).length - 1]; return undefined; };
  const ns = flag('-n', '--namespace') ?? engine.currentNamespace;
  const allNs = bools.has('-A') || bools.has('--all-namespaces');
  const cmd = pos[0];
  const fail = (msg: string): { chunks: OutputChunk[]; code: number } => ({ chunks: [err(`Error: ${msg}\n`)], code: 1 });
  const ok = (textOut: string): { chunks: OutputChunk[]; code: number } => ({ chunks: [out(textOut)], code: 0 });
  const userValues = (): Record<string, Val> => {
    let v: Record<string, Val> = {};
    for (const f of [...(flags['-f'] ?? []), ...(flags['--values'] ?? [])]) {
      const t = vfs.read(f);
      if (t === undefined) throw new HelmError(`open ${f}: no such file or directory`);
      v = deepMerge(v, parseDocument(t) ?? {}) as Record<string, Val>;
    }
    for (const s of [...(flags['--set'] ?? []), ...(flags['--set-string'] ?? [])]) setValue(v, s);
    return v;
  };
  const history = (name: string): Release[] => releases(engine, ns).filter((r) => r.name === name);
  const current = (name: string): Release | undefined => { const h = history(name); return h[h.length - 1]; };
  try {
    switch (cmd) {
      case undefined: case 'help': case '--help':
        return ok('The Kubernetes package manager\n\nkubequest supports: install, upgrade, rollback, uninstall, list, history, status, get (values|manifest|notes), template, show (values|chart), lint, version\nCharts are local directories (Chart.yaml, values.yaml, templates/).\n');
      case 'version': return ok('version.BuildInfo{Version:"v3.17.0", GitCommit:"301108edc7ac2a8ba79e4ebf5701b0b6ce6a31e4", GitTreeState:"clean", GoVersion:"go1.23.4"}\n');
      case 'repo': case 'search': case 'pull': case 'push': case 'dependency': case 'plugin': case 'registry': case 'package': case 'test': case 'create': case 'env':
        return { chunks: [err(`kubequest: \`helm ${cmd}\` is not simulated — charts are local directories on this workstation\n`)], code: 1 };
      case 'list': case 'ls': {
        const latest = new Map<string, Release>();
        for (const r of releases(engine, allNs ? undefined : ns)) latest.set(`${r.namespace}/${r.name}`, r);
        const rows = [['NAME', 'NAMESPACE', 'REVISION', 'UPDATED', 'STATUS', 'CHART', 'APP VERSION']];
        for (const r of latest.values()) if (r.status !== 'uninstalled') rows.push([r.name, r.namespace, String(r.version), goTime(r.last), r.status, `${r.chart.name}-${r.chart.version}`, r.chart.appVersion]);
        return ok(uitable(rows));
      }
      case 'install': case 'upgrade': case 'template': {
        let name = pos[1], ref = pos[2];
        if (cmd === 'template' && ref === undefined) { ref = name; name = 'release-name'; }
        if (!name || !ref) return fail(cmd === 'install' ? 'INSTALLATION FAILED: must either provide a name or specify --generate-name' : `"helm ${cmd}" requires 2 arguments\n\nUsage:  helm ${cmd} [RELEASE] [CHART] [flags]`);
        const phase = cmd === 'install' ? 'INSTALLATION FAILED' : cmd === 'upgrade' ? 'UPGRADE FAILED' : 'TEMPLATE';
        let chart: Chart;
        try { chart = loadChart(vfs, ref); } catch (e) { if (e instanceof HelmError) return fail(cmd === 'template' ? e.message : `${phase}: ${e.message}`); throw e; }
        const prev = cmd === 'template' ? undefined : current(name);
        const live = prev && prev.status !== 'uninstalled' ? prev : undefined;
        const installing = cmd === 'install' || (cmd === 'upgrade' && !live);
        if (cmd === 'install' && live) return fail('INSTALLATION FAILED: cannot re-use a name that is still in use');
        if (cmd === 'upgrade' && !live && !bools.has('--install') && !bools.has('-i')) return fail(`UPGRADE FAILED: "${name}" has no deployed releases`);
        const config = cmd === 'upgrade' && live && bools.has('--reuse-values') ? (deepMerge(live.config, userValues()) as Record<string, Val>) : userValues();
        const values = deepMerge(chart.values, config) as Record<string, Val>;
        const version = (prev?.version ?? 0) + 1;
        const isTemplate = cmd === 'template';
        let r: Rendered;
        try { r = renderChart(chart, { name, namespace: ns, revision: version, isInstall: installing }, values, installing && !isTemplate ? 'INSTALLATION FAILED' : phase); }
        catch (e) { if (e instanceof HelmError) return fail(isTemplate ? `${e.message.replace(/^TEMPLATE: /, '')}\n\nUse --debug flag to render out invalid YAML` : e.message); throw e; }
        if (isTemplate) return ok(r.manifest);
        const phaseNow = installing ? 'INSTALLATION FAILED' : 'UPGRADE FAILED';
        const rel: Release = { name, namespace: ns, version, status: 'deployed', chart: { name: chart.name, version: chart.version, appVersion: chart.appVersion }, config, manifest: r.manifest, notes: r.notes, first: live?.first ?? engine.clock.nowMs, last: engine.clock.nowMs, description: installing ? 'Install complete' : 'Upgrade complete' };
        const dry = bools.has('--dry-run') || flags['--dry-run'] !== undefined;
        if (!dry) {
          if (!engine.store.get('Namespace', undefined, ns)) {
            if (bools.has('--create-namespace')) engine.ensureNamespace(ns);
            else return fail(`${phaseNow}: create: failed to create: namespaces "${ns}" not found`);
          }
          try { applyManifest(engine, r.objects, rel, live ? manifestObjects(live.manifest) : [], installing); }
          catch (e) {
            if (e instanceof ValidationError) return fail(`${phaseNow}: unable to build kubernetes objects from release manifest: ${e.message.startsWith('error validating') ? `error validating "": ${e.message}` : e.message}`);
            if (e instanceof ApiError) {
              // a failed upgrade is recorded as a failed revision; the previous one stays deployed
              if (!installing) saveRelease(engine, { ...rel, status: 'failed', description: `Upgrade "${name}" failed: ${e.message}` });
              return fail(`${phaseNow}: ${e.message}`);
            }
            throw e;
          }
          if (live) saveRelease(engine, { ...live, status: 'superseded' });
          saveRelease(engine, rel);
        }
        const head = cmd === 'upgrade' ? (installing ? `Release "${name}" does not exist. Installing it now.\n` : `Release "${name}" has been upgraded. Happy Helming!\n`) : '';
        return ok(head + statusBlock(dry ? { ...rel, status: 'pending-install' } : rel) + (dry ? `HOOKS:\nMANIFEST:\n${r.manifest}` : ''));
      }
      case 'rollback': {
        const name = pos[1];
        if (!name) return fail('"helm rollback" requires at least 1 argument\n\nUsage:  helm rollback <RELEASE> [REVISION] [flags]');
        const h = history(name);
        const cur = h[h.length - 1];
        if (!cur) return fail('release: not found');
        const deployed = [...h].reverse().find((x) => x.status === 'deployed') ?? cur;
        const wanted = pos[2] !== undefined ? parseInt(pos[2], 10) : ([...h].reverse().find((x) => x.version < deployed.version && (x.status === 'superseded' || x.status === 'deployed'))?.version ?? deployed.version - 1);
        const target = h.find((x) => x.version === wanted);
        if (!target) return fail(`release has no ${wanted} version`);
        const rel: Release = { ...target, version: cur.version + 1, status: 'deployed', last: engine.clock.nowMs, description: `Rollback to ${target.version}` };
        try { applyManifest(engine, manifestObjects(target.manifest), rel, manifestObjects(deployed.manifest), false); }
        catch (e) { if (e instanceof ApiError || e instanceof ValidationError) return fail(e.message); throw e; }
        saveRelease(engine, { ...deployed, status: 'superseded' });
        saveRelease(engine, rel);
        return ok('Rollback was a success! Happy Helming!\n');
      }
      case 'uninstall': case 'delete': case 'del': case 'un': {
        const name = pos[1];
        if (!name) return fail('"helm uninstall" requires at least 1 argument\n\nUsage:  helm uninstall RELEASE_NAME [...] [flags]');
        const cur = current(name);
        if (!cur) return fail(`uninstall: Release not loaded: ${name}: release: not found`);
        applyManifest(engine, [], cur, manifestObjects(cur.manifest), false);
        for (const r of history(name)) { const s = engine.store.get('Secret', r.namespace, secretName(r.name, r.version)); if (s) engine.store.remove(s); }
        return ok(`release "${name}" uninstalled\n`);
      }
      case 'history': case 'hist': {
        const name = pos[1];
        const h = name ? history(name) : [];
        if (!h.length) return fail('release: not found');
        return ok(uitable([['REVISION', 'UPDATED', 'STATUS', 'CHART', 'APP VERSION', 'DESCRIPTION'], ...h.map((r) => [String(r.version), ansic(r.last), r.status, `${r.chart.name}-${r.chart.version}`, r.chart.appVersion, r.description])]));
      }
      case 'status': {
        const cur = pos[1] ? current(pos[1]) : undefined;
        return cur ? ok(statusBlock(cur)) : fail('release: not found');
      }
      case 'get': {
        const what = pos[1], cur = pos[2] ? current(pos[2]) : undefined;
        if (!what || !['values', 'manifest', 'notes', 'all'].includes(what)) return fail(`unknown command "${what ?? ''}" for "helm get"`);
        if (!cur) return fail('release: not found');
        if (what === 'manifest') return ok(cur.manifest + '\n');
        if (what === 'notes') return ok(`NOTES:\n${cur.notes}\n`);
        if (bools.has('-a') || bools.has('--all')) return ok(`COMPUTED VALUES:\n${toYaml(deepMerge(loadChartValues(vfs, cur), cur.config))}\n`);
        return ok(`USER-SUPPLIED VALUES:\n${Object.keys(cur.config).length ? toYaml(cur.config) : 'null'}\n`);
      }
      case 'show': case 'inspect': {
        const what = pos[1], ref = pos[2];
        if (!what || !ref) return fail('"helm show" requires a subcommand (values, chart) and a chart');
        const chart = loadChart(vfs, ref);
        if (what === 'values') return ok(chart.rawValues);
        if (what === 'chart') return ok(vfs.read(`${chart.dir}/Chart.yaml`) ?? '');
        return fail(`kubequest: \`helm show ${what}\` is not simulated`);
      }
      case 'lint': {
        const ref = pos[1] ?? '.';
        let chart: Chart;
        try { chart = loadChart(vfs, ref); } catch (e) { if (e instanceof HelmError) return { chunks: [out(`==> Linting ${ref}\n[ERROR] Chart.yaml: ${e.message}\n\n`), err('Error: 1 chart(s) linted, 1 chart(s) failed\n')], code: 1 }; throw e; }
        try { renderChart(chart, { name: 'test-release', namespace: ns, revision: 1, isInstall: true }, deepMerge(chart.values, userValues()) as Record<string, Val>, 'lint'); }
        catch (e) { if (e instanceof HelmError) return { chunks: [out(`==> Linting ${ref}\n[INFO] Chart.yaml: icon is recommended\n[ERROR] templates/: ${e.message.replace(/^lint: /, '')}\n\n`), err('Error: 1 chart(s) linted, 1 chart(s) failed\n')], code: 1 }; throw e; }
        return ok(`==> Linting ${ref}\n[INFO] Chart.yaml: icon is recommended\n\n1 chart(s) linted, 0 chart(s) failed\n`);
      }
      default:
        return { chunks: [err(`Error: unknown command "${cmd}" for "helm"\nRun 'helm --help' for usage.\n`)], code: 1 };
    }
  } catch (e) {
    if (e instanceof HelmError) return fail(e.message);
    if (e instanceof ValidationError) return fail(e.message);
    throw e;
  }
}

function loadChartValues(vfs: Vfs, r: Release): Record<string, Val> {
  // computed values need the chart defaults; charts live on the workstation under charts/<name> by convention
  for (const dir of [`charts/${r.chart.name}`, r.chart.name, `./${r.chart.name}`]) { try { return loadChart(vfs, dir).values; } catch { /* try next */ } }
  return {};
}
