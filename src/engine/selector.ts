/** Label selectors: equality- and set-based string syntax (`-l`) and LabelSelector objects. */

export interface Requirement {
  key: string;
  op: 'in' | 'notin' | 'exists' | 'notexists';
  values: string[];
}

export class SelectorParseError extends Error {}

/** Parse `app=web,tier in (a,b),!canary,env!=prod`. */
export function parseSelectorString(input: string): Requirement[] {
  const reqs: Requirement[] = [];
  const s = input.trim();
  if (s === '') return reqs;
  // split on commas that are not inside parentheses
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  for (const raw of parts) {
    const p = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^([^\s!=]+)\s+(in|notin)\s+\(([^)]*)\)$/.exec(p))) {
      reqs.push({ key: m[1] as string, op: m[2] as 'in' | 'notin', values: (m[3] as string).split(',').map((v) => v.trim()).filter((v) => v !== '') });
    } else if ((m = /^([^\s!=]+)\s*(==|=|!=)\s*([^\s]*)$/.exec(p))) {
      const key = m[1] as string;
      const op = m[2];
      const v = m[3] as string;
      reqs.push({ key, op: op === '!=' ? 'notin' : 'in', values: [v] });
    } else if ((m = /^!([^\s!=]+)$/.exec(p))) {
      reqs.push({ key: m[1] as string, op: 'notexists', values: [] });
    } else if (/^[^\s!=,()]+$/.test(p)) {
      reqs.push({ key: p, op: 'exists', values: [] });
    } else {
      throw new SelectorParseError(`unable to parse requirement: found '${p}', expected: identifier`);
    }
  }
  return reqs;
}

export interface LabelSelectorObj {
  matchLabels?: Record<string, string>;
  matchExpressions?: { key: string; operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist'; values?: string[] }[];
}

export function fromLabelSelector(sel: LabelSelectorObj | undefined): Requirement[] {
  const reqs: Requirement[] = [];
  if (!sel) return reqs;
  for (const [k, v] of Object.entries(sel.matchLabels ?? {})) reqs.push({ key: k, op: 'in', values: [v] });
  for (const e of sel.matchExpressions ?? []) {
    const op = e.operator === 'In' ? 'in' : e.operator === 'NotIn' ? 'notin' : e.operator === 'Exists' ? 'exists' : 'notexists';
    reqs.push({ key: e.key, op, values: e.values ?? [] });
  }
  return reqs;
}

export function matches(reqs: Requirement[], labels: Record<string, string> | undefined): boolean {
  const l = labels ?? {};
  for (const r of reqs) {
    const has = Object.prototype.hasOwnProperty.call(l, r.key);
    switch (r.op) {
      case 'exists':
        if (!has) return false;
        break;
      case 'notexists':
        if (has) return false;
        break;
      case 'in':
        if (!has || !r.values.includes(l[r.key] as string)) return false;
        break;
      case 'notin':
        if (has && r.values.includes(l[r.key] as string)) return false;
        break;
    }
  }
  return true;
}

/** Render a LabelSelector the way `kubectl get deploy -o wide` / describe print it (`app=web,tier=api`). */
export function selectorToString(sel: LabelSelectorObj | Record<string, string> | undefined, plain = false): string {
  if (!sel) return '<none>';
  if (plain) {
    const entries = Object.entries(sel as Record<string, string>).sort(([a], [b]) => (a < b ? -1 : 1));
    return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join(',') : '<none>';
  }
  const reqs = fromLabelSelector(sel as LabelSelectorObj);
  if (reqs.length === 0) return '<none>';
  return reqs
    .map((r) => {
      switch (r.op) {
        case 'in': return r.values.length === 1 ? `${r.key}=${r.values[0]}` : `${r.key} in (${r.values.join(',')})`;
        case 'notin': return r.values.length === 1 ? `${r.key}!=${r.values[0]}` : `${r.key} notin (${r.values.join(',')})`;
        case 'exists': return r.key;
        case 'notexists': return `!${r.key}`;
      }
    })
    .join(',');
}

export function labelsToString(labels: Record<string, string> | undefined): string {
  const entries = Object.entries(labels ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join(',') : '<none>';
}
