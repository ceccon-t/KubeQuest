/** Electron main process: portable mode (all state inside the app folder), one window, no remote content. */
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';

const appRoot = path.resolve(__dirname, '..', '..');
const dataDir = path.join(appRoot, 'data');

// Portable: Electron's own caches/user data live under <app>/data, never in the OS profile.
app.setPath('userData', path.join(dataDir, 'electron'));
app.setPath('sessionData', path.join(dataDir, 'electron'));
app.setPath('logs', path.join(dataDir, 'logs'));
app.setPath('crashDumps', path.join(dataDir, 'crashes'));

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
