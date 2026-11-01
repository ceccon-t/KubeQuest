// Launch the desktop app. On Linux hosts where Chromium's SUID sandbox helper cannot be used
// (unprivileged user namespaces restricted, e.g. Ubuntu 23.10+ with AppArmor), fall back to
// --no-sandbox instead of asking the player to chown files as root (AGENTS.md §1.3: never touch the host).
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron'); // path to the binary
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = ['.', ...process.argv.slice(2)];

if (process.platform === 'linux') {
  try {
    const helper = path.join(path.dirname(electron), 'chrome-sandbox');
    const s = await stat(helper);
    const setuidRoot = s.uid === 0 && (s.mode & 0o4000) !== 0;
    let usernsOk = true;
    try {
      const { readFile } = await import('node:fs/promises');
      const v = (await readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').catch(() => '0')).trim();
      const c = (await readFile('/proc/sys/kernel/unprivileged_userns_clone', 'utf8').catch(() => '1')).trim();
      usernsOk = v !== '1' && c !== '0';
    } catch { /* keep default */ }
    if (!setuidRoot && !usernsOk) {
      console.log('kubequest: this Linux restricts unprivileged user namespaces; starting Electron with --no-sandbox (the renderer stays context-isolated and loads only local files).');
      args.unshift('--no-sandbox');
    }
  } catch { /* no helper present: Electron decides */ }
}

const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
const child = spawn(electron, args, { cwd: root, stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
