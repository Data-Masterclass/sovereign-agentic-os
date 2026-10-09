/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * P0 A1 — the extract "Confirm — this is my Bronze" must LAND a physical table via
 * the SAME verify-then-dot ingest contract as a file upload, never a bare registry
 * write. Tests: CSV serialization, the happy path registers Bronze through the
 * ingest pipeline (honest offline-mock without a cluster), and a failed apply
 * registers NOTHING (no dot without a landing).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const _realFetch = globalThis.fetch;
// Default: fully offline (data-runner /health unreachable → honest offline-mock).
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { gridToCsv, landGridAsBronze } = await import('./ingest.ts');
const { createDataset, getDataset, __resetStore } = await import('./store.ts');

const cara = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' as const };

test('gridToCsv: RFC-4180 quoting for commas, quotes and newlines', () => {
  const csv = gridToCsv({
    columns: ['id', 'note'],
    rows: [['1', 'plain'], ['2', 'a,b'], ['3', 'say "hi"'], ['4', 'two\nlines']],
  }).toString('utf8');
  assert.equal(
    csv,
    'id,note\n1,plain\n2,"a,b"\n3,"say ""hi"""\n4,"two\nlines"',
  );
});

test('landGridAsBronze: lands through the ingest pipeline and lights Bronze ONLY then (offline-mock, honest label)', async () => {
  __resetStore();
  const d = createDataset(cara, { name: 'Extract landing test', domain: 'sales' });
  assert.equal(getDataset(d.id, cara).versions.bronze.built, false, 'no dot before landing');

  const r = await landGridAsBronze(cara, d.id, {
    columns: ['order_id', 'net_amount'],
    rows: [['1001', '250.00'], ['1002', '90.50']],
  });
  assert.equal(r.ok, true);
  assert.equal(r.report.mode, 'offline-mock', 'no cluster → the mode is honestly labelled');
  assert.match(r.report.table, /^iceberg\.personal_cara\.bronze_/, 'targets the caller’s OWN personal Bronze table');
  assert.equal(r.dataset?.versions.bronze.built, true, 'Bronze registered on a ✓ report');
  assert.equal(getDataset(d.id, cara).versions.bronze.built, true);
});

test('landGridAsBronze: an empty extract / a failed apply registers NOTHING (verify-then-dot)', async () => {
  __resetStore();
  const d = createDataset(cara, { name: 'Extract fail test', domain: 'sales' });

  // Empty grid → typed 400, no registration.
  await assert.rejects(
    () => landGridAsBronze(cara, d.id, { columns: [], rows: [] }),
    (e: Error & { status?: number }) => e.status === 400,
  );
  assert.equal(getDataset(d.id, cara).versions.bronze.built, false);

  // data-runner "reachable" but the physical apply fails → throws, and the dot
  // stays OFF (the registry write happens only after a ✓ report).
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes('/health')) return new Response('{"ok":true}', { status: 200 });
    throw new Error('apply blew up');
  }) as typeof fetch;
  try {
    await assert.rejects(() => landGridAsBronze(cara, d.id, { columns: ['a'], rows: [['1']] }));
    assert.equal(getDataset(d.id, cara).versions.bronze.built, false, 'no dot without a real landing');
  } finally {
    globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
  }
});

test('landGridAsBronze: an unseeable dataset id is refused before any ingest', async () => {
  __resetStore();
  const dan = { id: 'dan', name: 'Dan', domains: ['ops'], role: 'creator' as const };
  const d = createDataset(cara, { name: 'Private to Cara', domain: 'sales' });
  await assert.rejects(() => landGridAsBronze(dan, d.id, { columns: ['a'], rows: [['1']] }));
  assert.equal(getDataset(d.id, cara).versions.bronze.built, false);
});

test.after(() => {
  globalThis.fetch = _realFetch;
});
