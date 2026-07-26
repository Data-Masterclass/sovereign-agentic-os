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

// ---------------------------------------------------------------- kafka runs --

function kafkaFakes(over: Partial<SyncDeps> = {}) {
  const queried: Call[] = [];
  const f = fakes({
    dataset: () =>
      dataset({
        source: { schema: 'default', table: 'orders' },
        mode: 'append',
        cursor: { kind: 'kafka-offsets', column: '_partition_offset' },
      }),
    connectionCatalog: async () => 'kafka_events',
    query: async (sql) => {
      queried.push({ sql });
      if (/GROUP BY _partition_id/.test(sql)) return { rows: [['0', '100'], ['1', '7']] };
      return { rows: [] };
    },
    ...over,
  });
  return { ...f, queried };
}

test('kafka first load: CREATE OR REPLACE bounded to probed highs, offsets watermark', async () => {
  const { deps, executed, queried } = kafkaFakes({ watermark: () => null });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped && out.run!.status === 'ok');
  assert.match(queried[0].sql, /SELECT _partition_id, max\(_partition_offset\) AS hw FROM kafka_events\.default\.orders/);
  assert.equal(executed.length, 1, 'one CTAS, no delete-batch on first load');
  assert.match(executed[0].sql, /^CREATE OR REPLACE TABLE iceberg\.personal_lena\.bronze_orders AS SELECT \*, _partition_id AS _kafka_partition/);
  assert.match(executed[0].sql, /\(_partition_id = 0 AND _partition_offset <= 100\) OR \(_partition_id = 1 AND _partition_offset <= 7\)$/);
  assert.equal(out.run!.cursorAfter, '{"0":"100","1":"7"}');
  assert.ok(out.run!.batchId, 'first load lands under a batch id too');
});

test('kafka incremental: delete-batch + per-partition INSERT windows, marks merged', async () => {
  const { deps, executed } = kafkaFakes({ watermark: () => '{"0":"41","1":"7"}' });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped && out.run!.status === 'ok');
  assert.match(executed[0].sql, /^DELETE FROM iceberg\.personal_lena\.bronze_orders WHERE _batch_id = '/);
  assert.match(executed[1].sql, /^INSERT INTO iceberg\.personal_lena\.bronze_orders SELECT \*, _partition_id AS _kafka_partition/);
  assert.match(executed[1].sql, /\(_partition_id = 0 AND _partition_offset > 41 AND _partition_offset <= 100\)$/);
  assert.ok(!executed[1].sql.includes('_partition_id = 1'), 'partition 1 has nothing new — omitted');
  assert.equal(out.run!.cursorAfter, '{"0":"100","1":"7"}');
});

test('kafka nothing-advanced: honest zero-row ok run, no write', async () => {
  const { deps, executed } = kafkaFakes({ watermark: () => '{"0":"100","1":"7"}' });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped);
  assert.equal(out.run!.rowsAffected, 0);
  assert.equal(executed.length, 0, 'no write attempted');
  assert.equal(out.run!.cursorAfter, '{"0":"100","1":"7"}');
});

test('kafka empty topics (no partitions probed): zero-row run, cursor unchanged', async () => {
  const { deps, executed } = kafkaFakes({
    watermark: () => '{"0":"41"}',
    query: async () => ({ rows: [] }),
  });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped);
  assert.equal(out.run!.rowsAffected, 0);
  assert.equal(out.run!.cursorAfter, '{"0":"41"}');
  assert.equal(executed.length, 0);
});

test('kafka reset: full re-load replaces the copy and re-anchors the offsets', async () => {
  const { deps, executed } = kafkaFakes({ watermark: () => '{"0":"41","1":"7"}' });
  const out = await runDatasetSync('ds1', 'reset', deps);
  assert.ok(out.ok && !out.skipped && out.run!.status === 'ok');
  assert.equal(out.run!.mode, 'full-refresh');
  assert.match(executed[0].sql, /^CREATE OR REPLACE TABLE iceberg\.personal_lena\.bronze_orders AS SELECT \*, /);
  assert.match(executed[0].sql, /\(_partition_id = 0 AND _partition_offset <= 100\)/);
  assert.equal(out.run!.cursorBefore, null);
  assert.equal(out.run!.cursorAfter, '{"0":"100","1":"7"}');
});

// ---------------------------------------------- api-batch strategy (salesforce) --

