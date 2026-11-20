/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A CSV with real-world headers ingests without renaming, under stable identifiers
 * USER STORY: As someone uploading `Order Date,größe,kunden-nr,Umsatz (€)` I want Bronze to land and
 *             register with no error, the columns to be usable identifiers, my original headers
 *             kept, and a second upload to reuse exactly the same names.
 * ARCHITECTURE:
 *   - The real `ingestAndRegisterBronze` on the laptop teaching path (data-runner unreachable,
 *     NODE_ENV=development), the `offline-mock-production.test.ts` pattern.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
(process.env as Record<string, string>).NODE_ENV = 'development';

const { ingestAndRegisterBronze } = await import('./ingest.ts');
const { createDataset, getDataset, __resetStore } = await import('./store.ts');

const cara = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' as const };

test('real-world CSV headers land under stable identifiers, with the source header recorded once', async () => {
  __resetStore();
  const d = createDataset(cara, { name: 'Bestellungen', domain: 'sales' });
  const r = await ingestAndRegisterBronze(cara, d.id, 'b.csv', Buffer.from('Order Date,größe,kunden-nr,Umsatz (€)\n2024-01-01,M,K7,9.5\n'));
  assert.equal(r.ok, true, r.report.error);
  assert.deepEqual(r.report.columns.map((c) => c.name), ['order_date', 'groesse', 'kunden_nr', 'umsatz_eur']);
  const cols = getDataset(d.id, cara).columns;
  assert.deepEqual(cols, [
    { name: 'order_date', description: '', source: 'Order Date' },
    { name: 'groesse', description: '', source: 'größe' },
    { name: 'kunden_nr', description: '', source: 'kunden-nr' },
    { name: 'umsatz_eur', description: '', source: 'Umsatz (€)' },
  ]);
  assert.equal(getDataset(d.id, cara).versions.bronze.built, true);

  // Re-upload with a new header: the recorded names are reused, only the new column is added.
  const again = await ingestAndRegisterBronze(cara, d.id, 'b.csv', Buffer.from('Order Date,größe,kunden-nr,Umsatz (€),Notiz\n2024-01-02,L,K8,1,x\n'));
  assert.equal(again.ok, true);
  assert.deepEqual(getDataset(d.id, cara).columns.map((c) => c.name), ['order_date', 'groesse', 'kunden_nr', 'umsatz_eur', 'notiz']);
});

test.after(() => {
  globalThis.fetch = realFetch;
});
