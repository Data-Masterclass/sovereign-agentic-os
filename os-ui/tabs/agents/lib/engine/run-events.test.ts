/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Run event bus tests — replay on attach, a parked `done` keeps the topic open, owner stamp
 * USER STORY: As the panel re-attaching to a parked run I must receive what I missed, keep listening
 *             through the parked `done`, and stop at the real end.
 * ARCHITECTURE: pure module test.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetRunEvents, openRunTopic, publishRunEvent, runTopicOwner, subscribeRun } from '@tabs/agents/lib/engine/run-events';

beforeEach(() => __resetRunEvents());

test('a late subscriber replays the buffer; a parked done is not terminal; the final done ends the stream once', () => {
  openRunTopic('run_1', { systemId: 's', userId: 'u', domain: 'd' });
  publishRunEvent('run_1', 'node-started', { node: 'a' });
  publishRunEvent('run_1', 'approval-required', { approvalId: 'apr_1', tool: 'request_promotion', node: 'a' });
  publishRunEvent('run_1', 'done', { parked: true, heldApprovals: [{ approvalId: 'apr_1' }] });
  const seen: string[] = [];
  let ended = 0;
  subscribeRun('run_1', (ev) => seen.push(ev.event), () => { ended += 1; });
  assert.deepEqual(seen, ['node-started', 'approval-required', 'done'], 'replayed, still attached');
  assert.equal(ended, 0, 'a parked done keeps the topic open');
  publishRunEvent('run_1', 'resumed', { approvalId: 'apr_1', decision: 'approve' });
  publishRunEvent('run_1', 'done', { parked: false });
  publishRunEvent('run_1', 'node-started', { node: 'late' });
  assert.deepEqual(seen, ['node-started', 'approval-required', 'done', 'resumed', 'done'], 'events after the terminal done are dropped');
  assert.equal(ended, 1);
  assert.deepEqual(runTopicOwner('run_1'), { systemId: 's', userId: 'u', domain: 'd' });
  assert.equal(runTopicOwner('nope'), undefined);
});

test('subscribing to an already-finished topic replays and ends at once', () => {
  openRunTopic('run_2', { systemId: 's', userId: 'u', domain: 'd' });
  publishRunEvent('run_2', 'done', { parked: false });
  let ended = 0;
  const seen: string[] = [];
  subscribeRun('run_2', (ev) => seen.push(ev.event), () => { ended += 1; });
  assert.deepEqual(seen, ['done']);
  assert.equal(ended, 1);
});
