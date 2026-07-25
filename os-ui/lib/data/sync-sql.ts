/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * SCHEDULED INCREMENTAL SYNC — the PURE SQL builders (no server imports, mirrors
 * `lib/connections/warehouse/import.ts`). Given a sync spec, these compile the exact
 * governed statements the executor (`sync-run-server.ts`) runs through the SAME write
 * path a one-time import uses (`executeRun` → query-tool → Trino, AS the owner):
 *
 *   full-refresh → CREATE OR REPLACE TABLE … AS SELECT (reuses `buildImportCtas`)
 *   append       → DELETE-by-batch-id (retry idempotency) + INSERT INTO … SELECT …
 *                  WHERE cursor > W − lookback AND cursor <= HW, with `_loaded_at` +
 *                  `_batch_id` lineage columns on every landed row
 *   merge        → staging CTAS `_stg` + MERGE INTO … USING _stg + DROP staging
 *
 * plus the `SELECT max(cursor)` high-watermark probe (a governed READ against the
 * federated source) and the Iceberg maintenance statements (`expire_snapshots` +
 * `optimize` compaction). Every identifier is validated with the same rule the
 * federation FQN uses, and every cursor VALUE is validated + emitted as a typed
 * literal — nothing string-smuggled reaches Trino. The query-tool re-validates
 * shape + target-schema/role regardless.
 *
 * LATE-DATA LOOKBACK: source rows become visible in COMMIT order, not cursor order —
 * a long transaction stamps T0 but commits after the watermark passed T0. The slice
 * lower bound therefore backs off by `lookbackMinutes` (default 15 for timestamp
 * cursors, always 0 for number cursors); the overlap re-delivers late rows, which
 * merge absorbs by key and append tolerates as at-least-once delivery.
 */

import { buildImportCtas } from '../connections/warehouse/import.ts';
import { externalTableFqn } from '../connections/warehouse/catalog-props.ts';
import { isValidCatalogName, WarehouseError } from '../connections/warehouse/types.ts';

/** How a sync keeps the copy current. */
export type SyncMode = 'full-refresh' | 'append' | 'merge';
export const SYNC_MODES: SyncMode[] = ['full-refresh', 'append', 'merge'];

/** Cursor kinds. v1 implements `timestamp` + `number`; the other members reserve
 *  room for engine-native cursors (Delta table versions, BigQuery partition ids,
 *  Kafka offsets) without a schema change when they land. */
export type SyncCursorKind = 'timestamp' | 'number' | 'delta-version' | 'bq-partition' | 'kafka-offsets';
export type SyncCursor = { kind: SyncCursorKind; column: string };

/** The Iceberg target (`iceberg.<schema>.<table>`). */
export type SyncTarget = { schema: string; table: string };
/** The federated source table (`<catalog>.<schema>.<table>`). */
export type SyncSource = { catalog: string; schema: string; table: string };

/** A column name that is safe to fold into SQL unquoted (same rule as import.ts). */
function isSafeColumn(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function requireSafeColumn(name: string, what: string): string {
  if (!name || !isSafeColumn(name)) {
    throw new WarehouseError(`sync: unsafe ${what} '${name ?? ''}'`);
  }
  return name;
}

function targetFqn(target: SyncTarget): string {
  for (const [label, part] of [
    ['schema', target.schema],
    ['table', target.table],
  ] as const) {
    if (!part || !isValidCatalogName(part)) {
      throw new WarehouseError(`sync target: invalid ${label} '${part ?? ''}'`);
    }
  }
  return `iceberg.${target.schema}.${target.table}`;
}

/**
 * A validated, typed SQL literal for a cursor value. Timestamps are normalised
 * (ISO `T` → space, trailing `Z` stripped) and shape-checked so no quote can ride
 * in; numbers must be plain numeric literals. The other cursor kinds are declared
 * but not yet implemented (v1).
 */
export function cursorLiteral(kind: SyncCursorKind, value: string): string {
  const v = (value ?? '').trim();
  if (kind === 'number') {
    if (!/^-?[0-9]+(\.[0-9]+)?$/.test(v)) {
      throw new WarehouseError(`sync: cursor value '${v}' is not a numeric literal`);
    }
    return v;
  }
  if (kind === 'timestamp') {
    const norm = v.replace('T', ' ').replace(/Z$/, '').trim();
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}([ ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?)?$/.test(norm)) {
      throw new WarehouseError(`sync: cursor value '${v}' is not a timestamp literal`);
    }
    return `TIMESTAMP '${norm}'`;
  }
  throw new WarehouseError(`sync: cursor kind '${kind}' is not implemented yet`);
}

