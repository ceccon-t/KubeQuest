/** Shell tokenizer and pflag-compatible flag parsing with upstream error strings. */

export class KubectlError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** Split a command line into tokens honouring quotes and backslashes. Returns null on unterminated quote. */
export function tokenize(line: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  let has = false;
  while (i < line.length) {
    const ch = line[i] as string;
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += line.slice(i + 1, end);
      has = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let s = '';
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && j + 1 < line.length && /["\\$`]/.test(line[j + 1] as string)) { s += line[j + 1]; j += 2; continue; }
        s += line[j];
        j++;
      }
      if (j >= line.length) return null;
      cur += s;
      has = true;
      i = j + 1;
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) {
      cur += line[i + 1];
      has = true;
      i += 2;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) { out.push(cur); cur = ''; has = false; }
      i++;
      continue;
    }
    cur += ch;
    has = true;
    i++;
  }
  if (has) out.push(cur);
  return out;
}

export type FlagType = 'bool' | 'string' | 'strings' | 'int';

export interface FlagSpec {
  name: string;
  short?: string;
  type: FlagType;
  /** Default value for strings/ints. */
  def?: string | number | boolean;
  /** Flag accepts `--flag` without a value (e.g. --dry-run defaults to "unchanged"). */
  noOptDefault?: string;
}

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | string[] | number | boolean | undefined>;
  /** Arguments after `--`. */
  rest: string[];
}

/** Global flags accepted by every kubectl command. */
export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: 'namespace', short: 'n', type: 'string' },
  { name: 'context', type: 'string' },
  { name: 'kubeconfig', type: 'string' },
  { name: 'v', type: 'int' },
  { name: 'request-timeout', type: 'string' },
  { name: 'warnings-as-errors', type: 'bool' },
];

export function parseFlags(tokens: string[], specs: FlagSpec[], opts: { allowRest?: boolean; stopAtFirstPositional?: boolean } = {}): ParsedArgs {
  const all = [...GLOBAL_FLAGS, ...specs];
  const byName = new Map<string, FlagSpec>();
  const byShort = new Map<string, FlagSpec>();
  for (const s of all) {
    byName.set(s.name, s);
    if (s.short) byShort.set(s.short, s);
  }
  const flags: ParsedArgs['flags'] = {};
  for (const s of all) if (s.def !== undefined) flags[s.name] = s.def;
  const positional: string[] = [];
  const rest: string[] = [];
  let i = 0;
  const setVal = (spec: FlagSpec, raw: string | undefined, flagText: string): void => {
    if (spec.type === 'bool') {
      if (raw === undefined || raw === '') { flags[spec.name] = true; return; }
      if (raw === 'true' || raw === 'false') { flags[spec.name] = raw === 'true'; return; }
      throw new KubectlError(`invalid argument "${raw}" for "${flagText}" flag: strconv.ParseBool: parsing "${raw}": invalid syntax`);
    }
    if (raw === undefined) throw new KubectlError(`flag needs an argument: ${flagText}`);
    if (spec.type === 'int') {
      if (!/^-?\d+$/.test(raw)) throw new KubectlError(`invalid argument "${raw}" for "${flagText}" flag: strconv.ParseInt: parsing "${raw}": invalid syntax`);
      flags[spec.name] = parseInt(raw, 10);
      return;
    }
    if (spec.type === 'strings') {
      const prev = (flags[spec.name] as string[] | undefined) ?? [];
      flags[spec.name] = [...prev, ...(raw === '' ? [''] : [raw])];
      return;
    }
    flags[spec.name] = raw;
  };
  while (i < tokens.length) {
    const t = tokens[i] as string;
    if (t === '--') { rest.push(...tokens.slice(i + 1)); break; }
    if (t.startsWith('--') && t.length > 2) {
      const eq = t.indexOf('=');
      const name = eq >= 0 ? t.slice(2, eq) : t.slice(2);
      const spec = byName.get(name);
      if (!spec) throw new KubectlError(`unknown flag: --${name}`);
      if (eq >= 0) setVal(spec, t.slice(eq + 1), `--${name}`);
      else if (spec.type === 'bool') setVal(spec, undefined, `--${name}`);
      else if (spec.noOptDefault !== undefined && (i + 1 >= tokens.length || (tokens[i + 1] as string).startsWith('-'))) flags[spec.name] = spec.noOptDefault;
      else { setVal(spec, tokens[i + 1], `--${name}`); i++; }
      i++;
      continue;
    }
    if (t.startsWith('-') && t.length > 1 && t !== '-' && !/^-\d/.test(t)) {
      // short flags, possibly combined: -it, -n ns, -nkube-system, -o=yaml
      let j = 1;
      while (j < t.length) {
        const ch = t[j] as string;
        const spec = byShort.get(ch);
        if (!spec) throw new KubectlError(`unknown shorthand flag: '${ch}' in -${t.slice(1)}`);
        if (spec.type === 'bool') { setVal(spec, undefined, `-${ch}`); j++; continue; }
        let val: string | undefined;
        if (j + 1 < t.length) { val = t.slice(j + 1); if (val.startsWith('=')) val = val.slice(1); }
        else { val = tokens[i + 1]; i++; }
        setVal(spec, val, `-${ch}`);
        break;
      }
      i++;
      continue;
    }
    positional.push(t);
    if (opts.stopAtFirstPositional) { rest.push(...tokens.slice(i + 1)); break; }
    i++;
  }
  void opts.allowRest;
  return { positional, flags, rest };
}

export function str(p: ParsedArgs, name: string): string | undefined {
  const v = p.flags[name];
  return typeof v === 'string' ? v : undefined;
}
export function bool(p: ParsedArgs, name: string): boolean {
  return p.flags[name] === true;
}
export function int(p: ParsedArgs, name: string): number | undefined {
  const v = p.flags[name];
  return typeof v === 'number' ? v : undefined;
}
export function strs(p: ParsedArgs, name: string): string[] {
  const v = p.flags[name];
  return Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
}
