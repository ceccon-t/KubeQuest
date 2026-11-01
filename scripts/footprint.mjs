// Verify that nothing was written outside the project folder by the usual dev/play flows (AGENTS.md §1.3).
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const home = os.homedir();
const suspects = [
  ['~/.cache/electron', path.join(home, '.cache', 'electron')],
  ['~/.config/kubequest', path.join(home, '.config', 'kubequest')],
  ['~/.config/Kubequest', path.join(home, '.config', 'Kubequest')],
  ['~/Library/Application Support/kubequest', path.join(home, 'Library', 'Application Support', 'kubequest')],
  ['%APPDATA%/kubequest', path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'kubequest')],
];
const since = Date.now() - 1000 * 60 * 60 * 24; // touched in the last 24h
let dirty = false;
for (const [label, p] of suspects) {
  try {
    const s = await stat(p);
    const recent = s.mtimeMs > since;
    console.log(`${recent ? '⚠' : '·'} ${label} exists (modified ${new Date(s.mtimeMs).toISOString()})${recent ? ' — written recently' : ' — pre-existing, not touched by this project'}`);
    if (recent) dirty = true;
  } catch {
    console.log(`✓ ${label} absent`);
  }
}
console.log(`\nProject-local footprint: ${path.relative(home, root)} (node_modules, .cache, dist, data all inside).`);
console.log(dirty ? 'Result: something outside the folder changed recently — investigate.' : 'Result: clean — delete the folder to remove everything.');
process.exit(dirty ? 1 : 0);
