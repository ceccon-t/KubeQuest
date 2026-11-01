/** Command execution contracts shared by kubectl commands, the shell and the host (UI or tests). */
import type { Engine } from '../engine.ts';
import type { Vfs } from '../vfs.ts';
import type { FlagSpec, ParsedArgs } from './args.ts';

export interface OutputChunk {
  text: string;
  stream?: 'stdout' | 'stderr';
}

/** What the environment provides to long-running / interactive commands. */
export interface ShellHost {
  /** Wait for game time to pass (UI: real time while the engine ticks; tests: advance the engine). */
  sleep(ms: number): Promise<void>;
  /** Sleep used by background jobs (`cmd &`): must yield to the event loop without driving the engine. */
  backgroundSleep(ms: number): Promise<void>;
  /** Open the editor with initial text; resolves with the new text, or null if cancelled. */
  editor(initial: string, filename: string): Promise<string | null>;
  /** Read a line of interactive input (exec -it). Null = EOF / Ctrl+D. */
  readLine(prompt: string): Promise<string | null>;
  /** True once the user pressed Ctrl+C. */
  aborted(): boolean;
}

export interface CommandContext {
  engine: Engine;
  host: ShellHost;
  vfs: Vfs;
  args: ParsedArgs;
  /** Namespace to operate in (after -n / context defaults). */
  namespace: string;
  /** Whether -n was given explicitly. */
  namespaceExplicit: boolean;
  allNamespaces: boolean;
  /** The full command line as typed (for change-cause / history). */
  cmdline: string;
  /** Piped stdin, when the shell provided one. */
  stdin?: string;
}

export type CommandRun = (ctx: CommandContext) => AsyncGenerator<OutputChunk, number>;

export interface KubectlCommand {
  name: string;
  aliases?: string[];
  summary: string;
  usage: string;
  flags: FlagSpec[];
  /** Stop parsing flags at the first positional (exec/run style: `-- cmd args`). */
  stopAtFirstPositional?: boolean;
  run: CommandRun;
}

export const out = (text: string): OutputChunk => ({ text, stream: 'stdout' });
export const err = (text: string): OutputChunk => ({ text, stream: 'stderr' });
