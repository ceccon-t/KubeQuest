import type { Mission } from '../game/mission.ts';
import { chapter0 } from './ch0.ts';
import { chapter1 } from './ch1.ts';
import { chapter2 } from './ch2.ts';
import { chapter3 } from './ch3.ts';
import { chapter4 } from './ch4.ts';
import { chapter4b } from './ch4b.ts';
import { chapter5 } from './ch5.ts';
import { chapter6 } from './ch6.ts';
import { chapter7 } from './ch7.ts';
import { chapter8 } from './ch8.ts';
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
  { number: 4, title: 'Networking', subtitle: 'Services, routing & segmentation', missions: withLessons([...chapter4, ...chapter4b]) },
  { number: 5, title: 'Config, State & Security', subtitle: 'ConfigMaps, storage, RBAC, policy', missions: withLessons(chapter5) },
  { number: 6, title: 'Running in Production', subtitle: 'Scheduling, autoscaling, disruptions, upgrades', missions: withLessons(chapter6) },
  { number: 7, title: 'Delivery & Extension', subtitle: 'Kustomize, Helm, GitOps, operators', missions: withLessons(chapter7) },
  { number: 8, title: 'Specialization Tracks', subtitle: 'GPUs, multi-tenancy, chaos engineering', missions: withLessons(chapter8) },
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
