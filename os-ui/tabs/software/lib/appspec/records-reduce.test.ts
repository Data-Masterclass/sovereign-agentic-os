/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * records-reduce.test — the PURE derivation of "current state" from the append-only os.records log
 * (3.5c). The interactive patterns can only APPEND, so a decision/completion's live value is the
 * LATEST append per key. These tests pin: latest-wins by `at`, log-order tie-break, ignoring
 * non-matching appends, and honest extraction of the app's records from a list() result.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestDecisions, decisionFor, doneTaskIds, isTaskDone, recordsFromList, reduceByKey, recordKey } from './records-reduce.ts';

test('latestDecisions keeps the latest decision per itemId (by `at`)', () => {
  const log = [
    { id: '1', itemId: 'c1', decision: 'rejected', reason: 'early', by: 'amir', at: '2026-08-01T10:00:00Z' },
    { id: '2', itemId: 'c1', decision: 'approved', reason: 'final', by: 'bea', at: '2026-08-02T10:00:00Z' },
    { id: '3', itemId: 'c2', decision: 'approved', reason: '', by: 'amir', at: '2026-08-01T10:00:00Z' },
  ];
  const d = latestDecisions(log);
  assert.equal(d.size, 2);
  assert.equal(d.get('c1')?.decision, 'approved');
  assert.equal(d.get('c1')?.reason, 'final');
  assert.equal(d.get('c2')?.decision, 'approved');
});

test('latestDecisions breaks an `at` tie by log order (last append wins)', () => {
  const log = [
    { itemId: 'c1', decision: 'approved', at: 'T' },
    { itemId: 'c1', decision: 'rejected', at: 'T' },
  ];
  assert.equal(latestDecisions(log).get('c1')?.decision, 'rejected');
});

test('latestDecisions ignores appends that are not decisions (no itemId / no decision)', () => {
  const log = [
    { taskId: 't1', done: true, at: 'T' }, // a completion, not a decision
    { itemId: 'c1', at: 'T' }, // no decision field
    { decision: 'approved', at: 'T' }, // no itemId
  ];
  assert.equal(latestDecisions(log).size, 0);
});

test('decisionFor returns the latest decision or null', () => {
  const log = [{ itemId: 'c1', decision: 'approved', at: 'T' }];
  assert.equal(decisionFor(log, 'c1')?.decision, 'approved');
  assert.equal(decisionFor(log, 'nope'), null);
});

test('doneTaskIds reduces completions; a later done:false un-checks an earlier done:true', () => {
  const log = [
    { taskId: 't1', done: true, at: '2026-08-01T00:00:00Z' },
    { taskId: 't1', done: false, at: '2026-08-02T00:00:00Z' }, // later → wins
    { taskId: 't2', done: true, at: '2026-08-01T00:00:00Z' },
  ];
  const done = doneTaskIds(log);
  assert.equal(done.has('t1'), false);
  assert.equal(done.has('t2'), true);
  assert.equal(isTaskDone(log, 't2'), true);
  assert.equal(isTaskDone(log, 't1'), false);
});

test('doneTaskIds accepts string "true" and ignores non-completions', () => {
  const log = [
    { taskId: 't1', done: 'true', at: 'T' },
    { itemId: 'c1', decision: 'approved', at: 'T' }, // a decision, not a completion
    { taskId: 't2' }, // no done field
  ];
  const done = doneTaskIds(log);
  assert.deepEqual([...done], ['t1']);
});

test('recordsFromList extracts items honestly; a shape without items → []', () => {
  assert.deepEqual(recordsFromList({ source: 'os-records-store', items: [{ id: '1', a: 1 }] }), [{ id: '1', a: 1 }]);
  assert.deepEqual(recordsFromList({ source: 'demo-seed', note: 'not live' }), []);
  assert.deepEqual(recordsFromList(null), []);
  assert.deepEqual(recordsFromList({ items: 'nope' }), []);
});

test('recordKey uses _key (a supersede) else the row-own id (a fresh row)', () => {
  assert.equal(recordKey({ id: 'orig', _key: 'orig', name: 'edit' }), 'orig');
  assert.equal(recordKey({ id: 'r1', name: 'fresh' }), 'r1');
  assert.equal(recordKey({ name: 'no-id' }), '');
});

test('reduceByKey collapses a supersede: an update keyed to the original wins', () => {
  const log = [
    { id: 'r1', name: 'Acme', tier: 'A', at: '2026-08-01T10:00:00Z' },        // fresh add
    { id: 'r2', _key: 'r1', name: 'Acme Corp', tier: 'A', at: '2026-08-02T10:00:00Z' }, // edit of r1
  ];
  const rows = reduceByKey(log);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { id: 'r1', name: 'Acme Corp', tier: 'A', at: '2026-08-02T10:00:00Z' });
  // reserved keys are stripped from the view
  assert.equal((rows[0] as { _key?: unknown })._key, undefined);
});

test('reduceByKey hides a tombstoned row; a later un-delete brings it back', () => {
  const del = reduceByKey([
    { id: 'r1', name: 'A', at: 'T1' },
    { id: 'r2', _key: 'r1', _deleted: true, at: 'T2' },
  ]);
  assert.equal(del.length, 0);
  const undel = reduceByKey([
    { id: 'r1', name: 'A', at: 'T1' },
    { id: 'r2', _key: 'r1', _deleted: true, at: 'T2' },
    { id: 'r3', _key: 'r1', name: 'A back', at: 'T3' }, // later non-deleted → visible again
  ]);
  assert.deepEqual(undel, [{ id: 'r1', name: 'A back', at: 'T3' }]);
});

test('reduceByKey keeps creation order across edits (a row does not jump when edited)', () => {
  const rows = reduceByKey([
    { id: 'a', name: 'first', at: '2026-08-01T00:00:00Z' },
    { id: 'b', name: 'second', at: '2026-08-02T00:00:00Z' },
    { id: 'e', _key: 'a', name: 'first-edited', at: '2026-08-03T00:00:00Z' }, // newest append, oldest row
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b']); // a stays first (its earliest append is oldest)
  assert.equal(rows[0].name, 'first-edited');
});

test('reduceByKey tie-break by log order; skips rows with no id and no _key', () => {
  const tie = reduceByKey([
    { id: 'r1', v: 'one', at: 'T' },
    { id: 'x', _key: 'r1', v: 'two', at: 'T' }, // same at → later append wins
  ]);
  assert.equal(tie[0].v, 'two');
  assert.deepEqual(reduceByKey([{ name: 'orphan' }]), []); // not addressable
});
