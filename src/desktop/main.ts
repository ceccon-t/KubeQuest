/** Electron main process: one window, no remote content. From source it runs in portable mode (all state inside the app folder). */
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';

const appRoot = path.resolve(__dirname, '..', '..');
declare const __KQ_VERSION__: string | undefined; // injected by scripts/build.mjs
// From source (npm start): portable — everything lives under <repo>/data, never in the OS profile (AGENTS.md §1.3).
// Installed (AppImage, deb, NSIS, dmg): the app folder is read-only (asar, /opt, AppImage mount, Program Files),
// so player data goes to Electron's standard per-user data directory instead (e.g. ~/.config/kubequest).
const dataDir = app.isPackaged ? app.getPath('userData') : path.join(appRoot, 'data');

if (!app.isPackaged) {
  app.setPath('userData', path.join(dataDir, 'electron'));
  app.setPath('sessionData', path.join(dataDir, 'electron'));
  app.setPath('logs', path.join(dataDir, 'logs'));
  app.setPath('crashDumps', path.join(dataDir, 'crashes'));
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function createWindow(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b1020',
    title: 'Kubequest',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  const smoke = process.env.KQ_SMOKE; // dev: capture a screenshot and quit (used to verify the desktop shell headlessly)
  await win.loadFile(path.join(appRoot, 'dist', 'web', 'index.html'), smoke ? { query: { mission: process.env.KQ_SMOKE_MISSION ?? '3.2', script: 'kubectl get pods -n freight', ...(process.env.KQ_SMOKE_PAUSED ? { paused: '1' } : {}) } } : undefined);
  if (smoke) {
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      await mkdir(path.dirname(smoke), { recursive: true });
      await writeFile(smoke, img.toPNG());
      app.quit();
    }, 4000);
  }
}

// Version source is always package.json: packaged builds report the version baked in at build time
// (`__KQ_VERSION__`, see scripts/build.mjs); from source it is re-read on every request so edits show up live.
ipcMain.handle('app:version', async (): Promise<string> => {
  const built = typeof __KQ_VERSION__ === 'string' ? __KQ_VERSION__ : app.getVersion();
  if (app.isPackaged) return built;
  try {
    const pkg: unknown = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
    if (typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string') return pkg.version;
  } catch { /* unreadable package.json: fall back to the built version */ }
  return built;
});

ipcMain.handle('storage:read', async (_e, key: string) => {
  try {
    return await readFile(path.join(dataDir, `${safeKey(key)}.json`), 'utf8');
  } catch {
    return null;
  }
});
ipcMain.handle('storage:write', async (_e, key: string, value: string) => {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, `${safeKey(key)}.json`);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, value, 'utf8');
  await rename(tmp, file);
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