/** Full refresh: the same governed CTAS a one-time import runs, with OR REPLACE so
 *  a re-sync replaces the copy (never a silent no-op). */
export function fullRefreshSql(target: SyncTarget, source: SyncSource): string {
  return buildImportCtas({ domain: target.schema, name: target.table }, source).replace(
    /^CREATE TABLE /,
    'CREATE OR REPLACE TABLE ',
  );
}

/** The governed READ that probes the source's current high watermark. Run BEFORE the
 *  slice so `cursor > W AND cursor <= HW` is a stable window even while the source
 *  keeps writing. */
export function highWatermarkProbeSql(source: SyncSource, cursor: SyncCursor): string {
  const col = requireSafeColumn(cursor.column, 'cursor column');
  return `SELECT max(${col}) AS hw FROM ${externalTableFqn(source.catalog, source.schema, source.table)}`;
}

/** Default late-data lookback for timestamp cursors (minutes). Number cursors
 *  (monotonic ids) get no lookback. */
export const DEFAULT_LOOKBACK_MINUTES = 15;

export type SyncSliceInput = {
  target: SyncTarget;
  source: SyncSource;
  cursor: SyncCursor;
  /** Last synced cursor value (null ⇒ first incremental run: take everything up to HW). */
  watermark: string | null;
  /** The probed high watermark this run syncs up to. */
  highWatermark: string;
  /** Late-data lookback backing off the lower bound (timestamp cursors only;
   *  default {@link DEFAULT_LOOKBACK_MINUTES}). */
  lookbackMinutes?: number;
};

/** The `cursor > W − lookback AND cursor <= HW` window (lower bound omitted on the
 *  first run). Lookback applies to timestamp cursors only. */
function sliceWhere(input: SyncSliceInput): string {
  const { cursor, watermark, highWatermark } = input;
  const col = requireSafeColumn(cursor.column, 'cursor column');
  const hw = cursorLiteral(cursor.kind, highWatermark);
  if (watermark === null) return `${col} <= ${hw}`;
  const lb = cursor.kind === 'timestamp' ? (input.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES) : 0;
  if (!Number.isInteger(lb) || lb < 0) {
    throw new WarehouseError(`sync: invalid lookbackMinutes '${String(input.lookbackMinutes)}'`);
  }
  const lower = lb > 0 ? `${cursorLiteral(cursor.kind, watermark)} - INTERVAL '${lb}' MINUTE` : cursorLiteral(cursor.kind, watermark);
  return `${col} > ${lower} AND ${col} <= ${hw}`;
}

/** A batch id that is safe to fold into SQL as a quoted literal (same character set
 *  the query-tool's DELETE-by-batch-id shape admits — no quote can ride in). */
function requireSafeBatchId(batchId: string): string {
  if (!batchId || !/^[A-Za-z0-9_.:-]+$/.test(batchId)) {
    throw new WarehouseError(`sync: unsafe batch id '${batchId ?? ''}'`);
  }
  return batchId;
}

export type AppendInput = SyncSliceInput & {
  /** Deterministic per-slice batch id — lands as `_batch_id` on every row. */
  batchId: string;
  /** Run-start timestamp — lands as `_loaded_at` on every row. */
  loadedAt: string;
};

/** Incremental APPEND: insert only the new slice, stamped with the `_loaded_at` +
 *  `_batch_id` lineage columns (the batch id is what retry idempotency deletes by). */
export function appendSql(input: AppendInput): string {
  const dst = targetFqn(input.target);
  const src = externalTableFqn(input.source.catalog, input.source.schema, input.source.table);
  const batchId = requireSafeBatchId(input.batchId);
  const loadedAt = cursorLiteral('timestamp', input.loadedAt);
  return (
    `INSERT INTO ${dst} SELECT *, ${loadedAt} AS _loaded_at, '${batchId}' AS _batch_id ` +
    `FROM ${src} WHERE ${sliceWhere(input)}`
  );
}

