/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from './schema.ts';
import type { SecretRef } from '../secrets.ts';
import { purgePlan, purgeConnectionSecrets } from './connections-physical-delete.ts';

function conn(over: Partial<Connection> = {}): Connection {
  return {
    id: 'conn_1',
    template: 'salesforce-api',
    secretRef: { name: 'connection-sf', key: 'api_key' },
    principal: 'conn-sf',
    owner: 'amir',
    domain: 'sales',
    ...over,
  } as unknown as Connection;
}

/** A fake vault so the injected purge is testable without the server-only secrets module. */
function fakeVault(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  const k = (r: SecretRef) => `${r.name}/${r.key}`;
  return {
    has: (r: SecretRef) => m.has(k(r)),
    del: (r: SecretRef) => void m.delete(k(r)),
    size: () => m.size,
  };
}

test('purgePlan: a normal connection purges just its credential/token ref', () => {
  const plan = purgePlan(conn());
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].ref, { name: 'connection-sf', key: 'api_key' });
});

test('purgePlan: a Notion MCP connection ALSO purges its stored client registration', () => {
  const plan = purgePlan(conn({ template: 'notion-mcp', secretRef: { name: 'connection-notion', key: 'token' } }));
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((t) => t.ref.key), ['token', 'mcp-client']);
});

test('DELETE purges the credential from the vault + reports ok', () => {
  const v = fakeVault({ 'connection-sf/api_key': 'super-secret' });
  const report = purgeConnectionSecrets(conn(), v.has, v.del);
  assert.equal(v.size(), 0, 'vault entry is physically purged');
  assert.equal(report[0].ok, true);
  assert.match(report[0].reason, /purged from Secrets Manager/);
});

test('DELETE is honest when no secret was stored (ok:false, not a crash)', () => {
  const v = fakeVault(); // empty vault
  const report = purgeConnectionSecrets(conn(), v.has, v.del);
  assert.equal(report[0].ok, false);
  assert.match(report[0].reason, /no secret stored/);
});

test('DELETE is honest when a purge throws (vault unreachable)', () => {
  const report = purgeConnectionSecrets(
    conn(),
    () => true,
    () => {
      throw new Error('vault unreachable');
    },
  );
  assert.equal(report[0].ok, false);
  assert.match(report[0].reason, /vault unreachable/);
});
