/**
 * FEATURE:    Test of the liveness probe.
 * USER STORY: As the platform I want the probe to answer without the OS.
 * ARCHITECTURE: Calls the handler directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../src/app/api/healthz/route.ts';

test('healthz answers ok', async () => {
  const res = GET();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});