/** Retry idempotency for append: un-land exactly ONE batch before re-appending it, so
 *  a retried slice never lands twice. Cheap no-op when the batch never landed. */
export function deleteBatchSql(target: SyncTarget, batchId: string): string {
  return `DELETE FROM ${targetFqn(target)} WHERE _batch_id = '${requireSafeBatchId(batchId)}'`;
}

export type MergeInput = SyncSliceInput & {
  /** The natural-key columns rows are matched on. */
  mergeKeys: string[];
  /** ALL target columns (discovered) — MERGE needs an explicit column list. */
  columns: string[];
};

/**
 * Incremental MERGE (update-by-key): land the slice in a staging CTAS, MERGE it into
 * the target on the keys, then drop the staging table. Three statements, run in
 * order; each is an allowlisted query-tool shape. The staging table lives in the SAME
 * schema as the target so the same authorization gate covers it.
 *
 * CADENCE NOTE: Trino Iceberg MERGE is merge-on-read — frequent small MERGEs
 * accumulate delete files and degrade reads. Merge mode is meant for slower cadences
 * (daily-ish); the periodic `optimize` maintenance compacts what does accumulate.
 */
export function mergeSql(input: MergeInput): { staging: string; merge: string; drop: string; stagingTable: string } {
  const dst = targetFqn(input.target);
  const src = externalTableFqn(input.source.catalog, input.source.schema, input.source.table);
  if (!input.mergeKeys || input.mergeKeys.length === 0) {
    throw new WarehouseError('sync: merge mode requires at least one merge key');
  }
  if (!input.columns || input.columns.length === 0) {
    throw new WarehouseError('sync: merge mode requires the discovered column list');
  }
  const keys = input.mergeKeys.map((k) => requireSafeColumn(k, 'merge key'));
  const cols = input.columns.map((c) => requireSafeColumn(c, 'column'));
  for (const k of keys) {
    if (!cols.includes(k)) throw new WarehouseError(`sync: merge key '${k}' is not one of the columns`);
  }
  const stagingTable = `${input.target.table}_stg`;
  if (!isValidCatalogName(stagingTable)) {
    throw new WarehouseError(`sync: staging table name '${stagingTable}' is invalid`);
  }
  const stg = `iceberg.${input.target.schema}.${stagingTable}`;
  const staging =
    `CREATE OR REPLACE TABLE ${stg} AS SELECT * FROM ${src} ` +
    `WHERE ${sliceWhere(input)}`;
  const on = keys.map((k) => `t.${k} = s.${k}`).join(' AND ');
  const updateCols = cols.filter((c) => !keys.includes(c));
  const whenMatched =
    updateCols.length > 0
      ? `WHEN MATCHED THEN UPDATE SET ${updateCols.map((c) => `${c} = s.${c}`).join(', ')} `
      : '';
  const merge =
    `MERGE INTO ${dst} AS t USING ${stg} AS s ON ${on} ` +
    whenMatched +
    `WHEN NOT MATCHED THEN INSERT (${cols.join(', ')}) VALUES (${cols.map((c) => `s.${c}`).join(', ')})`;
  const drop = `DROP TABLE IF EXISTS ${stg}`;
  return { staging, merge, drop, stagingTable };
}

/** Iceberg snapshot maintenance: expire snapshots older than `retention` (e.g. '7d').
 *  Only the literal `<n>d`/`<n>h` forms the query-tool guard admits are accepted. */
export function expireSnapshotsSql(target: SyncTarget, retention = '7d'): string {
  if (!/^[0-9]+[dh]$/.test(retention)) {
    throw new WarehouseError(`sync: invalid snapshot retention '${retention}' (use e.g. '7d' or '48h')`);
  }
  return `ALTER TABLE ${targetFqn(target)} EXECUTE expire_snapshots(retention_threshold => '${retention}')`;
}

/** Iceberg compaction: coalesce the many small files scheduled slices land. Run with
 *  expire_snapshots on the maintenance cadence — without it the table degrades. */
export function optimizeSql(target: SyncTarget): string {
  return `ALTER TABLE ${targetFqn(target)} EXECUTE optimize`;
}
