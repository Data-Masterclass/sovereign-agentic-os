/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Run report write summary counts saved outputs
 * USER STORY: As the person who ran an agent I want "Wrote N" to include the outputs the OS saved.
 * ARCHITECTURE: pure — `withSavedOutputs` / `writeSummaryLine` over plain values.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withSavedOutputs, writeSummaryLine } from '@tabs/agents/lib/build/write-summary';

const TOOL = { wrote: [{ tab: 'Data', count: 2 }], wroteTotal: 2, heldTotal: 0 };

test('tool writes only: the sentence is unchanged from before', () => {
  assert.equal(writeSummaryLine({ wrote: TOOL.wrote, heldTotal: 0 }), 'Wrote 2 record(s) directly — 2 to My Data.');
  assert.equal(withSavedOutputs(TOOL, []).wroteTotal, 2);
});

test('saved outputs only: "Wrote 1 item (1 output saved)"', () => {
  const s = withSavedOutputs({ wrote: [], wroteTotal: 0, heldTotal: 0 }, [{ state: 'saved' }, { state: 'failed' }, { state: 'not_saved' }]);
  assert.equal(s.wroteTotal, 1);
  assert.equal(s.outputsSaved, 1);
  assert.equal(s.line, 'Wrote 1 item (1 output saved).');
});

test('both, plus held: one honest sentence', () => {
  const s = withSavedOutputs({ ...TOOL, heldTotal: 1 }, [{ state: 'saved' }]);
  assert.equal(s.wroteTotal, 3);
  assert.equal(s.line, 'Wrote 3 items — 2 directly (2 to My Data), 1 output saved. 1 write awaiting approval in Governance → Inbox.');
});

test('idempotent: re-applying recounts from the tool writes, never double-counts', () => {
  const once = withSavedOutputs(TOOL, [{ state: 'saved' }]);
  const twice = withSavedOutputs(once, [{ state: 'saved' }, { state: 'saved' }]);
  assert.equal(twice.wroteTotal, 4);
  assert.equal(twice.outputsSaved, 2);
});

test('outputs unknown: keeps the count it already had; no summary yet: an empty one', () => {
  assert.equal(withSavedOutputs({ ...TOOL, wroteTotal: 3, outputsSaved: 1 }, undefined).wroteTotal, 3);
  assert.deepEqual(withSavedOutputs(undefined, undefined), { line: '', wrote: [], wroteTotal: 0, heldTotal: 0, outputsSaved: 0 });
});
