/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { roleAtLeast } from '@/lib/core/session';
import { config } from '@/lib/core/config';
import { trace } from '@/lib/infra/agent-governed';
import { adoptConnectedDataset } from '@/lib/data/store';
import { resolveAdoptableExposure } from '@/lib/connections/exposed-tables';
import { cursorSupportForPlatform } from '@/lib/connections/operational-cursor';
import { parseSyncBlock, DATASET_SYNC_MODES, type DatasetSync } from '@/lib/data/dataset-schema';
import { reconcileSyncCron } from '@/lib/data/sync-cron';
import type { Dataset } from '@/lib/data/dataset-schema';

/**
 * The SHARED adopt-a-connected-table seam (lakehouse-import-exposure.md Phase 4). The Data-tab
 * Adopt panel's `/api/data/adopt` route AND the MCP `adopt_exposed_table` tool both call this,
 * so the whole discipline — external-connectors flag + `domain_admin` floor, server-side
 * re-resolution of the exposure (governance never trusted from the body), the listed-table
 * check, the required description, the LIVE-vs-SYNC branch (sync config validated + connection/
 * source PINNED to the exposure, CronJob provisioned), and the `dataset_adopted` trace — is
 * byte-identical across the UI and the front-door MCP path.
 */

function withStatus(err: Error, status: number): Error {
  (err as Error & { status?: number }).status = status;
  return err;
}
function fail(message: string, status: number): never {
  throw withStatus(new Error(message), status);
}

/** The sync-config shape the adopt dialog assembles (SyncPanel vocabulary). */
export type AdoptSyncInput = {
  mode?: string;
  cursor?: { kind?: string; column?: string };
  mergeKeys?: string[];
  lookbackMinutes?: number;
  schedule?: { cron?: string };
  enabled?: boolean;
};

export type AdoptExposedInput = {
  exposureId: string;
  schema: string;
  table: string;
  name?: string;
  description: string;
  /** SYNC-mode config the dialog assembled. Ignored for a live-mode exposure. */
  sync?: AdoptSyncInput;
};

export type AdoptExposedResult = {
  dataset: Dataset;
  cron?: Awaited<ReturnType<typeof reconcileSyncCron>>;
};

/**
 * Validate + create a governed Domain-tier dataset from one exposed table, AS the caller.
 * Throws `Error & { status }` on any gate/validation miss (the route folds it into a 4xx;
 * the MCP tool surfaces it as a typed tool error). Never trusts the request for governance:
 * the exposure is re-resolved, and its mode/tier/connection/catalog are authoritative.
 */
export async function adoptExposedTable(user: CurrentUser, input: AdoptExposedInput): Promise<AdoptExposedResult> {
  if (!config.externalConnectorsEnabled) fail('External connectors are not enabled.', 403);
  if (!roleAtLeast(user.role, 'domain_admin')) fail('Adopting a connected table requires a Domain admin.', 403);

  const exposureId = (input.exposureId ?? '').trim();
  const schema = (input.schema ?? '').trim();
  const table = (input.table ?? '').trim();
  const description = (input.description ?? '').trim();
  if (!exposureId || !schema || !table) fail('Pick an exposure and a table to adopt.', 400);
  if (!description) fail('A short description is required to adopt a connected table.', 400);

  const resolved = await resolveAdoptableExposure(exposureId, user);
  if (!resolved.ok) fail(resolved.reason, resolved.status);
  const listed = resolved.exposure.tables.some((t) => t.schema === schema && t.table === table);
  if (!listed) fail('That table is not part of this exposure.', 400);

  const mode = resolved.exposure.mode; // authoritative from the exposure

  // SYNC mode: assemble + validate the sync config. Connection + source are PINNED to the
  // resolved exposure (never the body); only mode/cursor/mergeKeys/schedule/enabled come from
  // the input, then re-validated via parseSyncBlock (same as the SyncPanel save path).
  let sync: DatasetSync | undefined;
  if (mode === 'sync') {
    const s = input.sync ?? {};
    const wantMode = typeof s.mode === 'string' && (DATASET_SYNC_MODES as string[]).includes(s.mode) ? s.mode : 'full-refresh';

    // OPERATIONAL sources: the cursor is not the caller's to name — the registry OWNS the
    // honest cursor for each entity (never guessed). Merge is unsupported (api-batch);
    // an incremental mode over a full-refresh-only entity is refused honestly; an
    // incremental mode over a cursor-bearing entity locks to the registry's cursor column.
    let opCursor: { kind: 'timestamp'; column: string } | undefined;
    if (resolved.operational && resolved.platform) {
      const support = cursorSupportForPlatform(resolved.platform, table);
      if (wantMode === 'merge') fail('Operational sources support full refresh or add-new-rows only (no update-by-key).', 400);
      if (wantMode !== 'full-refresh') {
        if (!support || !support.incremental || !support.cursorColumn) {
          fail(`This entity is full refresh only — ${support?.note ?? 'it exposes no incremental cursor'}.`, 400);
        }
        opCursor = { kind: 'timestamp', column: support!.cursorColumn! };
      }
    }

    const cron = (s.schedule?.cron ?? resolved.exposure.syncDefaults?.schedule ?? '0 6 * * *').trim();
    const candidate = {
      connectionId: resolved.exposure.connectionId,
      source: { schema, table },
      mode: wantMode,
      // Operational cursor is registry-locked; warehouse cursor comes from the input.
      ...(opCursor
        ? { cursor: opCursor }
        : s.cursor?.column
          ? { cursor: { kind: s.cursor.kind ?? 'timestamp', column: s.cursor.column } }
          : {}),
      ...(s.mergeKeys && s.mergeKeys.length > 0 ? { mergeKeys: s.mergeKeys } : {}),
      ...(typeof s.lookbackMinutes === 'number' ? { lookbackMinutes: s.lookbackMinutes } : {}),
      schedule: { cron },
      enabled: s.enabled !== false, // default ON — an adopted sync should start running
    };
    sync = parseSyncBlock(candidate) ?? undefined;
    if (!sync) fail('The sync configuration is incomplete or invalid — check the mode, cursor and schedule.', 400);
    if (sync.mode !== 'full-refresh' && !sync.cursor?.column) fail(`${sync.mode} sync needs a cursor column (or choose full refresh).`, 400);
    if (sync.mode === 'merge' && (!sync.mergeKeys || sync.mergeKeys.length === 0)) fail('Update-by-key sync needs at least one key column.', 400);
  }

  const dataset = adoptConnectedDataset(user, {
    name: (input.name ?? '').trim() || table,
    domain: resolved.domain,
    description,
    connected: {
      connectionId: resolved.exposure.connectionId,
      exposureId,
      source: { catalog: resolved.catalog, schema, table },
      mode,
      tier: resolved.exposure.tier,
      status: 'ok',
    },
    ...(sync ? { sync } : {}),
  });

  // Provision the per-dataset CronJob for an enabled sync (honest best-effort — the dataset
  // is already created either way).
  let cron: AdoptExposedResult['cron'];
  if (sync) cron = await reconcileSyncCron(dataset.id, sync);

  void trace({
    principal: user.domains[0] ?? user.id,
    tool: 'generate',
    input: {
      action: 'dataset_adopted',
      by: user.id,
      exposureId,
      connectionId: resolved.exposure.connectionId,
      source: `${resolved.catalog}.${schema}.${table}`,
      mode,
      tier: resolved.exposure.tier,
      domain: resolved.domain,
    },
    output: { datasetId: dataset.id },
    decision: 'allow',
  });

  return { dataset, ...(cron ? { cron } : {}) };
}
