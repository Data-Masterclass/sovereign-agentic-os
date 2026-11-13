/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Parity test P1 — the old walker and the new engine agree on every golden fixture
 * USER STORY: As the engine-rebuild engineer I want a table-driven test that replays each
 *             fixture's recorded model transcript through an engine and asserts the golden
 *             visited path, (tool, args) sequence and final text — green for the walker today,
 *             with one clearly marked `todo` per fixture that Phase A1 flips for `buildGraph`.
 * ARCHITECTURE:
 *   - Reads every ./fixtures/*.json; `replayWalker` drives `runAgenticGraph` with the replayed
 *     transcript and the real grant gates; asserts path/toolCalls/finalText and that the whole
 *     transcript was consumed.
 *   - Fixtures WITH a `when` guard are excluded from P1 (the walker ignores guards). The guarded
 *     shape (c) carries the HANDOFF-GUARD `todo`: today the walker visits the target even though
 *     `state.findings_ready` is never set; A1's engine must NOT.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayWalker, type EngineFixture } from '@tabs/agents/lib/engine/parity-harness';

const DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

function loadFixtures(): EngineFixture[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as EngineFixture);
}

const fixtures = loadFixtures();

test('P1 has fixtures to run against', () => {
  assert.ok(fixtures.length >= 13, `expected ≥13 fixtures, found ${fixtures.length}`);
});

for (const fx of fixtures) {
  if (fx.guarded) {
    // HANDOFF-GUARD (known walker defect): the walker never evaluates `when`, so its golden
    // visits the guarded target although the guard channel is never set. A1's engine must
    // stop at the guard; flipping this todo means asserting the target is NOT in the path.
    const guarded = fx.name === 'shape-guarded-handoff-held-write'
      ? ` — walker visits 'publisher' although when:"state.findings_ready" is never true (golden path ${JSON.stringify(fx.golden.path)})`
      : ' — walker ignores its `when` guards';
    test.todo(`P1 ${fx.name} [walker]: excluded from P1 (guarded)${guarded}`);
    test.todo(`P1 ${fx.name} [langgraph]: buildGraph honours the when guards — Phase A1`);
    continue;
  }

  test(`P1 ${fx.name} [walker]: replayed transcript reproduces the golden path, tool sequence and final text`, async () => {
    const run = await replayWalker(fx);
    assert.deepEqual(run.path, fx.golden.path, 'visited node path');
    assert.deepEqual(run.toolCalls, fx.golden.toolCalls, '(node, tool, args, isError) sequence');
    assert.equal(run.finalText, fx.golden.finalText, 'final text');
    assert.equal(run.reachedEnd, fx.golden.reachedEnd, 'reachedEnd');
    assert.equal(run.held, fx.golden.held, 'writes held by the real gate');
    assert.equal(run.remaining, 0, 'every recorded exchange was consumed');
  });

  // Phase A1: replace with `replayGraph(fx)` over `buildGraph(compile(parseSystem(fx.yaml)), deps)`
  // and assert the same five fields against `fx.golden`.
  test.todo(`P1 ${fx.name} [langgraph]: buildGraph reproduces the same golden — Phase A1`);
}
