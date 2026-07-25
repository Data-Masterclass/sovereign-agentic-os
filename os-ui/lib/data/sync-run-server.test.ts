/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { runDatasetSync, sliceBatchId, mirrorLease, type SyncDeps } from './sync-run-server.ts';
import { __resetSyncRuns, listSyncRuns, currentWatermark } from './sync-runs.ts';
import { emptyVersions, type Dataset, type DatasetSync } from './dataset-schema.ts';

const OWNER: CurrentUser = {
  id: 'lena', name: 'Lena', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator',
};

function dataset(sync?: Partial<DatasetSync>, over: Partial<Dataset> = {}): Dataset {
  return {
    version: '1', id: 'ds1', name: 'Orders', owner: 'lena', domain: 'sales', tier: 'dataset',
    visibility: 'private', folder: '/', description: '', grants: [], measures: [], columns: [],
    versions: emptyVersions(),
    sync: {
      connectionId: 'conn1',
      source: { schema: 'public', table: 'orders' },
      mode: 'append',
      cursor: { kind: 'number', column: 'id' },
      schedule: { cron: '0 * * * *' },
      enabled: true,
      ...sync,
    },
    ...over,
  };
}

type Call = { sql: string };

function fakes(over: Partial<SyncDeps> = {}) {
  const executed: Call[] = [];
  const queried: Call[] = [];
  const deps: SyncDeps = {
    dataset: () => dataset(),
    resolveOwner: async () => OWNER,
    connectionCatalog: async () => 'pg_shop',
    query: async (sql) => {
      queried.push({ sql });
      return { rows: [['100']] }; // HW probe / describe default
    },
    execute: async (sql) => {
      executed.push({ sql });
      return { rowsAffected: 7 };
    },
    markBronzeBuilt: () => {},
    watermark: () => '50',
    quarantined: () => false,
    lastMaintenance: () => new Date().toISOString(), // fresh — no maintenance by default
    lease: { acquire: async () => 'acquired', release: () => {} },
    now: () => '2026-07-25T10:00:00.000Z',
    ...over,
  };
  return { deps, executed, queried };
}

beforeEach(() => __resetSyncRuns());

test('append run: probe → delete-batch → insert, cursor advances only after the write', async () => {
  const { deps, executed, queried } = fakes();
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped && out.run);
  assert.match(queried[0].sql, /SELECT max\(id\) AS hw FROM pg_shop\.public\.orders/);
  assert.match(executed[0].sql, /^DELETE FROM iceberg\.personal_lena\.bronze_orders WHERE _batch_id = '/);
  assert.match(executed[1].sql, /^INSERT INTO iceberg\.personal_lena\.bronze_orders SELECT \*, /);
  assert.match(executed[1].sql, /WHERE id > 50 AND id <= 100$/);
  const run = out.run!;
  assert.equal(run.status, 'ok');
  assert.equal(run.cursorBefore, '50');
  assert.equal(run.cursorAfter, '100');
  assert.equal(run.rowsAffected, 7);
  assert.equal(currentWatermark('ds1'), '100');
});

test('failed write: honest error row, cursor does NOT advance', async () => {
  const { deps } = fakes({ execute: async () => { throw new Error('Trino down'); } });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped);
  assert.equal(out.run!.status, 'error');
  assert.match(out.run!.error!, /Trino down/);
  assert.equal(currentWatermark('ds1'), null, 'no ok run yet — watermark unchanged');
});

test('held lease: skip-not-queue with an honest skipped row', async () => {
  const { deps, executed } = fakes({ lease: { acquire: async () => 'held', release: () => {} } });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && out.skipped);
  assert.equal(out.run?.status, 'skipped');
  assert.equal(executed.length, 0, 'nothing executed');
});

test('scheduled trigger skips disabled and quarantined syncs (no run rows)', async () => {
  const off = fakes({ dataset: () => dataset({ enabled: false }) });
  const o1 = await runDatasetSync('ds1', 'schedule', off.deps);
  assert.ok(o1.ok && o1.skipped && /disabled/i.test(o1.reason));

  const q = fakes({ quarantined: () => true });
  const o2 = await runDatasetSync('ds1', 'schedule', q.deps);
  assert.ok(o2.ok && o2.skipped && /quarantined/i.test(o2.reason));
  assert.equal(listSyncRuns('ds1').length, 0);
});

test('manual trigger runs even when disabled or quarantined (the recovery path)', async () => {
  const { deps, executed } = fakes({ dataset: () => dataset({ enabled: false }), quarantined: () => true });
  const out = await runDatasetSync('ds1', 'manual', deps);
  assert.ok(out.ok && !out.skipped && out.run!.status === 'ok');
  assert.ok(executed.length > 0);
});

test('unresolvable owner: clean 409, never a service principal', async () => {
  const { deps } = fakes({ resolveOwner: async () => null });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(!out.ok);
  assert.equal(out.status, 409);
  assert.match(out.error, /never fall back to a service principal/);
});

