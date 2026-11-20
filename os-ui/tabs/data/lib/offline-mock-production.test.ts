/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    NODE_ENV=production + the flag unset ⇒ the Data ingest refuses, it does not pretend
 * USER STORY: As an agent driving the Data golden path I must get a typed ENGINE_UNAVAILABLE when
 *             the data-runner is down, not an "ok" report naming a Bronze table that was never
 *             written — in the run of 2026-11-18 create / transform / build all ran offline-mock
 *             and no agent noticed, because the only signal was a `mode` field nobody read.
 * ARCHITECTURE:
 *   - `fetch` is stubbed to reject, so `dataRunnerReachable()` / `queryToolReachable()` are false
 *     exactly as they are on a cluster whose data plane is down.
 *   - Asserts the two things that matter: the call THROWS (so no caller can carry on with a
 *     fabricated report) and the dataset's Bronze dot stays OFF (nothing was registered). Then
 *     re-runs the same flow with the switch at `allow` to prove the teaching path is intact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_UNAVAILABLE, OFFLINE_MOCK_ENV } from '@core/kernel/offline-mock';

const realFetch = globalThis.fetch;
// Fully offline: every probe (`/health`) and every call rejects, like a cluster with no data plane.
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { ingestUpload, ingestAndRegisterBronze } = await import('./ingest.ts');
const { createDataset, getDataset, __resetStore } = await import('./store.ts');
const { buildStage } = await import('./build/server.ts');

const cara = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' as const };
const CSV = 'order_id,net_amount\n1001,250.00\n1002,90.50';

async function withEnv(nodeEnv: string, flag: string | undefined, body: () => Promise<void>): Promise<void> {
  const prevNode = process.env.NODE_ENV;
  const prevFlag = process.env[OFFLINE_MOCK_ENV];
  (process.env as Record<string, string>).NODE_ENV = nodeEnv;
  if (flag === undefined) delete process.env[OFFLINE_MOCK_ENV];
  else process.env[OFFLINE_MOCK_ENV] = flag;
  try {
    await body();
  } finally {
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else (process.env as Record<string, string>).NODE_ENV = prevNode;
    if (prevFlag === undefined) delete process.env[OFFLINE_MOCK_ENV];
    else process.env[OFFLINE_MOCK_ENV] = prevFlag;
  }
}

test('PRODUCTION + flag unset: ingestUpload REFUSES — no table name, no row count, no preview', async () => {
  await withEnv('production', undefined, async () => {
    await assert.rejects(
      () => ingestUpload({ principal: 'cara', domains: [], datasetName: 'Orders', fileName: 'o.csv', body: Buffer.from(CSV) }),
      (e: Error & { code?: string; status?: number }) => {
        assert.equal(e.code, ENGINE_UNAVAILABLE);
        assert.equal(e.status, 503);
        assert.match(e.message, /data-runner|ingest/i, 'names what could not run');
        return true;
      },
    );
  });
});

test('PRODUCTION + flag unset: a refused ingest registers NO Bronze version (no dot without a landing)', async () => {
  __resetStore();
  const d = createDataset(cara, { name: 'Prod honesty', domain: 'sales' });
  await withEnv('production', undefined, async () => {
    await assert.rejects(() => ingestAndRegisterBronze(cara, d.id, 'o.csv', Buffer.from(CSV)));
  });
  assert.equal(getDataset(d.id, cara).versions.bronze.built, false, 'the dot stays off');
});

test('PRODUCTION + flag unset: a Build stage refuses rather than reporting an in-memory build ✓', async () => {
  __resetStore();
  const d = createDataset(cara, { name: 'Prod build honesty', domain: 'sales' });
  await withEnv('production', undefined, async () => {
    await assert.rejects(
      () => buildStage(getDataset(d.id, cara), 'silver', 'cara'),
      (e: Error & { code?: string }) => e.code === ENGINE_UNAVAILABLE,
    );
  });
});

test('PRODUCTION + an explicit `allow` restores the labelled teaching mock', async () => {
  __resetStore();
  const d = createDataset(cara, { name: 'Teaching in a cluster', domain: 'sales' });
  await withEnv('production', 'allow', async () => {
    const r = await ingestAndRegisterBronze(cara, d.id, 'o.csv', Buffer.from(CSV));
    assert.equal(r.ok, true);
    assert.equal(r.report.mode, 'offline-mock', 'honestly labelled, and only because somebody asked for it');
  });
});

test('a laptop (NODE_ENV=development) is byte-identical to before', async () => {
  __resetStore();
  const d = createDataset(cara, { name: 'Laptop flow', domain: 'sales' });
  await withEnv('development', undefined, async () => {
    const r = await ingestAndRegisterBronze(cara, d.id, 'o.csv', Buffer.from(CSV));
    assert.equal(r.ok, true);
    assert.equal(r.report.mode, 'offline-mock');
    assert.equal(r.report.rowCount, 2, 'the CSV head preview, exactly as before');
    assert.equal(getDataset(d.id, cara).versions.bronze.built, true);
  });
});

test.after(() => {
  globalThis.fetch = realFetch;
});
