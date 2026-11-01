/**
 * Runs electron-builder with its cache kept inside the repo (.cache/), per the
 * host-cleanliness rule (AGENTS.md §1.3). ELECTRON_BUILDER_CACHE must be an absolute
 * path — relative values break electron-builder's archive extraction — which a plain
 * npm-script env assignment cannot express portably.
 * Usage: node scripts/package.mjs --linux|--win|--mac
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const builderCli = require.resolve('electron-builder/out/cli/cli.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const result = spawnSync(
  process.execPath,
  [builderCli, '--publish', 'never', ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_BUILDER_CACHE: path.join(root, '.cache', 'electron-builder') },
  },
);
process.exit(result.status ?? 1);
