/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The tool-call ledger's rules (the real-Postgres proof is `durability.pg.test.ts`)
 * USER STORY: As an approver I want a replayed step to answer a recorded call from the record and
 *             never to re-send a write whose first dispatch was cut off.
 * ARCHITECTURE: Pure — `withToolCallLedger` over the memory ledger and a counting executor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryToolCallLedger, withToolCallLedger } from '@tabs/agents/lib/engine/tool-call-ledger';

function counting() {
  const calls: string[] = [];
  const exec = async (name: string) => { calls.push(name); return { text: `ran ${name}`, isError: false }; };
  return { calls, exec };
}

test('no key → passes straight through (callers outside the team engine)', async () => {
  const c = counting();
  const run = withToolCallLedger(c.exec, memoryToolCallLedger());
  await run('request_promotion', {});
  await run('request_promotion', {});
  assert.deepEqual(c.calls, ['request_promotion', 'request_promotion']);
});

test('a recorded call is answered from the record and not dispatched again', async () => {
  const c = counting();
  const run = withToolCallLedger(c.exec, memoryToolCallLedger());
  const a = await run('request_promotion', {}, { idempotencyKey: 't:k1' });
  const b = await run('request_promotion', {}, { idempotencyKey: 't:k1' });
  assert.deepEqual(c.calls, ['request_promotion']);
  assert.deepEqual(b, a);
});

test('a WRITE whose dispatch was cut off (started, never finished) is not re-sent; a READ is', async () => {
  const ledger = memoryToolCallLedger();
  await ledger.begin('t:w', 'request_promotion');
  await ledger.begin('t:r', 'search_knowledge');
  const c = counting();
  const run = withToolCallLedger(c.exec, ledger);
  const w = await run('request_promotion', {}, { idempotencyKey: 't:w' });
  assert.equal(w.isError, true);
  assert.equal((JSON.parse(w.text) as { error: { code: string } }).error.code, 'unresolved_previous_call');
  await run('search_knowledge', {}, { idempotencyKey: 't:r' });
  assert.deepEqual(c.calls, ['search_knowledge']);
});
