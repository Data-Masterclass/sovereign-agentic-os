/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore, createDataset, buildVersion, setDocs, transition } from '../data/store.ts';
import type { CurrentUser } from '../core/auth.ts';
import { getTabMetadata } from './metadata.ts';

/**
 * getTabMetadata is DLS-SCOPED: the entitled-scope overview a copilot is grounded on lists
 * ONLY what the caller may see. We prove it with the data source — one user must never see
 * another user's dataset schema/docs in their overview.
 */
const amir: CurrentUser = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'creator' };
const kenji: CurrentUser = { id: 'kenji', name: 'Kenji', domains: ['finance'], role: 'creator' };

beforeEach(() => __resetStore());

test('DLS: the data overview lists the caller BUILT datasets and never leaks another domain', async () => {
  // amir's own dataset (built) — visible to amir.
  const mine = createDataset(amir, { name: 'My Orders' });
  buildVersion(mine.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/o.dlt.yml' });

  // kenji's finance dataset (built, documented) — NEVER visible to amir.
  const secret = createDataset(kenji, { name: 'Finance Ledger' });
  buildVersion(secret.id, kenji, 'silver', { quality: 'passing', artifact: 'silver/l.sql' });
  setDocs(secret.id, kenji, { description: 'SECRET LEDGER', columns: [{ name: 'iban', description: 'account' }] });

  const forAmir = await getTabMetadata('data', amir);
  assert.equal(forAmir.tabId, 'data');
  assert.match(forAmir.text, /My Orders/);
  // The finance dataset, its docs and its columns can NOT appear in amir's overview.
  assert.doesNotMatch(forAmir.text, /SECRET LEDGER|iban|Finance Ledger/i);
  // Citations are only entitled ids — none point at the finance dataset.
  assert.ok(forAmir.citations.every((c) => !c.id.includes('finance')));
});

test('DLS: an empty scope yields an honest "nothing" overview, not a fabricated one', async () => {
  const meta = await getTabMetadata('data', amir);
  assert.match(meta.text, /no materialized datasets/i);
  assert.deepEqual(meta.citations, []);
});

test('every tab id resolves to a metadata source (no unhandled tab)', async () => {
  for (const tab of ['data', 'knowledge', 'files', 'metrics', 'connections'] as const) {
    const meta = await getTabMetadata(tab, amir);
    assert.equal(meta.tabId, tab);
    assert.equal(typeof meta.text, 'string');
    assert.ok(Array.isArray(meta.citations));
  }
});