test('api-batch: a non-catalog connection routes to the salesforce slice runner', async () => {
  const seen: Record<string, unknown>[] = [];
  const { deps } = fakes({
    dataset: () => dataset({ source: { schema: 'salesforce', table: 'Account' }, cursor: { kind: 'timestamp', column: 'SystemModstamp' } }),
    connectionCatalog: async () => null, // not a warehouse ⇒ api-batch
    watermark: () => '2026-06-01T00:00:00.000Z',
    salesforceSlice: async (args) => {
      seen.push(args as unknown as Record<string, unknown>);
      return { rowsAffected: 42, batchId: 'ds1.hw', highWatermark: '2026-06-30T00:00:00.000Z' };
    },
  });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped && out.run!.status === 'ok');
  assert.equal(seen.length, 1);
  const args = seen[0] as { object: string; mode: string; watermark: string | null; datasetSlug: string; target: { schema: string; table: string } };
  assert.equal(args.object, 'Account');
  assert.equal(args.mode, 'append');
  assert.equal(args.watermark, '2026-06-01T00:00:00.000Z');
  assert.equal(args.datasetSlug, 'orders');
  assert.deepEqual(args.target, { schema: 'personal_lena', table: 'bronze_orders' });
  assert.equal(out.run!.rowsAffected, 42);
  assert.equal(out.run!.cursorAfter, '2026-06-30T00:00:00.000Z');
  assert.equal(out.run!.batchId, 'ds1.hw');
});

test('api-batch: merge mode is an honest error (needs a federated SQL source)', async () => {
  const { deps } = fakes({
    dataset: () => dataset({ mode: 'merge', mergeKeys: ['Id'], cursor: { kind: 'timestamp', column: 'SystemModstamp' } }),
    connectionCatalog: async () => null,
    salesforceSlice: async () => { throw new Error('must not be called'); },
  });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped);
  assert.equal(out.run!.status, 'error');
  assert.match(out.run!.error!, /append or full-refresh only/);
});

test('api-batch: a slice failure records an honest error row, cursor unchanged', async () => {
  const { deps } = fakes({
    connectionCatalog: async () => null,
    watermark: () => '2026-06-01T00:00:00.000Z',
    salesforceSlice: async () => { throw new Error('Salesforce rate-limited; retry after 30s'); },
  });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped);
  assert.equal(out.run!.status, 'error');
  assert.match(out.run!.error!, /rate-limited/);
  assert.equal(out.run!.cursorBefore, '2026-06-01T00:00:00.000Z');
});

test('api-batch: a kajabi connection routes to the kajabi slice runner (not salesforce)', async () => {
  const seen: Record<string, unknown>[] = [];
  const { deps } = fakes({
    dataset: () => dataset({ source: { schema: 'kajabi', table: 'purchases' }, cursor: { kind: 'timestamp', column: 'updated_at' } }),
    connectionCatalog: async () => null, // not a warehouse ⇒ api-batch
    apiPlatform: async () => 'kajabi',
    watermark: () => '2026-06-01T00:00:00.000Z',
    salesforceSlice: async () => { throw new Error('must not be called'); },
    kajabiSlice: async (args) => {
      seen.push(args as unknown as Record<string, unknown>);
      return { rowsAffected: 5, batchId: 'ds1.hw', highWatermark: '2026-06-30T00:00:00.000Z' };
    },
  });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped && out.run!.status === 'ok');
  assert.equal(seen.length, 1);
  const args = seen[0] as { resource: string; mode: string; watermark: string | null; datasetSlug: string };
  assert.equal(args.resource, 'purchases');
  assert.equal(args.mode, 'append');
  assert.equal(args.watermark, '2026-06-01T00:00:00.000Z');
  assert.equal(args.datasetSlug, 'orders');
  assert.equal(out.run!.rowsAffected, 5);
  assert.equal(out.run!.cursorAfter, '2026-06-30T00:00:00.000Z');
  assert.equal(out.run!.batchId, 'ds1.hw');
});

test('api-batch: kajabi merge mode is an honest error naming the platform', async () => {
  const { deps } = fakes({
    dataset: () => dataset({ mode: 'merge', mergeKeys: ['id'], cursor: { kind: 'timestamp', column: 'updated_at' } }),
    connectionCatalog: async () => null,
    apiPlatform: async () => 'kajabi',
    kajabiSlice: async () => { throw new Error('must not be called'); },
    salesforceSlice: async () => { throw new Error('must not be called'); },
  });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped);
  assert.equal(out.run!.status, 'error');
  assert.match(out.run!.error!, /Kajabi sync supports append or full-refresh only/);
});

// ------------------------------------------- deterministic retry window (H2) --

const ERRORED_ATTEMPT = {
  id: 'ds1:prev', datasetId: 'ds1', startedAt: '2026-07-25T09:00:00.000Z',
  finishedAt: '2026-07-25T09:00:10.000Z', status: 'error' as const, mode: 'append' as const,
  cursorBefore: '50', highWatermark: '77', batchId: 'ds1.77', error: 'client timeout', ranBy: 'lena',
};

