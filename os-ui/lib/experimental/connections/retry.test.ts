/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithBackoff, retryAfterMs } from './retry.ts';

/** Build a fake fetch that returns responses from a script, recording calls. */
function fakeFetch(responses: { status: number; headers?: Record<string, string> }[]) {
  const calls: number[] = [];
  let i = 0;
  const impl = async (_url: string, _init?: RequestInit): Promise<Response> => {
    const r = responses[Math.min(i, responses.length - 1)];
    calls.push(r.status);
    i += 1;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Headers(r.headers ?? {}),
      json: async () => ({}),
      text: async () => '',
    } as Response;
  };
  return { impl, calls };
}

/** No-op sleep — deterministic tests never actually wait. */
const noSleep = async (_ms: number): Promise<void> => { /* instant */ };

test('retryAfterMs: integer seconds', () => {
  assert.equal(retryAfterMs('30'), 30_000);
  assert.equal(retryAfterMs('0'), 0);
});

test('retryAfterMs: missing header uses fallback', () => {
  assert.equal(retryAfterMs(null, 2000), 2000);
  assert.equal(retryAfterMs('', 500), 500);
});

test('retryAfterMs: HTTP-date in the past → 0', () => {
  // A date well in the past → clamped to 0
  const ms = retryAfterMs('Thu, 01 Jan 2015 00:00:00 GMT');
  assert.equal(ms, 0);
});

test('retryAfterMs: garbage string uses fallback', () => {
  assert.equal(retryAfterMs('not-a-date', 999), 999);
});

test('fetchWithBackoff: 200 on first attempt — no retries', async () => {
  const { impl, calls } = fakeFetch([{ status: 200 }]);
  const res = await fetchWithBackoff('https://example.com', {}, impl, { sleep: noSleep });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1, 'exactly one call');
});

test('fetchWithBackoff: 429 then 200 — retries once, returns 200', async () => {
  const { impl, calls } = fakeFetch([{ status: 429, headers: { 'retry-after': '1' } }, { status: 200 }]);
  const res = await fetchWithBackoff('https://example.com', {}, impl, { sleep: noSleep });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
});

test('fetchWithBackoff: 503 then 200 — retries once, returns 200', async () => {
  const { impl, calls } = fakeFetch([{ status: 503 }, { status: 200 }]);
  const res = await fetchWithBackoff('https://example.com', {}, impl, { sleep: noSleep });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
});

test('fetchWithBackoff: always 429 — exhausts maxAttempts, returns final 429', async () => {
  const { impl, calls } = fakeFetch([
    { status: 429 }, { status: 429 }, { status: 429 },
  ]);
  const res = await fetchWithBackoff('https://example.com', {}, impl, { maxAttempts: 3, sleep: noSleep });
  assert.equal(res.status, 429);
  assert.equal(calls.length, 3, 'exactly maxAttempts calls');
});

test('fetchWithBackoff: maxAttempts=1 means no retry (single attempt)', async () => {
  const { impl, calls } = fakeFetch([{ status: 429 }, { status: 200 }]);
  const res = await fetchWithBackoff('https://example.com', {}, impl, { maxAttempts: 1, sleep: noSleep });
  assert.equal(res.status, 429);
  assert.equal(calls.length, 1, 'single attempt, no retry');
});

test('fetchWithBackoff: 404 is not retried (only 429/503)', async () => {
  const { impl, calls } = fakeFetch([{ status: 404 }, { status: 200 }]);
  const res = await fetchWithBackoff('https://example.com', {}, impl, { sleep: noSleep });
  assert.equal(res.status, 404);
  assert.equal(calls.length, 1, '404 passes through immediately');
});

test('fetchWithBackoff: thrown network error propagates immediately (no retry)', async () => {
  const boom = async (): Promise<Response> => { throw new Error('network down'); };
  await assert.rejects(
    () => fetchWithBackoff('https://example.com', {}, boom, { sleep: noSleep }),
    /network down/,
  );
});

test('fetchWithBackoff: sleep is called with a value ≥ 0 (jitter ≥ 0)', async () => {
  const delays: number[] = [];
  const recordSleep = async (ms: number): Promise<void> => { delays.push(ms); };
  const { impl } = fakeFetch([{ status: 429 }, { status: 200 }]);
  await fetchWithBackoff('https://example.com', {}, impl, { sleep: recordSleep });
  assert.equal(delays.length, 1, 'sleep called once for the one retry');
  assert.ok(delays[0] >= 0, 'delay is non-negative');
});

test('fetchWithBackoff: 429 × 2 then 200 with maxAttempts=3 — two retries', async () => {
  const { impl, calls } = fakeFetch([{ status: 429 }, { status: 429 }, { status: 200 }]);
  const res = await fetchWithBackoff('https://example.com', {}, impl, { maxAttempts: 3, sleep: noSleep });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3);
});
