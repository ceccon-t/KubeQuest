/** Honest handling of known-but-unimplemented kubectl functionality (AGENTS.md §1.1). */
import { KubectlError } from './args.ts';

export const KNOWN_UNSUPPORTED_COMMANDS = ['diff', 'replace', 'certificate', 'attach', 'proxy', 'cp', 'plugin', 'events', 'completion', 'options', 'alpha', 'ctx', 'ns'];

export function unsupported(what: string): KubectlError {
  return new KubectlError(`kubequest: ${what} is not supported in the simulator yet (type \`help kubectl\` for the supported command matrix)`);
}