test('append retry after an unconfirmed attempt reuses ITS window — no fresh probe', async () => {
  const { deps, executed, queried } = fakes({
    watermark: () => '50',
    latestRun: () => ERRORED_ATTEMPT,
  });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped && out.run!.status === 'ok');
  assert.equal(queried.length, 0, 'the moved high watermark is NOT re-probed');
  // The deterministic batch id recomputes from the reused HW → the delete un-lands
  // exactly what the unconfirmed attempt may have landed, then the SAME slice re-appends.
  assert.equal(out.run!.batchId, sliceBatchId('ds1', '77'));
  assert.match(executed[0].sql, new RegExp(`_batch_id = '${sliceBatchId('ds1', '77')}'`));
  assert.match(executed[1].sql, /WHERE id > 50 AND id <= 77$/);
  assert.equal(out.run!.cursorAfter, '77');
});

test('a stale running marker (crash) is reused the same way', async () => {
  const { deps, executed } = fakes({
    watermark: () => '50',
    latestRun: () => ({ ...ERRORED_ATTEMPT, status: 'running' as const, error: undefined }),
  });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped && out.run!.status === 'ok');
  assert.match(executed[1].sql, /WHERE id > 50 AND id <= 77$/);
});

test('the window is NOT reused after a confirmed success or a moved watermark', async () => {
  // Latest run ok ⇒ fresh probe (HW 100 from the fake query).
  const ok = fakes({ watermark: () => '50', latestRun: () => ({ ...ERRORED_ATTEMPT, status: 'ok' as const }) });
  const o1 = await runDatasetSync('ds1', 'schedule', ok.deps);
  assert.match(ok.executed[1].sql, /WHERE id > 50 AND id <= 100$/);
  assert.ok(o1.ok);

  // The error row belongs to an OLDER watermark ⇒ its window is dead — fresh probe.
  const moved = fakes({ watermark: () => '60', latestRun: () => ERRORED_ATTEMPT });
  const o2 = await runDatasetSync('ds1', 'schedule', moved.deps);
  assert.match(moved.executed[1].sql, /WHERE id > 60 AND id <= 100$/);
  assert.ok(o2.ok);
});

test('an append run persists a running dispatch marker BEFORE the INSERT, finalized in place', async () => {
  // Real run store (record/update not faked): the marker must never survive as a
  // second row — one run, one row, running → ok.
  const dispatched: string[] = [];
  const { deps } = fakes({
    execute: async (sql: string) => {
      if (/^INSERT INTO/.test(sql)) {
        const rows = listSyncRuns('ds1');
        dispatched.push(...rows.map((r) => `${r.status}:${r.highWatermark ?? ''}:${r.batchId ?? ''}`));
      }
      return { rowsAffected: 7 };
    },
  });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped);
  assert.deepEqual(dispatched, [`running:100:${sliceBatchId('ds1', '100')}`],
    'the window {HW, batchId} was durable before the INSERT flew');
  const rows = listSyncRuns('ds1');
  assert.equal(rows.length, 1, 'the marker is finalized in place — no stray row');
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].highWatermark, '100', 'the window stays on the final row');
});

test('a failed INSERT finalizes the marker to error and KEEPS the window for the retry', async () => {
  const { deps } = fakes({
    execute: async (sql: string) => {
      if (/^INSERT INTO/.test(sql)) throw new Error('statement timeout');
      return { rowsAffected: 0 };
    },
  });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped);
  assert.equal(out.run!.status, 'error');
  const rows = listSyncRuns('ds1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].highWatermark, '100');
  assert.equal(rows[0].batchId, sliceBatchId('ds1', '100'));
  // …and the NEXT run (same watermark) would reuse exactly that window: the
  // executor's staleWindow predicate accepts this row.
  assert.equal(rows[0].cursorBefore, '50');
});

test('kafka incremental retry reuses the offsets window', async () => {
  const { deps, executed, queried } = kafkaFakes({
    watermark: () => '{"0":"41","1":"7"}',
    latestRun: () => ({
      id: 'ds1:prev', datasetId: 'ds1', startedAt: 'x', finishedAt: 'x',
      status: 'error' as const, mode: 'append' as const,
      cursorBefore: '{"0":"41","1":"7"}', highWatermark: '{"0":"90","1":"7"}',
      batchId: 'ds1.k', error: 'client timeout', ranBy: 'lena',
    }),
  });
  const out = await runDatasetSync('ds1', 'schedule', deps);
  assert.ok(out.ok && !out.skipped && out.run!.status === 'ok');
  assert.equal(queried.length, 0, 'partition highs are NOT re-probed');
  assert.match(executed[1].sql, /\(_partition_id = 0 AND _partition_offset > 41 AND _partition_offset <= 90\)$/);
  assert.equal(out.run!.cursorAfter, '{"0":"90","1":"7"}');
});
