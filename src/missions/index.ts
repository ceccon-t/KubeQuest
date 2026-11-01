import type { Mission } from '../game/mission.ts';
import { chapter0 } from './ch0.ts';
import { chapter1 } from './ch1.ts';
import { chapter2 } from './ch2.ts';
import { chapter3 } from './ch3.ts';
import { chapter4 } from './ch4.ts';
import { LESSONS } from './lessons.ts';
import { INSIGHTS } from './insights.ts';

export interface Chapter { number: number; title: string; subtitle: string; missions: Mission[] }

const withLessons = (ms: Mission[]): Mission[] => ms.map((m) => ({
  ...m,
  lesson: m.lesson ?? LESSONS[m.id],
  objectives: m.objectives.map((o) => ({ ...o, insight: o.insight ?? INSIGHTS[m.id]?.[o.id] })),
}));

export const CHAPTERS: Chapter[] = [
  { number: 0, title: 'Orientation', subtitle: 'Meet the cluster', missions: withLessons(chapter0) },
  { number: 1, title: 'Foundations', subtitle: 'Containers & images', missions: withLessons(chapter1) },
  { number: 2, title: 'Hands-On', subtitle: 'kubectl fluency', missions: withLessons(chapter2) },
  { number: 3, title: 'Workloads', subtitle: 'Pods, ReplicaSets, Deployments', missions: withLessons(chapter3) },
  { number: 4, title: 'Networking', subtitle: 'Services & discovery', missions: withLessons(chapter4) },
];

export const MISSIONS: Mission[] = CHAPTERS.flatMap((c) => c.missions);

export function missionById(id: string): Mission | undefined {
  return MISSIONS.find((m) => m.id === id);
}

/** Campaign order: a mission unlocks when the previous one has at least one star (or unlockAll). */
export function isUnlocked(id: string, stars: Record<string, number>, unlockAll: boolean): boolean {
  if (unlockAll) return true;
  const idx = MISSIONS.findIndex((m) => m.id === id);
  if (idx <= 0) return true;
  const prev = MISSIONS[idx - 1] as Mission;
  return (stars[prev.id] ?? 0) >= 1;
}
