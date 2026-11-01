/** Content rules from AGENTS.md §5: lessons ≤5 paragraphs, paragraphs and concept cards short. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MISSIONS } from '../../src/missions/index.ts';
import { INSIGHTS } from '../../src/missions/insights.ts';

const words = (s: string) => s.split(/\s+/).filter((w) => w).length;

for (const m of MISSIONS) {
  test(`mission ${m.id} briefing content stays short and complete`, () => {
    assert.ok(m.lesson && m.lesson.length >= 2 && m.lesson.length <= 5, `${m.id}: lesson must have 2–5 paragraphs`);
    for (const p of m.lesson ?? []) assert.ok(words(p) <= 130, `${m.id}: lesson paragraph too long (${words(p)} words): ${p.slice(0, 40)}…`);
    assert.ok(m.lesson!.reduce((n, p) => n + words(p), 0) <= 520, `${m.id}: lesson too long overall`);
    for (const c of m.concepts) assert.ok(words(c.body) <= 120, `${m.id}: concept card "${c.title}" too long (${words(c.body)} words)`);
    assert.ok(m.hints.length >= 2, `${m.id}: hints go from vague to exact`);
    const ids = new Set(m.objectives.map((o) => o.id));
    for (const [oid, text] of Object.entries(INSIGHTS[m.id] ?? {})) {
      assert.ok(ids.has(oid), `${m.id}: insight for unknown objective "${oid}"`);
      assert.ok(words(text) <= 90, `${m.id}/${oid}: insight too long (${words(text)} words)`);
    }
    const withInsight = m.objectives.filter((o) => o.insight).length;
    assert.ok(withInsight >= Math.ceil(m.objectives.length / 2), `${m.id}: most objectives should carry an insight`);
  });
}
