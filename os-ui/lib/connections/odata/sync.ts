/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { serviceBearerHeader } from '@/lib/infra/service-bearer';
import { deleteBatchSql, type SyncTarget } from '@/lib/data/sync-sql';
import type { ExecuteIdentity } from '@/lib/infra/governed';
import { config } from '@/lib/core/config';
import { dialectFor } from './dialect.ts';
import { detectCursorProperty } from './metadata.ts';
import {
  resolveODataConn,
  fetchMetadata,
  firstPageUrl,
  pullPage,
  safeODataName,
  type OdConn,
  type OdFetch,
} from './client.ts';

/**
 * OData `api-batch` slice runner — the exact shape of `pullSalesforceSlice` /
 * `runSalesforceSlice`, generalized to the OData core (operational-system-connections.md,
 * Phase 4). Trino cannot reach an OData service, so a slice is pulled PAGE-BY-PAGE over
 * REST (following the server's own `__next`/`@odata.nextLink` so skiptoken paging is
 * honored verbatim) and streamed to the data-runner `/ingest-rows` (bounded memory: one
 * page in flight).
 *
 * CURSOR HONESTY: incremental sync is offered ONLY when the entity's parsed metadata
 * carries a change-timestamp property under a documented name (detectCursorProperty) —
 * DETECTED from EDMX, never guessed. An entity without one is full-refresh-only, and an
 * `append` request against it fails the run honestly. Deletes are never detected in v1.
 */

/** Bounded memory: exactly one page held at a time. `onBatch` gets each page's rows. */
export async function pullODataSlice(args: {
  conn: OdConn;
  version: 'V2' | 'V4';
  entitySet: string;
  cursorColumn: string | null;
  cursorType?: string;
  watermark: string | null;
  highWatermark: string | null;
  onBatch: (records: Record<string, unknown>[]) => Promise<void>;
}): Promise<{ ok: true; data: number } | { ok: false; reason: string }> {
  const dialect = dialectFor(args.version);
  const url = firstPageUrl(args.conn, dialect, {
    entitySet: args.entitySet,
    cursorColumn: args.cursorColumn,
    cursorType: args.cursorType,
    watermark: args.watermark,
    highWatermark: args.highWatermark,
  });
  let page = await pullPage(args.conn, dialect, url);
  let total = 0;
  // Defensive bound: only stops a broken paginator that loops (the CronJob deadline
  // also bounds a real slice), never a legitimate pull.
  for (let i = 0; i < 100000; i++) {
    if (!page.ok) return page;
    const rows = page.data.rows;
    if (rows.length > 0) {
      await args.onBatch(rows);
      total += rows.length;
    }
    if (!page.data.nextLink) return { ok: true, data: total };
    page = await pullPage(args.conn, dialect, page.data.nextLink);
  }
  return { ok: false, reason: 'OData pagination did not terminate (nextLink loop)' };
}

