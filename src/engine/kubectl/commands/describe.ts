import type { KubectlCommand, CommandContext, OutputChunk } from '../context.ts';
import { out, err } from '../context.ts';
import { str, bool, KubectlError } from '../args.ts';
import { parseResourceArgs, fetch } from '../resources.ts';
import { describe } from '../describe.ts';
import type { KubeObject } from '../../types.ts';

export const describeCommand: KubectlCommand = {
  name: 'describe',
  summary: 'Show details of a specific resource or group of resources',
  usage: 'kubectl describe (-f FILENAME | TYPE [NAME_PREFIX | -l label] | TYPE/NAME) [flags]',
  flags: [
    { name: 'all-namespaces', short: 'A', type: 'bool' },
    { name: 'selector', short: 'l', type: 'string' },
    { name: 'show-events', type: 'bool', def: true },
    { name: 'filename', short: 'f', type: 'strings' },
  ],
  run: async function* (ctx: CommandContext): AsyncGenerator<OutputChunk, number> {
    const a = ctx.args;
    if (a.positional.length === 0) throw new KubectlError('You must specify the type of resource to describe. Use "kubectl api-resources" for a complete list of supported resources.');
    const refs = parseResourceArgs(a.positional);
    const allNs = bool(a, 'all-namespaces') || ctx.allNamespaces;
    const objs: KubeObject[] = [];
    for (const ref of refs) {
      if (ref.name !== undefined) {
        // describe matches by name prefix when the exact name is missing (upstream behaviour)
        try { objs.push(...fetch(ctx.engine, ref, ctx.namespace, allNs, str(a, 'selector'))); }
        catch (e) {
          if (!(e instanceof KubectlError) || !e.message.includes('NotFound')) throw e;
          const prefix = fetch(ctx.engine, { info: ref.info }, ctx.namespace, allNs, str(a, 'selector')).filter((o) => o.metadata.name.startsWith(ref.name as string));
          if (!prefix.length) throw e;
          objs.push(...prefix);
        }
      } else objs.push(...fetch(ctx.engine, ref, ctx.namespace, allNs, str(a, 'selector')));
    }
    if (objs.length === 0) { yield err(`No resources found in ${ctx.namespace} namespace.\n`); return 0; }
    let first = true;
    for (const o of objs) {
      if (!first) yield out('\n\n');
      first = false;
      yield out(describe(ctx.engine, o));
    }
    return 0;
  },
};
