/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A `demo-seed` result is structurally unusable as governance evidence (night-2 S3)
 * USER STORY: As an approver I need the gate to REFUSE seeded placeholder data, not merely label
 *             it — a label lives in a response field any caller can drop.
 * ARCHITECTURE: Pure unit test over `seeded-evidence.ts` + the real seed producer in
 *             `tool-exec.ts`, so the detector is pinned to the ACTUAL marker the OS emits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSeededEvidence, assertNotSeeded, SeededEvidenceError, SEEDED_SOURCE } from './seeded-evidence.ts';
import { seedToolResult, DEMO_SEED_NOTE } from './tool-exec.ts';

test('every shape the real seed producer emits is detected as seeded', () => {
  for (const tool of ['list_renewals', 'get_renewal', 'add_renewal', 'create_thing', 'export_renewals', 'do_something']) {
    const result = seedToolResult(tool, { id: 'r1' });
    assert.equal(result.source, SEEDED_SOURCE, `${tool} is labelled`);
    assert.ok(isSeededEvidence(result), `${tool} result is detected`);
  }
});

test('the marker is found however deeply a card or a gate nested it', () => {
  assert.ok(isSeededEvidence({ scan: { findings: [{ evidence: { source: 'demo-seed' } }] } }));
  assert.ok(isSeededEvidence([[{ a: { b: { c: { source: 'demo-seed' } } } }]]));
  assert.ok(isSeededEvidence({ mode: 'demo-seed' }), 'a `mode` label counts too');
  // A caller that forwarded ONLY the human note (dropping `source`) is still caught.
  assert.ok(isSeededEvidence({ note: DEMO_SEED_NOTE }));
  assert.ok(isSeededEvidence('demo-seed'));
});

test('real evidence is NOT flagged — the guard must not block a live gate', () => {
  assert.equal(isSeededEvidence({ source: 'live-app', items: [{ id: 'r1' }] }), false);
  assert.equal(isSeededEvidence([{ path: 'src/App.tsx', content: 'export default () => null;' }]), false);
  assert.equal(isSeededEvidence({ scan: { passed: true, findings: [] } }), false);
  assert.equal(isSeededEvidence(null), false);
  assert.equal(isSeededEvidence(undefined), false);
  assert.equal(isSeededEvidence(42), false);
  assert.equal(isSeededEvidence('a commit message mentioning seed data'), false);
});

test('a cycle and an over-deep object terminate instead of hanging', () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  assert.equal(isSeededEvidence(cyclic), false);
  const cyclicSeeded: Record<string, unknown> = { source: 'demo-seed' };
  cyclicSeeded.self = cyclicSeeded;
  assert.equal(isSeededEvidence(cyclicSeeded), true);
  // Deeper than the scan bound: honestly out of scope rather than an unbounded walk.
  let deep: unknown = { source: 'demo-seed' };
  for (let i = 0; i < 40; i++) deep = { nested: deep };
  assert.equal(isSeededEvidence(deep), false);
});

test('assertNotSeeded throws a typed 409 naming the context, and passes real evidence', () => {
  assert.doesNotThrow(() => assertNotSeeded('a deploy request', { source: 'live-app' }));
  try {
    assertNotSeeded('the approval of review card rev_1', seedToolResult('list_renewals'));
    assert.fail('expected a refusal');
  } catch (e) {
    assert.ok(e instanceof SeededEvidenceError);
    const err = e as SeededEvidenceError;
    assert.equal(err.status, 409);
    assert.equal(err.code, 'seeded_evidence');
    assert.equal(err.context, 'the approval of review card rev_1');
    assert.match(err.message, /not a response from the app/);
    assert.match(err.message, /Nothing was approved, recorded or changed/);
  }
});
