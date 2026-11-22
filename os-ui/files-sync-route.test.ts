/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The gate of POST /api/runtime/files-sync (the scheduled Drive sync pass)
 * USER STORY: As the operator I want only the Dagster run pod's ServiceAccount, and only while OPA allows
 *             `files_sync_run`, to start a sync pass that acts on every drive owner's behalf.
 * ARCHITECTURE: the REAL route and the REAL `authorize` (its HTTP edge to OPA is stubbed); TokenReview is the
 *   Kubernetes edge and is replaced by what it answers. The pass itself is a recorder: every refusal must leave it
 *   un-run, and the allowed twin must run it exactly once.
 */
import { test, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const SA = 'system:serviceaccount:agentic-os:dagster-run';
let reviewed: { ok: true; username: string } | { ok: false; status: number; reason: string } = { ok: true, username: SA };
let opa: 'allow' | 'deny' | 'down' = 'allow';
let passes = 0;
const real = async (m: string): Promise<Record<string, unknown>> => ({ ...(await import(m)) });
mock.module('@core/infra/tokenreview', { namedExports: { ...(await real('@core/infra/tokenreview')), reviewToken: async () => reviewed } });
mock.module('@tabs/files/lib/connectors-server', { namedExports: { ...(await real('@tabs/files/lib/connectors-server')), runDueConnectorSyncs: async () => { passes += 1; return []; } } });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (!/\/v1\/data\/agentic\/authz\/allow/.test(String(input))) return realFetch(input, init);
  if (opa === 'down') throw new Error('connect ECONNREFUSED');
  return new Response(JSON.stringify({ result: opa === 'allow' }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const { POST } = await import('./app/api/runtime/files-sync/route');
const call = () => POST(new Request('http://os-ui/api/runtime/files-sync', { method: 'POST', headers: { authorization: 'Bearer harness-token-not-a-secret' } }));

beforeEach(() => {
  process.env.OS_RUN_GRANT_START_SA = SA;
  reviewed = { ok: true, username: SA };
  opa = 'allow';
  passes = 0;
});

test('twin: the configured ServiceAccount, with OPA allowing files_sync_run → 200 and the pass runs once', async () => {
  const r = await call();
  assert.equal(r.status, 200);
  assert.equal(passes, 1);
});

test('no ServiceAccount configured → 503 not_configured, nothing runs', async () => {
  process.env.OS_RUN_GRANT_START_SA = '';
  const r = await call();
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as { error: string }).error, 'not_configured');
  assert.equal(passes, 0);
});

test('a token of another ServiceAccount → 403, nothing runs', async () => {
  reviewed = { ok: true, username: 'system:serviceaccount:agentic-os:some-other-pod' };
  const r = await call();
  assert.equal(r.status, 403);
  assert.equal(passes, 0);
});

test('an invalid token → 401, nothing runs', async () => {
  reviewed = { ok: false, status: 401, reason: 'the token is not valid for this audience' };
  const r = await call();
  assert.equal(r.status, 401);
  assert.equal(passes, 0);
});

test('the right ServiceAccount but OPA denies files_sync_run → 403, nothing runs', async () => {
  opa = 'deny';
  const r = await call();
  assert.equal(r.status, 403);
  assert.match(((await r.json()) as { reason: string }).reason, /OPA/);
  assert.equal(passes, 0);
});

test('the right ServiceAccount but OPA unreachable → refused (fails closed), nothing runs', async () => {
  opa = 'down';
  const r = await call();
  assert.equal(r.status, 403);
  assert.equal(passes, 0);
});
