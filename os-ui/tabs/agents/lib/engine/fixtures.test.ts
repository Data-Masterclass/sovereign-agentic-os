/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Golden-fixture stability — each committed fixture equals a fresh generation
 * USER STORY: As the engine-rebuild engineer I want the committed fixtures proven reproducible
 *             (same scripted model + same walker ⇒ byte-identical JSON) so a parity failure can
 *             never be blamed on a stale or hand-edited fixture; and I want one command
 *             (REGEN_FIXTURES=1) that rewrites them when the walker or the script changes.
 * ARCHITECTURE:
 *   - Reads ./fixtures/<name>.json; generates in memory via `generateFixture`; deep-equals.
 *   - REGEN_FIXTURES=1 writes instead of comparing (the only sanctioned way to change a fixture).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureSpecs, generateFixture, SCRIPT_ID, type EngineFixture } from '@tabs/agents/lib/engine/parity-harness';

const DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const REGEN = process.env.REGEN_FIXTURES === '1';

const specs = fixtureSpecs();

test('the fixture set covers every shipped template, the software team and the three shapes', () => {
  const names = specs.map((s) => s.name);
  for (const key of ['blank', 'analyze', 'evaluate', 'recommend']) assert.ok(names.includes(`template-${key}`), `template-${key}`);
  for (const key of ['blank', 'analyst', 'recommender', 'reviewer', 'researcher']) assert.ok(names.includes(`agent-template-${key}`), `agent-template-${key}`);
  for (const n of ['software-team', 'shape-single-read', 'shape-supervisor-two-members', 'shape-guarded-handoff-held-write']) assert.ok(names.includes(n), n);
  assert.equal(new Set(names).size, names.length, 'fixture names are unique');
});

for (const spec of specs) {
  test(`fixture ${spec.name} is reproducible from the scripted model + the current walker`, async () => {
    const generated = await generateFixture(spec);
    const file = join(DIR, `${spec.name}.json`);
    if (REGEN) {
      writeFileSync(file, `${JSON.stringify(generated, null, 2)}\n`);
      return;
    }
    assert.ok(existsSync(file), `missing ${file} — run: REGEN_FIXTURES=1 npm --prefix os-ui test`);
    const committed = JSON.parse(readFileSync(file, 'utf8')) as EngineFixture;
    assert.equal(committed.script, SCRIPT_ID, 'fixture was recorded with the current script rules');
    assert.deepEqual(generated, committed);
  });
}

test('no orphan fixture file (every JSON under ./fixtures has a spec)', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  const names = new Set(specs.map((s) => s.name));
  assert.deepEqual(files.filter((f) => !names.has(f)), []);
});
