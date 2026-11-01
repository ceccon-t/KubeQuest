/** Score and stars. Weights are documented in docs/TECH_SPEC.md §4.2. */
import type { Mission } from './mission.ts';

export interface ScoreInput {
  objectivesDone: number;
  objectivesTotal: number;
  optionalDone: number;
  elapsedSec: number;
  commands: number;
  hintsCost: number;
  availability: number; // 0..1 lifetime
  hasTraffic: boolean;
  sloMet: boolean;
  slaBreached: boolean;
}

export interface ScoreBreakdown {
  objectives: number;
  time: number;
  efficiency: number;
  slo: number;
  bonus: number;
  hints: number;
  total: number;
  stars: 1 | 2 | 3;
  notes: string[];
}

export function computeScore(m: Mission, s: ScoreInput): ScoreBreakdown {
  const notes: string[] = [];
  const objectives = Math.round(1000 * (s.objectivesTotal ? s.objectivesDone / s.objectivesTotal : 1));
  let time: number;
  if (s.elapsedSec <= m.par.timeSec) time = 500;
  else time = Math.max(0, Math.round(500 - (500 * (s.elapsedSec - m.par.timeSec)) / m.par.timeSec));
  if (time === 500) notes.push(`Under par time (${m.par.timeSec}s)`);
  let efficiency: number;
  if (s.commands <= m.par.commands) efficiency = 300;
  else efficiency = Math.max(0, 300 - 15 * (s.commands - m.par.commands));
  if (efficiency === 300) notes.push(`Efficient: ${s.commands} commands (par ${m.par.commands})`);
  const slo = s.hasTraffic ? Math.round(300 * s.availability) : 0;
  if (s.hasTraffic) notes.push(`Availability ${(s.availability * 100).toFixed(1)}%${s.sloMet ? '' : ' — below the SLO'}`);
  const bonus = s.optionalDone * 100;
  if (bonus) notes.push(`${s.optionalDone} optional objective${s.optionalDone > 1 ? 's' : ''}`);
  const hints = -s.hintsCost;
  if (s.hintsCost) notes.push(`Hints used: -${s.hintsCost}`);
  const total = Math.max(0, objectives + time + efficiency + slo + bonus + hints);
  let stars: 1 | 2 | 3 = total >= 1800 ? 3 : total >= 1200 ? 2 : 1;
  if (s.hasTraffic && !s.sloMet && stars > 2) { stars = 2; notes.push('3 stars require meeting the SLO'); }
  if (s.slaBreached) { stars = 1; notes.push('SLA breached: capped at 1 star'); }
  return { objectives, time, efficiency, slo, bonus, hints, total, stars, notes };
}
