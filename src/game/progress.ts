/** Player progress: per-mission bests, settings, stats. Versioned for migrations. */
import type { Storage } from './storage.ts';

export interface MissionRecord {
  bestScore: number;
  stars: number;
  bestTimeSec: number;
  completions: number;
  attempts: number;
  lastPlayed: string;
}

export interface Settings {
  reducedMotion: boolean;
  fontSize: 'small' | 'normal' | 'large';
  unlockAll: boolean;
  theme: 'dark' | 'light';
}

export interface ProgressData {
  version: 1;
  missions: Record<string, MissionRecord>;
  settings: Settings;
  stats: { commands: number; missionsCompleted: number; hintsUsed: number; playSeconds: number };
}

const KEY = 'progress';

export function defaultProgress(): ProgressData {
  return { version: 1, missions: {}, settings: { reducedMotion: false, fontSize: 'normal', unlockAll: false, theme: 'dark' }, stats: { commands: 0, missionsCompleted: 0, hintsUsed: 0, playSeconds: 0 } };
}

export class Progress {
  data: ProgressData = defaultProgress();
  private storage: Storage;
  constructor(storage: Storage) {
    this.storage = storage;
  }
  async load(): Promise<void> {
    const raw = await this.storage.load(KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<ProgressData>;
      if (parsed.version === 1) this.data = { ...defaultProgress(), ...parsed, settings: { ...defaultProgress().settings, ...(parsed.settings ?? {}) }, stats: { ...defaultProgress().stats, ...(parsed.stats ?? {}) } };
    } catch { /* corrupt file: start fresh, keep the old content untouched until next save */ }
  }
  async save(): Promise<void> {
    await this.storage.save(KEY, JSON.stringify(this.data, null, 2));
  }
  record(missionId: string, score: number, stars: number, timeSec: number): MissionRecord {
    const prev = this.data.missions[missionId];
    const rec: MissionRecord = {
      bestScore: Math.max(prev?.bestScore ?? 0, score),
      stars: Math.max(prev?.stars ?? 0, stars),
      bestTimeSec: prev?.bestTimeSec ? Math.min(prev.bestTimeSec, timeSec) : timeSec,
      completions: (prev?.completions ?? 0) + 1,
      attempts: prev?.attempts ?? 1,
      lastPlayed: new Date().toISOString(),
    };
    this.data.missions[missionId] = rec;
    this.data.stats.missionsCompleted++;
    return rec;
  }
  attempt(missionId: string): void {
    const prev = this.data.missions[missionId];
    this.data.missions[missionId] = prev ? { ...prev, attempts: prev.attempts + 1, lastPlayed: new Date().toISOString() } : { bestScore: 0, stars: 0, bestTimeSec: 0, completions: 0, attempts: 1, lastPlayed: new Date().toISOString() };
  }
  export(): string {
    return JSON.stringify(this.data, null, 2);
  }
  import(json: string): void {
    const parsed = JSON.parse(json) as ProgressData;
    if (parsed.version !== 1 || typeof parsed.missions !== 'object') throw new Error('not a Kubequest progress file');
    this.data = { ...defaultProgress(), ...parsed };
  }
}
