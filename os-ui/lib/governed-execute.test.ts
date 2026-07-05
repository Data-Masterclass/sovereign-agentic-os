/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tests for the governed WRITE spine (`executeRun`). The security contract is that
 * the CALLER's identity is threaded from the session-derived `ExecuteIdentity` into
 * the request body (principal for Trino->OPA read governance; uid/domains/role for
 * the query-tool's write-target + role gate) and that any rejection is surfaced
 * honestly (thrown), never swallowed into a silent success.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { executeRun, type ExecuteIdentity } from './governed.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const IDENTITY: ExecuteIdentity = {
  principal: 'sales',
  uid: 'maya',
  domains: ['sales'],
  role: 'builder',
};

test('executeRun threads the session identity into the request body', async () => {
  let captured: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(String(init.body));
    return { ok: true, text: async () => JSON.stringify({ ok: true, rowsAffected: 3 }) };
  }) as unknown as typeof fetch;

  const r = await executeRun(
    'CREATE OR REPLACE TABLE iceberg.sales.silver_x AS SELECT 1 AS a',
    IDENTITY,
    'sales',
  );
  assert.equal(r.ok, true);
  assert.equal(r.rowsAffected, 3);
  assert.equal(captured.principal, 'sales');
  assert.equal(captured.uid, 'maya');
  assert.deepEqual(captured.domains, ['sales']);
  assert.equal(captured.role, 'builder');
  assert.equal(captured.schema, 'sales');
});

test('executeRun throws on a query-tool rejection (ok:false) — no silent success', async () => {
  globalThis.fetch = (async () => ({
    ok: false,
    text: async () => JSON.stringify({ ok: false, error: 'write target schema forbidden' }),
  })) as unknown as typeof fetch;
  await assert.rejects(
    () => executeRun('CREATE OR REPLACE TABLE iceberg.marketing.x AS SELECT 1', IDENTITY),
    /write target schema forbidden/,
  );
});

test('executeRun throws when the query-tool is unreachable', async () => {
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => executeRun('DROP TABLE IF EXISTS iceberg.sales.x', IDENTITY),
    /Could not reach query-tool/,
  );
});
