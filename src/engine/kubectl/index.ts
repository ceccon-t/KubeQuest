/** kubectl dispatcher: resolves the subcommand, parses flags, runs it. */
import type { Engine } from '../engine.ts';
import type { Vfs } from '../vfs.ts';
import type { KubectlCommand, OutputChunk, ShellHost, CommandContext } from './context.ts';
import { err } from './context.ts';
import { parseFlags, KubectlError, str, bool } from './args.ts';
import { ApiError } from '../store.ts';
import { ValidationError } from './validate.ts';
import { KNOWN_UNSUPPORTED_COMMANDS, unsupported } from './unsupported.ts';
import { getCommand } from './commands/get.ts';
import { describeCommand } from './commands/describe.ts';
import { applyCommand, createCommand, editCommand } from './commands/apply.ts';
import { runCommand, deleteCommand, scaleCommand, labelCommand, annotateCommand, exposeCommand } from './commands/imperative.ts';
import { rolloutCommand, setCommand } from './commands/rollout.ts';
import { logsCommand, execCommand, portForwardCommand } from './commands/logs.ts';
import { configCommand, versionCommand, clusterInfoCommand, apiResourcesCommand, explainCommand, topCommand, waitCommand, cordonCommand, uncordonCommand, drainCommand, helpCommand } from './commands/misc.ts';

export const COMMANDS: KubectlCommand[] = [
  getCommand, describeCommand, applyCommand, createCommand, editCommand, runCommand, deleteCommand, scaleCommand, labelCommand, annotateCommand,
  exposeCommand, rolloutCommand, setCommand, logsCommand, execCommand, portForwardCommand, configCommand, versionCommand, clusterInfoCommand,
  apiResourcesCommand, explainCommand, topCommand, waitCommand, cordonCommand, uncordonCommand, drainCommand, helpCommand,
];

export function findCommand(name: string): KubectlCommand | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

export async function* runKubectl(engine: Engine, vfs: Vfs, host: ShellHost, tokens: string[], cmdline: string, stdin?: string): AsyncGenerator<OutputChunk, number> {
  const sub = tokens[0];
  if (!sub || sub === '--help' || sub === '-h') {
    yield* helpCommand.run({ engine, vfs, host, args: { positional: [], flags: {}, rest: [] }, namespace: engine.currentNamespace, namespaceExplicit: false, allNamespaces: false, cmdline, stdin });
    return 0;
  }
  const cmd = findCommand(sub);
  if (!cmd) {
    if (KNOWN_UNSUPPORTED_COMMANDS.includes(sub)) { yield err(unsupported(`"kubectl ${sub}"`).message + '\n'); return 1; }
    yield err(`error: unknown command "${sub}" for "kubectl"\n\nDid you mean this?\n\t${suggest(sub)}\n\nRun 'kubectl --help' for usage.\n`);
    return 1;
  }
  try {
    const rest = tokens.slice(1);
    if (rest.includes('--help') || rest.includes('-h')) {
      yield { text: `${cmd.summary}\n\nUsage:\n  ${cmd.usage}\n\nFlags:\n${cmd.flags.map((f) => `  ${f.short ? `-${f.short}, ` : '    '}--${f.name}${f.type === 'bool' ? '' : f.type === 'int' ? '=0' : "=''"}`).join('\n')}\n`, stream: 'stdout' };
      return 0;
    }
    const args = parseFlags(rest, cmd.flags, { stopAtFirstPositional: cmd.stopAtFirstPositional });
    const nsFlag = str(args, 'namespace');
    const ctxName = str(args, 'context');
    if (ctxName !== undefined && ctxName !== engine.clusterName) throw new KubectlError(`context "${ctxName}" does not exist`);
    const ctx: CommandContext = {
      engine, vfs, host, args, cmdline, stdin,
      namespace: nsFlag ?? engine.currentNamespace,
      namespaceExplicit: nsFlag !== undefined,
      allNamespaces: bool(args, 'all-namespaces'),
    };
    return yield* cmd.run(ctx);
  } catch (e) {
    if (e instanceof KubectlError) {
      const msg = e.message.startsWith('Error from server') || e.message.startsWith('kubequest:') ? e.message : `error: ${e.message}`;
      yield err(msg + '\n');
      return e.exitCode;
    }
    if (e instanceof ApiError) { yield err(`Error from server (${e.reason}): ${e.message}\n`); return 1; }
    if (e instanceof ValidationError) { yield err(`error: ${e.message}\n`); return 1; }
    throw e;
  }
}

function suggest(sub: string): string {
  const names = COMMANDS.map((c) => c.name);
  let best = names[0] as string, bestScore = Infinity;
  for (const n of names) {
    const d = levenshtein(sub, n);
    if (d < bestScore) { bestScore = d; best = n; }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 0; j <= b.length; j++) (dp[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    (dp[i] as number[])[j] = Math.min((dp[i - 1] as number[])[j]! + 1, (dp[i] as number[])[j - 1]! + 1, (dp[i - 1] as number[])[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return (dp[a.length] as number[])[b.length] as number;
}
