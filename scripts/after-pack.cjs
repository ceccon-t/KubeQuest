/**
 * electron-builder afterPack hook (CommonJS because electron-builder loads
 * hooks with require()). On Linux, replaces the app binary with a launcher
 * that decides at runtime whether Chromium's sandbox can work:
 *
 * - SUID helper usable (deb install: chrome-sandbox is root-owned, mode 4755)
 *   → run sandboxed.
 * - Unprivileged user namespaces available → run sandboxed.
 * - Neither (e.g. an AppImage on Ubuntu 23.10+, whose AppArmor policy blocks
 *   userns for unconfined binaries, and whose mount can't hold a SUID helper)
 *   → warn and fall back to --no-sandbox instead of aborting at startup.
 *
 * This is the packaged-app counterpart of the dev-time check in scripts/start.mjs.
 */
const { chmodSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const launcherFor = (binaryName) => `#!/bin/bash
set -u
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
BINARY="$HERE/${binaryName}"

sandbox_available() {
  local helper="$HERE/chrome-sandbox"
  if [ -u "$helper" ] && [ "$(stat -c %u "$helper" 2>/dev/null)" = "0" ]; then
    return 0
  fi
  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ]; then
    return 1
  fi
  if [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = "0" ]; then
    return 1
  fi
  if [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null)" = "0" ]; then
    return 1
  fi
  return 0
}

if sandbox_available; then
  exec "$BINARY" "$@"
fi
echo "Kubequest: no usable Chromium sandbox on this system; running with --no-sandbox." >&2
exec "$BINARY" --no-sandbox "$@"
`;

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const executableName = context.packager.executableName;
  const executablePath = join(context.appOutDir, executableName);
  const binaryPath = join(context.appOutDir, `${executableName}.bin`);
  renameSync(executablePath, binaryPath);
  writeFileSync(executablePath, launcherFor(`${executableName}.bin`));
  chmodSync(executablePath, 0o755);
};
