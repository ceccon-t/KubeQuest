import type { KubectlCommand, CommandContext, OutputChunk } from '../context.ts';
import { out, err } from '../context.ts';
import { str, bool, strs, KubectlError } from '../args.ts';
import { parseResourceArgs, fetch, getPath, type ResourceRef } from '../resources.ts';
import { buildTable, renderTable } from '../printers.ts';
import { parseOutputFlag, renderObjects } from '../output.ts';
import type { KubeObject } from '../../types.ts';
import { tabwrite } from '../tabwriter.ts';
import { stringify, toJsonPretty } from '../../yaml.ts';
import { forOutput } from '../output.ts';

function sortObjects(objs: KubeObject[], sortBy: string | undefined): KubeObject[] {
  if (!sortBy) return objs;
  const path = sortBy.replace(/^\{|\}$/g, '');
  return [...objs].sort((a, b) => {
    const va = getPath(a, path), vb = getPath(b, path);
    if (typeof va === 'number' && typeof vb === 'number') return va - vb;
    const sa = String(va ?? ''), sb = String(vb ?? '');
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
}

function renderTableText(t: { headers: string[]; rows: string[][] }, noHeaders: boolean): string {
  const rows = noHeaders ? t.rows : [t.headers, ...t.rows];
  if (!rows.length) return '';
  return tabwrite(rows.map((r) => r.join('\t')).join('\n') + '\n', { minwidth: 6, tabwidth: 4, padding: 3 });
}

export const getCommand: KubectlCommand = {
  name: 'get',
  summary: 'Display one or many resources',
  usage: 'kubectl get [(-o|--output=)json|yaml|name|wide|jsonpath=...] (TYPE[.VERSION][.GROUP] [NAME | -l label] | TYPE[.VERSION][.GROUP]/NAME ...) [flags]',
  flags: [
    { name: 'output', short: 'o', type: 'string' },
    { name: 'all-namespaces', short: 'A', type: 'bool' },
    { name: 'selector', short: 'l', type: 'string' },
    { name: 'field-selector', type: 'string' },
    { name: 'show-labels', type: 'bool' },
    { name: 'label-columns', short: 'L', type: 'strings' },
    { name: 'no-headers', type: 'bool' },
    { name: 'sort-by', type: 'string' },
    { name: 'watch', short: 'w', type: 'bool' },
    { name: 'watch-only', type: 'bool' },
    { name: 'show-kind', type: 'bool' },
    { name: 'ignore-not-found', type: 'bool' },
    { name: 'filename', short: 'f', type: 'strings' },
    { name: 'chunk-size', type: 'int' },
    { name: 'show-managed-fields', type: 'bool' },
  ],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    const files = strs(a, 'filename');
    if (files.length) throw new KubectlError('kubequest: `get -f` is not supported in the simulator yet');
    if (a.positional.length === 0) throw new KubectlError(`You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.`);
    const refs = parseResourceArgs(a.positional, { allowAll: true });
    const fmt = parseOutputFlag(str(a, 'output'));
    const allNs = bool(a, 'all-namespaces') || ctx.allNamespaces;
    const selector = str(a, 'selector');
    const fieldSel = str(a, 'field-selector');
    const ignoreNotFound = bool(a, 'ignore-not-found');
    const single = refs.length === 1 && refs[0]!.name !== undefined;
    const multiKind = new Set(refs.map((r) => r.info.kind)).size > 1 || a.positional[0] === 'all';
    const collect = (): { ref: ResourceRef; objs: KubeObject[] }[] => {
      const groups: { ref: ResourceRef; objs: KubeObject[] }[] = [];
      for (const ref of refs) {
        let objs: KubeObject[];
        try { objs = fetch(ctx.engine, ref, ctx.namespace, allNs, selector, fieldSel); }
        catch (e) { if (ignoreNotFound && e instanceof KubectlError && e.message.includes('NotFound')) continue; throw e; }
        groups.push({ ref, objs: sortObjects(objs, str(a, 'sort-by')) });
      }
      return groups;
    };
    const groups = collect();
    const allObjs = groups.flatMap((g) => g.objs);
    const noneMsg = `No resources found${allNs || groups.every((g) => !g.ref.info.namespaced) ? '' : ` in ${ctx.namespace} namespace`}.\n`;

    if (fmt.kind !== 'table') {
      if (allObjs.length === 0 && fmt.kind !== 'name') {
        if (single) return 0;
        if (fmt.kind === 'yaml') { yield out(stringify({ apiVersion: 'v1', items: [], kind: 'List', metadata: { resourceVersion: '' } })); return 0; }
        if (fmt.kind === 'json') { yield out(toJsonPretty({ apiVersion: 'v1', items: [], kind: 'List', metadata: { resourceVersion: '' } }) + '\n'); return 0; }
      }
      if (allObjs.length === 0) { yield err(noneMsg); return 0; }
      yield out(renderObjects(fmt, allObjs, single));
      void forOutput;
      return 0;
    }

    const printOpts = { wide: fmt.wide, showLabels: bool(a, 'show-labels'), labelColumns: strs(a, 'label-columns').flatMap((l) => l.split(',')), withNamespace: allNs, withKind: multiKind || bool(a, 'show-kind'), nowMs: ctx.engine.clock.nowMs };
    const noHeaders = bool(a, 'no-headers');
    const watch = bool(a, 'watch') || bool(a, 'watch-only');
    if (allObjs.length === 0 && !watch) { yield err(noneMsg); return 0; }
    let first = true;
    const seenRv = new Map<string, string>();
    if (!bool(a, 'watch-only')) {
      for (const g of groups) {
        if (g.objs.length === 0) continue;
        if (!first) yield out('\n');
        first = false;
        yield out(renderTableText(buildTable(g.ref.info.kind, g.objs, printOpts), noHeaders));
        for (const o of g.objs) seenRv.set(o.metadata.uid as string, o.metadata.resourceVersion as string);
      }
    }
    if (!watch) return 0;
    // watch: print changed rows as they happen until Ctrl+C
    while (!ctx.host.aborted()) {
      await ctx.host.sleep(300);
      const now = collect();
      for (const g of now) {
        for (const o of g.objs) {
          const uid = o.metadata.uid as string;
          if (seenRv.get(uid) !== o.metadata.resourceVersion) {
            seenRv.set(uid, o.metadata.resourceVersion as string);
            yield out(renderTableText(buildTable(g.ref.info.kind, [o], { ...printOpts, nowMs: ctx.engine.clock.nowMs }), true));
          }
        }
      }
      void renderTable;
    }
    return 0;
  },
};
