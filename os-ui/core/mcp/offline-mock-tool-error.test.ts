/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    An agent tool call surfaces a refused mock as ENGINE_UNAVAILABLE, never as a row
 * USER STORY: As an agent I must be able to ROUTE on the fact that a dependency is down. In the
 *             run of 2026-11-18 I was handed plausible rows and carried on building on them,
 *             because a fabricated answer and a real one were the same shape.
 * ARCHITECTURE:
 *   - `structuredError` in `core/mcp/server.ts` is the ONE door every tool exception leaves
 *     through, so the mapping belongs there and nowhere else. The 503 the typed refusal carries
 *     must NOT collapse into the `error` catch-all, which is unactionable.
 *   - Also pins that the refusal's hint tells the reader what to do, and that an ordinary 503
 *     from some other cause is NOT mislabelled as a mock refusal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structuredError } from '@core/mcp/server';
import { OfflineMockRefusedError, refuseOfflineMock } from '@core/kernel/offline-mock';

test('the typed offline-mock refusal maps to code ENGINE_UNAVAILABLE', () => {
  const err = structuredError(new OfflineMockRefusedError('Revenue cannot be computed: Trino is unreachable.'));
  assert.equal(err.code, 'ENGINE_UNAVAILABLE');
  assert.match(err.reason, /Trino is unreachable/);
  assert.match(err.hint, /unavailable|unreachable|retry/i, 'the hint is actionable');
});

test('a refusal thrown by refuseOfflineMock maps the same way (one door, one code)', () => {
  try {
    refuseOfflineMock('No security scan ran: no scanner engine is configured.');
    assert.fail('refuseOfflineMock must throw');
  } catch (e) {
    assert.equal(structuredError(e).code, 'ENGINE_UNAVAILABLE');
  }
});

test('the refusal does NOT fall into the `error` catch-all — an agent could not act on that', () => {
  const err = structuredError(new OfflineMockRefusedError('x'));
  assert.notEqual(err.code, 'error');
  assert.notEqual(err.code, 'upstream_error', 'this is a POLICY refusal, not a transport failure');
});

test('an unrelated 503 keeps its own mapping — the code is not claimed by status alone', () => {
  const plain = Object.assign(new Error('gateway restarting'), { status: 503 });
  assert.notEqual(structuredError(plain).code, 'ENGINE_UNAVAILABLE');
});
