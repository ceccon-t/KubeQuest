/** Game clock. All engine time flows through here (AGENTS.md §1.4). */
export class Clock {
  /** Current game time in ms since Unix epoch (so timestamps render as real dates). */
  nowMs: number;
  constructor(epochMs: number) {
    this.nowMs = epochMs;
  }
  advance(dtMs: number): void {
    this.nowMs += dtMs;
  }
  /** RFC3339 timestamp as the API server prints it (seconds precision, UTC). */
  iso(ms: number = this.nowMs): string {
    return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  }
  /** Parse an RFC3339 timestamp produced by `iso()` back to ms. */
  static parse(iso: string): number {
    return Date.parse(iso);
  }
}
