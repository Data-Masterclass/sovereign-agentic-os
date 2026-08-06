/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * CONNECTIONS INTEGRITY WAVE (0.6.81) — the functional-audit fixes:
 *   • C1  delete tears down what it granted (exposures revoked + honest report targets).
 *   • C2  executeMock envelopes are LABELLED offline-mock; legacy SF preset is gone.
 *   • C5  slug uniqueness (two same-named creates never share principal/secretRef.name).
 *   • M3  an archived connection's tools are disabled (deny, honestly traced).
 * Offline: mirror/trace/k8s are unreachable no-ops so the in-process registries rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const {
  createConnection,
  __resetConnections,
  callConnectionTool,
  deleteConnection,
  setConnectionArchived,
  getConnectionForUser,
} = await import('./store.ts');
const { createExposureSet, allActiveExposures, __resetExposures } = await import('./exposures.ts');
const { __resetActionAdoptions } = await import('./action-adoptions.ts');

const admin = { id: 'a1', name: 'A', domains: ['sales'], activeDomain: 'sales', allDomains: ['sales'], role: 'admin' as const };

function reset() {
  __resetConnections();
  __resetExposures();
  __resetActionAdoptions();
}

async function warehouseConn() {
  // External warehouses are gated off in this offline test, so create a plain connection
  // and stamp a warehouse block via a database connection instead — the teardown path we
  // exercise (exposures) does not require the external-connector flag.
  return createConnection(admin, { name: 'DB', template: 'database', endpoint: '', credential: 'pw' });
}

test('C2 LABEL: an offline-mock tool result is stamped mode:offline-mock + note', async () => {
  reset();
  const c = await createConnection(admin, { name: 'Files', template: 'gdrive', endpoint: '', credential: 'tok' });
  const res = await callConnectionTool(c.id, admin, { tool: 'list_files', args: {} });
  assert.equal(res.decision, 'allow');
  const r = res.result as { mode?: string; note?: string };
  assert.equal(r.mode, 'offline-mock', 'result carries the offline-mock label');
  assert.match(String(r.note), /demonstration data/i);
});

test('C2 PRESET: the legacy Salesforce read/update preset tools are GONE', async () => {
  reset();
  const { templateByKey } = await import('./schema.ts');
  const t = templateByKey('salesforce-api')!;
  const names = t.tools.map((x) => x.name);
  for (const gone of ['read_account', 'read_opportunity', 'update_opportunity_amount']) {
    assert.ok(!names.includes(gone), `${gone} must be removed`);
  }
  // The two guard rails remain.
  assert.deepEqual(names.sort(), ['delete_record', 'mass_update']);
});

test('C5 SLUG: two same-named connections never share principal / secretRef.name', async () => {
  reset();
  const a = await createConnection(admin, { name: 'Twin', template: 'database', endpoint: '', credential: 'pw1' });
  const b = await createConnection(admin, { name: 'Twin', template: 'database', endpoint: '', credential: 'pw2' });
  assert.notEqual(a.principal, b.principal, 'principals must differ');
  assert.notEqual(a.secretRef.name, b.secretRef.name, 'vault secret names must differ');
});

test('M3 ARCHIVE: an archived connection denies every tool call', async () => {
  reset();
  const c = await createConnection(admin, { name: 'Files', template: 'gdrive', endpoint: '', credential: 'tok' });
  await setConnectionArchived(c.id, admin, true);
  const res = await callConnectionTool(c.id, admin, { tool: 'list_files', args: {} });
  assert.equal(res.decision, 'deny');
  assert.match(res.reason, /archived/i);
  // Unarchive restores it.
  await setConnectionArchived(c.id, admin, false);
  const ok = await callConnectionTool(c.id, admin, { tool: 'list_files', args: {} });
  assert.equal(ok.decision, 'allow');
});

test('C1 TEARDOWN: delete revokes the connection exposures and reports honest targets', async () => {
  reset();
  const c = await warehouseConn();
  // Stamp a warehouse block so the teardown's catalog branch runs (mocked k8s offline).
  const stamped = await getConnectionForUser(c.id, admin);
  (stamped as unknown as { template: string; warehouse: unknown }).template = 'warehouse';
  (stamped as unknown as { warehouse: { platform: string; catalog: string; config: Record<string, string> } }).warehouse = {
    platform: 'glue', catalog: 'glue_sales', config: {},
  };
  // Create an exposure of this connection.
  await createExposureSet(c.id, admin, {
    name: 'DB → Sales', domains: ['sales'], mode: 'live', tier: 'silver',
    tables: [{ schema: 'public', table: 't1' }],
  });
  assert.equal((await allActiveExposures()).filter((e) => e.connectionId === c.id).length, 1, 'one active exposure');

  const report = await deleteConnection(c.id, admin);
  assert.equal(report.recordDeleted, true);
  // The exposure is revoked (no longer active).
  assert.equal((await allActiveExposures()).filter((e) => e.connectionId === c.id).length, 0, 'exposure revoked by teardown');
  // The report includes the exposure revoke outcome AND the trino-catalog removal outcome.
  const targets = report.physical.map((p) => p.target).join(' | ');
  assert.match(targets, /exposure /, 'report mentions the revoked exposure');
  assert.match(targets, /trino catalog glue_sales/, 'report mentions the catalog/secret removal');
  // And still the vault credential purge.
  assert.match(targets, /credential/i, 'report still mentions the vault purge');
});
