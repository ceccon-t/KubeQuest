/** Preload: exposes a tiny storage bridge to the renderer (contextIsolation on). */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('kubequest', {
  platform: process.platform,
  version: (): Promise<string> => ipcRenderer.invoke('app:version'),
  storage: {
    read: (key: string): Promise<string | null> => ipcRenderer.invoke('storage:read', key),
    write: (key: string, value: string): Promise<void> => ipcRenderer.invoke('storage:write', key, value),
  },
});
