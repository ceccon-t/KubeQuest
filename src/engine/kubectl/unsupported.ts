/** Honest handling of known-but-unimplemented kubectl functionality (AGENTS.md §1.1). */
import { KubectlError } from './args.ts';

export const KNOWN_UNSUPPORTED_COMMANDS = ['patch', 'diff', 'replace', 'auth', 'certificate', 'attach', 'proxy', 'cp', 'autoscale', 'taint', 'kustomize', 'plugin', 'debug', 'events', 'completion', 'options', 'alpha', 'ctx', 'ns'];

export function unsupported(what: string): KubectlError {
  return new KubectlError(`kubequest: ${what} is not supported in the simulator yet (type \`help kubectl\` for the supported command matrix)`);
}
