/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * M13 — a service-credential connection can ROTATE its vaulted credential over the SAME
 * secretRef (frozen name+key), re-fingerprint, and clear a stale needs-reconnect back to
 * untested — WITHOUT delete+recreate (grants/exposures kept). Warehouse + flow-based OAuth
 * connections refuse rotation (they have their own re-auth paths).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '@/lib/core/config';

(config as { externalConnectorsEnabled: boolean }).externalConnectorsEnabled = true;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { createConnection, rotateConnectionCredential, getConnectionForUser, __resetConnections } = await import('./store.ts');
const { getSecretServerSide } = await import('@/lib/infra/secrets');

const admin = { id: 'a1', name: 'A', domains: ['sales'], role: 'admin' as const };

test('M13: rotate writes the new secret over the SAME ref + re-fingerprints', async () => {
  __resetConnections();
  const c = await createConnection(admin, { name: 'Gmail', template: 'gmail', endpoint: 'https://gmail.googleapis.com', credential: 'old-token' });
  const beforeRef = { ...c.secretRef };
  const beforeFp = c.secretFingerprint;
  // Simulate the expired-token state the rotation exists to recover from.
  c.health = 'needs-reconnect';

  const after = await rotateConnectionCredential(c.id, admin, 'new-token');
  // Same ref (frozen K8s identity), NEW value + fingerprint, health reset.
  assert.deepEqual(after.secretRef, beforeRef, 'secretRef name+key are unchanged (same vault slot)');
  assert.notEqual(after.secretFingerprint, beforeFp, 'fingerprint changed with the new value');
  assert.equal(after.health, 'untested', 'stale needs-reconnect cleared to untested (never a fake healthy)');
  assert.equal(getSecretServerSide(after.secretRef), 'new-token', 'the vault holds the new value');
});

test('M13: rotate refuses an empty credential', async () => {
  __resetConnections();
  const c = await createConnection(admin, { name: 'Gmail', template: 'gmail', endpoint: '', credential: 'tok' });
  await assert.rejects(() => rotateConnectionCredential(c.id, admin, ''), /new credential is required/i);
});

test('M13: rotate refuses a flow-based OAuth (Drive) connection', async () => {
  __resetConnections();
  const c = await createConnection(admin, { name: 'My Drive', template: 'gdrive', endpoint: '', credential: '' });
  await assert.rejects(() => rotateConnectionCredential(c.id, admin, 'x'), /OAuth flow|Connect/i);
});

test('M13: rotate refuses a warehouse connection', async () => {
  __resetConnections();
  const c = await createConnection(admin, {
    name: 'WH', template: 'warehouse', endpoint: '', credential: '',
    warehouse: { platform: 'glue', catalog: 'glue_sales', fields: { region: 'eu-central-1' } },
  });
  await assert.rejects(() => rotateConnectionCredential(c.id, admin, 'x'), /re-registering|warehouse/i);
});
