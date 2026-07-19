/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { queryRun } from '@/lib/infra/governed';
import type { Role } from '@/lib/core/session';
import { emptyVersions, type Dataset } from './dataset-schema.ts';
import { getDataset, buildVersion } from './store.ts';
import { stageArtifact } from './panels.ts';
import { personalSchema, bronzeTarget } from './store-fqn.ts';
import { putObject, uploadObjectKey } from './object-store.ts';
import { INGEST_OBJECT_KEY, makeLiveAdapters } from './build/live.ts';
import { makeRealClients, dataRunnerReachable } from './build/live-clients.ts';
import { makeMockAdapters, newMockBackends } from './build/mocks.ts';
import { runAdapter } from './build/adapter.ts';

/**
 * The Data-tab INGEST orchestration (T3). One physical path for BOTH lanes — the
 * Datasets "Upload file" and the Personal-lane upload:
 *
 *   file bytes -> MinIO (uploads/<uid>/) -> data-runner /ingest
 *             -> iceberg.personal_<uid>.bronze_<slug>  (physical Iceberg table)
 *
 * The `principal` is ALWAYS the SESSION identity (`user.id`) — never the request
 * body — and the object key is forced under `uploads/<uid>/`. The Bronze is only
 * reported ✓ when the dlt adapter's apply(runner)+verify(governed probe SELECT) BOTH
 * pass, so the caller lights the Bronze dot only on a real, queryable landing.
 *
 * When the data-runner is unreachable (laptop) the ingest degrades to the honest
 * offline-mock: it records the load in-process and previews the file head, labelled
 * `offline-mock`, so the teaching flow runs without a cluster.
 */

export type Grid = { columns: string[]; rows: string[][] };
export type IngestReport = {
  ok: boolean;
  mode: 'live' | 'offline-mock';
  table: string;
  rowCount: number;
  columns: { name: string; type: string }[];
  preview: Grid;
  detail: string;
  error?: string;
};

// A minimal Dataset carrying just the name + the personal schema the bronze build
// targets; the dlt adapter reads only `name`/`domain`, but the full shape keeps types
// honest. Bronze always lands in the personal lane in M1 (promotion moves it later).
function bronzeCtxDataset(name: string, schema: string): Dataset {
  return {
    version: '1', id: '', name, owner: '', domain: schema, tier: 'dataset',
    visibility: 'private', folder: '/', description: '', versions: emptyVersions(),
    grants: [], measures: [], columns: [],
  };
}

/** Parse a small preview grid from CSV bytes (offline-mock only; the live path
 *  previews the physical table itself through the governed query path). */
function csvPreview(body: Buffer, limit = 20): Grid {
  const text = body.toString('utf8');
  const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  if (lines.length === 0 || !lines[0]) return { columns: [], rows: [] };
  const columns = lines.shift()!.split(',').map((c) => c.trim());
  const rows = lines.slice(0, limit).map((l) => l.split(',').map((c) => c.trim()));
  return { columns, rows };
}

export async function ingestUpload(input: {
  principal: string; // the SESSION user.id — never from the request body
  datasetName: string;
  fileName: string;
  body: Buffer;
}): Promise<IngestReport> {
  const schema = personalSchema(input.principal);
  const table = bronzeTarget(schema, input.datasetName);
  const objectKey = uploadObjectKey(input.principal, input.fileName);
  const dataset = bronzeCtxDataset(input.datasetName, schema);

  if (!(await dataRunnerReachable())) {
    // Offline teaching mock — no physical write; the row is honestly labelled.
    const mock = makeMockAdapters(newMockBackends());
    const row = await runAdapter(mock.dlt, {
      dataset, artifacts: { [INGEST_OBJECT_KEY]: objectKey }, principal: input.principal, stage: 'bronze',
    });
    const preview = csvPreview(input.body);
    return {
      ok: row.status === 'ok', mode: 'offline-mock', table,
      rowCount: preview.rows.length,
      columns: preview.columns.map((name) => ({ name, type: 'unknown' })),
      preview, detail: row.detail, error: row.error,
    };
  }

  // LIVE: stream the file to MinIO under the caller's own prefix, then run the dlt
  // adapter (apply = data-runner /ingest, verify = governed probe SELECT).
  await putObject(objectKey, input.body);
  const deps = await makeRealClients();
  const row = await runAdapter(makeLiveAdapters(deps).dlt, {
    dataset, artifacts: { [INGEST_OBJECT_KEY]: objectKey }, principal: input.principal, stage: 'bronze',
  });
  const outcome = (deps.dlt as { lastIngest?: { table: string; rowCount: number; columns: { name: string; type: string }[] } }).lastIngest;

  let preview: Grid = { columns: [], rows: [] };
  if (row.status === 'ok') {
    // Preview the PHYSICAL table through the governed path (proves it's queryable and
    // shows exactly what landed, OPA-masked to the caller).
    try {
      const q = await queryRun(`SELECT * FROM ${table} LIMIT 20`, input.principal);
      preview = { columns: q.columns, rows: q.rows };
    } catch { /* best-effort: verify already proved queryable */ }
  }
  return {
    ok: row.status === 'ok', mode: 'live', table,
    rowCount: outcome?.rowCount ?? 0,
    columns: outcome?.columns ?? [],
    preview, detail: row.detail, error: row.error,
  };
}

