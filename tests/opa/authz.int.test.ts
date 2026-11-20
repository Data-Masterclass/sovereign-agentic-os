/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * authz.int.test — OPA's own API protection, against the REAL OPA container started from the
 * chart (tests/opa/run-chart-opa.py; `--authentication=token --authorization=basic` with the
 * chart's policies/system/authz.rego and the tokens of the rendered Secret `opa-tokens`).
 *
 *  1. Without a token only GET /health and Trino's decision queries (POST /v1/data/trino/*) work;
 *     data and policy writes, data reads and ad-hoc queries are refused (401).
 *  2. The reader token (web-fetch) gets tool decisions and nothing else.
 *  3. The writer token (the OS reconciler) writes data and policies — through the OS's own adapter
 *     (core/adapters/opa/client.ts), which presents OPA_TOKEN.
 *  4. Negative twins: the same chart with `opa.auth.enforce=false` (OPA_IT_OPEN_URL) accepts the
 *     anonymous write, so the 401s above are OPA's authorization doing it; and the OS adapter
 *     with no token is refused by the enforcing OPA.
 *
 * Run: OPA_IT_URL=http://127.0.0.1:18181 OPA_IT_OPEN_URL=http://127.0.0.1:18182 \
 *   OPA_IT_TOKENS_FILE=<file> node --experimental-test-module-mocks --import ./scripts/test-setup.mjs \
 *   --test ../tests/opa/authz.int.test.ts   (from os-ui/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const OPA = process.env.OPA_IT_URL;
const OPEN = process.env.OPA_IT_OPEN_URL;
if (!OPA || !OPEN || !process.env.OPA_IT_TOKENS_FILE) {
  throw new Error('authz.int.test needs OPA_IT_URL, OPA_IT_OPEN_URL and OPA_IT_TOKENS_FILE (real OPA containers)');
}
process.env.OPA_URL = OPA;
const { tokens } = await import('./it-auth.ts');
assert.ok(tokens.writer && tokens.reader, 'the rendered Secret carries both tokens');

const bearer = (t?: string): Record<string, string> => (t ? { authorization: `Bearer ${t}` } : {});
const json = { 'content-type': 'application/json' };
async function call(base: string, method: string, path: string, token?: string, body?: unknown): Promise<number> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...json, ...bearer(token) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  await res.arrayBuffer();
  return res.status;
}

test('without a token: health and Trino decisions only', async () => {
  assert.equal(await call(OPA, 'GET', '/health'), 200, 'kubelet probes need no token');
  assert.equal(await call(OPA, 'POST', '/v1/data/trino/allow', undefined, { input: {} }), 200, 'Trino decision');
  assert.equal(await call(OPA, 'PUT', '/v1/data/it_anon', undefined, { x: 1 }), 401, 'data write');
  assert.equal(await call(OPA, 'PUT', '/v1/policies/it_anon', undefined, 'package it_anon\n'), 401, 'policy write');
  assert.equal(await call(OPA, 'DELETE', '/v1/data/grants'), 401, 'data delete');
  assert.equal(await call(OPA, 'GET', '/v1/data/seed_grants'), 401, 'data read');
  assert.equal(await call(OPA, 'GET', '/v1/policies'), 401, 'policy list');
  assert.equal(await call(OPA, 'POST', '/v1/query', undefined, { query: 'data' }), 401, 'ad-hoc query');
  assert.equal(await call(OPA, 'PUT', '/v1/data/trino/allow', undefined, true), 401, 'a write under the Trino package');
  assert.equal(await call(OPA, 'POST', '/v1/data/agentic/authz/allow', undefined, { input: {} }), 401, 'a tool decision');
});

test('the reader token (web-fetch): tool decisions only', async () => {
  assert.equal(await call(OPA, 'POST', '/v1/data/agentic/authz/allow', tokens.reader, { input: { principal: 'sovereign-agents', tool: 'rag_search' } }), 200);
  assert.equal(await call(OPA, 'PUT', '/v1/data/it_reader', tokens.reader, { x: 1 }), 401);
  assert.equal(await call(OPA, 'GET', '/v1/data/grants', tokens.reader), 401);
  assert.equal(await call(OPA, 'POST', '/v1/query', tokens.reader, { query: 'data' }), 401);
});

test('a wrong token is refused everywhere a token is checked', async () => {
  assert.equal(await call(OPA, 'PUT', '/v1/data/it_wrong', 'not-a-token', { x: 1 }), 401);
  assert.equal(await call(OPA, 'POST', '/v1/data/trino/allow', 'not-a-token', { input: {} }), 401);
});

test('the writer token (the OS reconciler) writes data and policies through the OS adapter', async () => {
  const { opaPutData, opaGetData, opaDeleteData, opaPutPolicy } = await import('@core/adapters/opa/client');
  const put = await opaPutData('it_writer', { ok: true }, 5000);
  assert.ok(put.ok, `PUT data: ${JSON.stringify(put)}`);
  const got = await opaGetData('it_writer', 5000);
  assert.ok(got.ok && got.value.defined && (got.value.value as { ok?: boolean }).ok === true);
  const pol = await opaPutPolicy('it_writer_policy', 'package it_writer_policy\n\nx := 1\n', 5000);
  assert.ok(pol.ok, `PUT policy: ${JSON.stringify(pol)}`);
  assert.equal(await call(OPA, 'DELETE', '/v1/policies/it_writer_policy', tokens.writer), 200);
  assert.ok((await opaDeleteData('it_writer', 5000)).ok);
});

test('negative twin: the OS adapter without its token is refused', async () => {
  const { config } = await import('@core/kernel/config');
  const { opaPutData } = await import('@core/adapters/opa/client');
  const saved = config.opaToken;
  (config as { opaToken: string }).opaToken = '';
  try {
    const r = await opaPutData('it_no_token', { x: 1 }, 5000);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'unauthorized');
  } finally {
    (config as { opaToken: string }).opaToken = saved;
  }
});

test('negative twin: the same chart with opa.auth.enforce=false accepts the anonymous write', async () => {
  assert.ok([200, 204].includes(await call(OPEN, 'PUT', '/v1/data/it_open', undefined, { x: 1 })), 'open OPA accepts it');
  assert.equal(await call(OPEN, 'GET', '/v1/data/it_open'), 200);
});
