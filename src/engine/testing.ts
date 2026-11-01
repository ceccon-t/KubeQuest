/** Helpers for tests and scripted mission solutions: a ShellHost that advances game time instead of waiting. */
import type { Engine } from './engine.ts';
import { Shell } from './shell.ts';
import { Vfs } from './vfs.ts';
import type { ShellHost, OutputChunk } from './kubectl/context.ts';

export interface ScriptedHost extends ShellHost {
  /** Queue of answers for the editor (text to save, or null to cancel). */
  editorQueue: (string | null | ((initial: string) => string | null))[];
  /** Queue of interactive lines (exec -it). */
  inputQueue: string[];
  abortFlag: boolean;
  /** Game-time budget for a single command before it is force-aborted (ms). */
  maxWaitMs: number;
  waited: number;
}

export function scriptedHost(engine: Engine): ScriptedHost {
  const host: ScriptedHost = {
    editorQueue: [],
    inputQueue: [],
    abortFlag: false,
    maxWaitMs: 10 * 60_000,
    waited: 0,
    async sleep(ms: number): Promise<void> {
      engine.advance(ms / 1000, 100);
      host.waited += ms;
      if (host.waited >= host.maxWaitMs) host.abortFlag = true;
    },
    async backgroundSleep(): Promise<void> {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
    async editor(initial: string): Promise<string | null> {
      const next = host.editorQueue.shift();
      if (next === undefined) return null;
      return typeof next === 'function' ? next(initial) : next;
    },
    async readLine(): Promise<string | null> {
      const next = host.inputQueue.shift();
      return next === undefined ? null : next;
    },
    aborted(): boolean {
      return host.abortFlag;
    },
  };
  return host;
}

export interface RunResult { stdout: string; stderr: string; code: number; output: string }

/** Run a single shell line to completion (the host fast-forwards the engine while commands wait). */
export async function runLine(shell: Shell, host: ScriptedHost, line: string): Promise<RunResult> {
  host.abortFlag = false;
  host.waited = 0;
  let stdout = '', stderr = '', output = '';
  const gen = shell.exec(line);
  let r = await gen.next();
  while (!r.done) {
    const c: OutputChunk = r.value;
    if (c.stream === 'stderr') stderr += c.text; else stdout += c.text;
    output += c.text;
    r = await gen.next();
  }
  return { stdout, stderr, code: r.value, output };
}

export function makeShell(engine: Engine, files: Record<string, string> = {}): { shell: Shell; host: ScriptedHost; vfs: Vfs } {
  const host = scriptedHost(engine);
  const vfs = new Vfs(Object.fromEntries(Object.entries(files).map(([k, v]) => [k.startsWith('/') ? k : `/home/oncall/${k}`, v])));
  const shell = new Shell(engine, vfs, host);
  return { shell, host, vfs };
}