/**
 * The SHARED "ingest a file into a registry dataset" flow — one function for BOTH
 * front doors (the `/api/data/datasets/[id]/ingest` route's multipart upload and
 * the MCP `ingest_dataset` tool's inline text). It re-runs the exact same steps the
 * route always ran:
 *
 *   1. `getDataset(id, user)` — the canView guard (throws a tagged 403/404);
 *   2. `ingestUpload` — MinIO `uploads/<uid>/` + data-runner apply + governed verify,
 *      with `principal` = the SESSION user id (never a caller-supplied value);
 *   3. Bronze is registered (`buildVersion`) ONLY when apply+verify BOTH pass — the
 *      honesty contract: no dot without a real, queryable landing.
 *
 * Returns the report either way; `dataset` is non-null only on a registered Bronze.
 */
export async function ingestAndRegisterBronze(
  user: { id: string; domains: string[]; role: Role },
  datasetId: string,
  fileName: string,
  body: Buffer,
): Promise<{ ok: boolean; report: IngestReport; dataset: Dataset | null }> {
  const dataset = getDataset(datasetId, user); // view/edit-scope guard (throws 403/404)
  const report = await ingestUpload({
    principal: user.id, // session-bound — never the request body
    datasetName: dataset.name,
    fileName,
    body,
  });
  if (!report.ok) return { ok: false, report, dataset: null };
  // Verified queryable → NOW register the Bronze version (light the dot).
  const updated = buildVersion(datasetId, user, 'bronze', {
    quality: 'unknown', // raw upload: no dbt tests have run yet — honestly unknown.
    artifact: stageArtifact(dataset.name, 'bronze'),
  });
  return { ok: true, report, dataset: updated };
}

/** Serialize a preview grid to CSV bytes (RFC-4180 quoting) so an in-session extract
 *  can ride the SAME physical ingest pipeline as a file upload. */
export function gridToCsv(grid: Grid): Buffer {
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [grid.columns.map(esc).join(','), ...grid.rows.map((r) => r.map(esc).join(','))];
  return Buffer.from(lines.join('\n'), 'utf8');
}

/**
 * LAND an in-session masked extract as a dataset's REAL Bronze — the fix for the
 * phantom-Bronze confirm (P0 A1): "Confirm — this is my Bronze" used to post a bare
 * `{layer:'bronze'}` registry write, lighting the dot with NO physical table. Instead,
 * the extract grid is serialized to CSV and pushed through the EXACT SAME
 * `ingestAndRegisterBronze` pipeline as a file upload (MinIO → data-runner →
 * `iceberg.personal_<uid>.bronze_<slug>`, register ONLY on apply+verify ✓) — one
 * verify-then-dot contract for every Bronze entry point.
 */
export async function landGridAsBronze(
  user: { id: string; domains: string[]; role: Role },
  datasetId: string,
  grid: Grid,
): Promise<{ ok: boolean; report: IngestReport; dataset: Dataset | null }> {
  if (grid.columns.length === 0) {
    throw Object.assign(new Error('the extract has no columns — pull it again before confirming'), { status: 400 });
  }
  return ingestAndRegisterBronze(user, datasetId, 'extract.csv', gridToCsv(grid));
}

/** List the caller's PHYSICAL personal Bronze tables (durable; survives restarts) —
 *  the Personal-lane "Your private data". Reads `information_schema` through the
 *  governed query path as the principal; degrades to [] when Trino is unreachable. */
export async function listPersonalTables(
  principal: string,
): Promise<{ id: string; name: string; origin: 'upload'; columns: string[]; rowCount: number | null }[]> {
  const schema = personalSchema(principal);
  try {
    const q = await queryRun(
      `SELECT table_name, column_name FROM iceberg.information_schema.columns ` +
        `WHERE table_schema = '${schema}' ORDER BY table_name, ordinal_position`,
      principal,
    );
    const byTable = new Map<string, string[]>();
    for (const [t, c] of q.rows) {
      if (!byTable.has(t)) byTable.set(t, []);
      byTable.get(t)!.push(c);
    }
    return [...byTable.entries()].map(([t, cols]) => ({
      id: `${schema}.${t}`,
      name: t.replace(/^bronze_/, ''),
      origin: 'upload' as const,
      columns: cols,
      rowCount: null, // per-table counts are an extra probe; shown on upload, omitted in the list.
    }));
  } catch {
    return [];
  }
}