test('empty source (null HW probe): honest zero-row ok run, cursor unchanged', async () => {
  const { deps, executed } = fakes({
    query: async () => ({ rows: [['None']] }),
    watermark: () => '50',
  });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped);
  assert.equal(out.run!.rowsAffected, 0);
  assert.equal(out.run!.cursorAfter, '50');
  assert.equal(executed.length, 0, 'no write attempted');
});

test('merge run: staging CTAS + MERGE + DROP with lineage columns filtered out', async () => {
  const { deps, executed } = fakes({
    dataset: () => dataset({ mode: 'merge', mergeKeys: ['id'] }),
    query: async (sql) =>
      /describe/i.test(sql)
        ? { rows: [['id', 'bigint'], ['amount', 'double'], ['_loaded_at', 'timestamp'], ['_batch_id', 'varchar']] }
        : { rows: [['100']] },
  });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped && out.run!.status === 'ok');
  assert.match(executed[0].sql, /^CREATE OR REPLACE TABLE iceberg\.personal_lena\.bronze_orders_stg AS /);
  assert.match(executed[1].sql, /^MERGE INTO iceberg\.personal_lena\.bronze_orders AS t /);
  assert.ok(!executed[1].sql.includes('_loaded_at'), 'lineage columns never enter the MERGE');
  assert.match(executed[2].sql, /^DROP TABLE IF EXISTS iceberg\.personal_lena\.bronze_orders_stg$/);
});

test('reset trigger: full-refresh CTAS, cursor re-anchored to the probed HW', async () => {
  const { deps, executed } = fakes({ watermark: () => '50' });
  const out = await runDatasetSync('ds1', 'reset', deps);
  assert.ok(out.ok && !out.skipped);
  const run = out.run!;
  assert.equal(run.mode, 'full-refresh');
  assert.match(executed[0].sql, /^CREATE OR REPLACE TABLE iceberg\.personal_lena\.bronze_orders AS SELECT \* FROM pg_shop\.public\.orders$/);
  assert.equal(run.cursorBefore, null, 'reset clears the cursor');
  assert.equal(run.cursorAfter, '100', 're-anchored so the next increment starts fresh');
});

test('stale maintenance (>24h) triggers optimize + expire_snapshots, recorded on the run', async () => {
  const { deps, executed } = fakes({ lastMaintenance: () => null });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped);
  assert.equal(out.run!.maintenance, true);
  const sqls = executed.map((c) => c.sql);
  assert.ok(sqls.some((s) => / EXECUTE optimize$/.test(s)));
  assert.ok(sqls.some((s) => /EXECUTE expire_snapshots\(retention_threshold => '7d'\)$/.test(s)));
});

test('maintenance failure never fails a successful sync', async () => {
  const { deps } = fakes({
    lastMaintenance: () => null,
    execute: async (sql) => {
      if (/EXECUTE optimize/.test(sql)) throw new Error('compaction hiccup');
      return { rowsAffected: 3 };
    },
  });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped);
  assert.equal(out.run!.status, 'ok');
  assert.equal(out.run!.maintenance, undefined);
});

test('staleDownstream flags built silver/gold when bronze refreshes', async () => {
  const v = emptyVersions();
  v.silver = { built: true, passThrough: false, quality: 'unknown', updatedAt: '2026-01-01', artifact: null };
  const { deps } = fakes({ dataset: () => dataset({}, { versions: v }) });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped);
  assert.deepEqual(out.run!.staleDownstream, ['silver']);
});

test('sliceBatchId is deterministic and guard-safe', () => {
  assert.equal(sliceBatchId('ds1', '2026-01-01 00:00:00.000'), sliceBatchId('ds1', '2026-01-01 00:00:00.000'));
  assert.match(sliceBatchId('ds1', '2026-01-01 00:00:00.000'), /^[A-Za-z0-9_.:-]+$/);
});

test('mirrorLease: token claim + stale reclaim + fresh hold', async () => {
  const docs = new Map<string, unknown>();
  const fakeMirror = {
    claim: async (id: string) => (docs.delete(id) ? 'won' : 'lost') as 'won' | 'lost',
    getDoc: async (id: string) => docs.get(id) ?? null,
    writeThrough: (id: string, doc: unknown) => void docs.set(id, doc),
    deleteThrough: (id: string) => void docs.delete(id),
  };
  const lease = mirrorLease(fakeMirror as never, 60 * 60 * 1000);
  const t0 = '2026-07-25T10:00:00.000Z';
  // First ever acquire (never seeded) → acquired.
  assert.equal(await lease.acquire('ds1', t0), 'acquired');
  // While held (fresh marker) a second caller is refused.
  assert.equal(await lease.acquire('ds1', '2026-07-25T10:05:00.000Z'), 'held');
  // Released → token back → claim wins.
  lease.release('ds1', '2026-07-25T10:06:00.000Z');
  assert.equal(await lease.acquire('ds1', '2026-07-25T10:07:00.000Z'), 'acquired');
  // A crashed holder (stale marker) is reclaimed after the TTL.
  assert.equal(await lease.acquire('ds1', '2026-07-25T12:00:00.000Z'), 'acquired');
});
