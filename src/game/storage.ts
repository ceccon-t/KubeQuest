/** Persistence boundary: the desktop shell writes a JSON file under <app>/data; the browser uses localStorage. */

export interface Storage {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
}

export class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  async load(key: string): Promise<string | null> {
    return this.m.get(key) ?? null;
  }
  async save(key: string, value: string): Promise<void> {
    this.m.set(key, value);
  }
}

export class LocalStorage implements Storage {
  private prefix: string;
  constructor(prefix = 'kubequest:') {
    this.prefix = prefix;
  }
  async load(key: string): Promise<string | null> {
    try { return globalThis.localStorage?.getItem(this.prefix + key) ?? null; } catch { return null; }
  }
  async save(key: string, value: string): Promise<void> {
    try { globalThis.localStorage?.setItem(this.prefix + key, value); } catch { /* storage unavailable (private mode) */ }
  }
}

export interface DesktopBridge {
  storage: { read(key: string): Promise<string | null>; write(key: string, value: string): Promise<void> };
  platform: string;
  /** Version of package.json: live in development, baked in when packaged (see `game/version.ts`). */
  version?: () => Promise<string>;
}

/** Storage backed by the Electron preload bridge when present. */
export class BridgeStorage implements Storage {
  private bridge: DesktopBridge;
  constructor(bridge: DesktopBridge) {
    this.bridge = bridge;
  }
  load(key: string): Promise<string | null> {
    return this.bridge.storage.read(key);
  }
  save(key: string, value: string): Promise<void> {
    return this.bridge.storage.write(key, value);
  }
}

export function detectStorage(): Storage {
  const g = globalThis as { kubequest?: DesktopBridge };
  if (g.kubequest?.storage) return new BridgeStorage(g.kubequest);
  if (typeof globalThis.localStorage !== 'undefined') return new LocalStorage();
  return new MemoryStorage();
}