/** POST one row batch to the data-runner's /ingest-rows (PyIceberg append path). */
async function postIngestRows(
  url: string,
  fetchImpl: OdFetch,
  payload: { principal: string; dataset: string; rows: Record<string, unknown>[]; mode: 'append' | 'replace' },
): Promise<void> {
  const res = await fetchImpl(`${url}/ingest-rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...serviceBearerHeader() },
    body: JSON.stringify(payload),
    cache: 'no-store',
  } as RequestInit);
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) {
    throw new Error(`data-runner /ingest-rows ${res.status}: ${data.error ?? 'failed'}`);
  }
}

export type ODataSliceArgs = {
  connectionId: string;
  owner: CurrentUser;
  /** The entity set to sync (sync.source.table). */
  entitySet: string;
  mode: 'full-refresh' | 'append';
  watermark: string | null;
  datasetSlug: string;
  target: SyncTarget;
  identity: ExecuteIdentity;
  execute: (sql: string, identity: ExecuteIdentity) => Promise<{ rowsAffected: number | null }>;
  mkBatchId: (highWatermark: string) => string;
  window?: { highWatermark: string } | null;
  onWindow?: (highWatermark: string, batchId: string) => void;
  startedAt: string;
  // ---- test seams ----
  resolve?: (connId: string, owner: CurrentUser) => Promise<OdConn>;
  ingestUrl?: string;
  fetchImpl?: OdFetch;
};

/**
 * Run ONE OData sync slice — same honesty contract as the Salesforce/Kajabi paths: probe
 * the high watermark BEFORE the pull (cursored entities only), reuse an unconfirmed
 * window on retry, stream pages to the data-runner, and return the high watermark so the
 * caller advances the cursor only after a confirmed landing. A first load / reset streams
 * `replace` on its first batch (idempotent + creates the Bronze table). A full-refresh of
 * a cursorless entity derives its batch id from the run start.
 */
export async function runODataSlice(
  a: ODataSliceArgs,
): Promise<{ rowsAffected: number | null; batchId?: string; highWatermark: string | null }> {
  const conn = await (a.resolve ?? resolveODataConn)(a.connectionId, a.owner);
  const fetchImpl = a.fetchImpl ?? conn.fetchImpl;
  const client: OdConn = { ...conn, fetchImpl };
  const entitySet = safeODataName(a.entitySet);

  const meta = await fetchMetadata(client);
  if (!meta.ok) throw new Error(meta.reason);
  const set = meta.data.entitySets.find((s) => s.name.toLowerCase() === entitySet.toLowerCase());
  if (!set) throw new Error(`entity set '${entitySet}' not found in $metadata`);
  const cursor = detectCursorProperty(meta.data.entityTypes[set.entityType]);
  const firstLoad = a.mode === 'full-refresh' || a.watermark === null;

  if (a.mode === 'append' && !cursor) {
    throw new Error(
      `odata: '${entitySet}' has no detected change-timestamp property — incremental sync is not supported; use full-refresh`,
    );
  }

  const dialect = dialectFor(meta.data.version);

  // 1. High watermark: reuse an unconfirmed prior attempt's window (incremental only);
  //    else probe max(cursor) via an ordered-desc top-1 page BEFORE the pull. Cursorless
  //    full refreshes have no watermark — their batch id derives from the run start.
  let highWatermark: string | null = null;
  if (cursor) {
    if (!firstLoad && a.window) {
      highWatermark = a.window.highWatermark;
    } else {
      const probeUrl = `${client.serviceRoot.replace(/\/$/, '')}/${entitySet}?${new URLSearchParams({
        $format: 'json',
        $top: '1',
        $orderby: `${safeODataName(cursor.name)} desc`,
        $select: safeODataName(cursor.name),
      }).toString()}`;
      const probe = await pullPage(client, dialect, probeUrl);
      if (!probe.ok) throw new Error(probe.reason);
      const rawMax = probe.data.rows[0]?.[cursor.name];
      if (rawMax === undefined || rawMax === null || rawMax === '') {
        return { rowsAffected: 0, highWatermark: null }; // empty entity — honestly nothing to sync
      }
      highWatermark = String(rawMax);
    }
  }

  const watermark = firstLoad ? null : a.watermark;
  const batchId = a.mkBatchId(highWatermark ?? a.startedAt);

  // 2. Retry idempotency (incremental only): persist the dispatch marker, then un-land
  //    this batch before re-pulling. A first load streams `replace` on its first batch.
  if (!firstLoad) {
    a.onWindow?.(highWatermark ?? a.startedAt, batchId);
    await a.execute(deleteBatchSql(a.target, batchId), a.identity);
  }

  const ingestUrl = a.ingestUrl ?? config.dataRunnerUrl;
  let firstBatch = true;
  const pulled = await pullODataSlice({
    conn: client,
    version: meta.data.version,
    entitySet,
    cursorColumn: cursor?.name ?? null,
    cursorType: cursor?.type,
    watermark,
    highWatermark,
    onBatch: async (records) => {
      const rows = records.map((r) => flattenODataRow(r, a.startedAt, batchId));
      const mode: 'append' | 'replace' = firstLoad && firstBatch ? 'replace' : 'append';
      firstBatch = false;
      await postIngestRows(ingestUrl, fetchImpl, { principal: a.owner.id, dataset: a.datasetSlug, rows, mode });
    },
  });
  if (!pulled.ok) throw new Error(pulled.reason);
  if (firstLoad && pulled.data === 0) {
    return { rowsAffected: 0, highWatermark: null };
  }
  return { rowsAffected: pulled.data, batchId, highWatermark };
}

/** Flatten one OData row for Bronze: drop the OData control fields (`__metadata`,
 *  `@odata.*`) and nested navigation objects/arrays (Bronze is flat scalars — a nav is a
 *  link, not a value), and stamp lineage. Nothing is fabricated; unknown scalars pass through. */
export function flattenODataRow(row: Record<string, unknown>, loadedAt: string, batchId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === '__metadata' || k.startsWith('@odata.')) continue;
    if (v !== null && typeof v === 'object') continue; // nested nav / deferred link — skip
    out[k] = v;
  }
  out._loaded_at = loadedAt;
  out._batch_id = batchId;
  return out;
}
