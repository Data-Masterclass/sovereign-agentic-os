/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { Connection } from '@/lib/connections/schema';
import { config } from '@/lib/core/config';
import { getSecretServerSide } from '@/lib/infra/secrets';
import { listConnectionsForUser, getConnectionForUser } from '@/lib/connections/store';
import {
  type OmConn,
  type OmRead,
  type OmWrite,
  type OmDomain,
  type OmDataProduct,
  type OmPatchOp,
  detectOmVersion,
  listOmDomains,
  listOmDataProducts,
  listOmTables,
  searchOmCatalog,
  getOmLineage,
  putOmEntity,
  patchOmEntity,
  putOmLineage,
  softDeleteOmEntity,
  restoreOmEntity,
  getOmEntityByFqn,
  createOmTestCaseResult,
} from '@/lib/data';
import {
  type OmDqPlan,
  type OmDqPreview,
  type OmDqSyncResult,
  buildDqSyncPlan,
  previewDqSync,
  applyDqSync,
} from '@/lib/connections/openmetadata-dq';
import type { CheckResult } from '@/lib/data/dq';
import {
  type OmSyncPlan,
  type OmSyncPreview,
  type OmSyncResult,
  type OmDatasetRef,
  type OmArchiveResult,
  buildOmSyncPlan,
  previewOmSync,
  applyOmSync,
  provisionOmNamespace,
  softDeleteOmDataset,
  reactivateOmDataset,
} from '@/lib/connections/openmetadata-sync';
import type { Dataset } from '@/lib/data';
import type { CatalogAsset, SourceSeverity } from '@/lib/data/catalog';

/**
 * External-OpenMetadata reads, per-connection (Phase 1 — read / discover only).
 *
 * This is the SERVER-SIDE bridge between an `om-catalog` {@link Connection} and
 * the pure per-connection OM client (`lib/data/openmetadata`). It resolves the
 * connection under the caller's identity (so DLS applies — a user never touches a
 * connection they can't see), reads the bot JWT from the vault (server-side only,
 * never returned/logged), and exposes the five read tools + a catalog-discovery
 * fold. There is NO write path here — Phase 1 never POSTs/PUTs/PATCHes OM.
 */

/** Build the pure OM client config from a resolved `om-catalog` connection. The
 *  bot JWT is dereferenced from the vault HERE and never leaves the server. */
function omConnFrom(c: Connection): OmConn {
  const token = getSecretServerSide(c.secretRef) ?? undefined;
  return { baseUrl: c.endpoint, token, fetchImpl: fetch, timeoutMs: 2500 };
}

/** The FIRST `om-catalog` connection the caller may see (their own personal one,
 *  or a shared one in their domain). Null when none is connected/visible — the
 *  discovery fold then contributes nothing (nothing changes when OM is off). */
export async function firstOmCatalogFor(user: CurrentUser): Promise<Connection | null> {
  if (!config.openmetadataConnectEnabled) return null;
  const conns = await listConnectionsForUser(user);
  return conns.find((c) => c.template === 'om-catalog') ?? null;
}

/** Resolve a specific `om-catalog` connection the caller may see (id from the UI/
 *  MCP). Throws 404 for an unseeable id (no existence leak); 400 for wrong type. */
export async function resolveOmCatalog(connId: string, user: CurrentUser): Promise<Connection> {
  const c = await getConnectionForUser(connId, user); // DLS guard (404)
  if (c.template !== 'om-catalog') {
    const e = new Error('Not an OpenMetadata (om-catalog) connection') as Error & { status?: number };
    e.status = 400;
    throw e;
  }
  return c;
}

// --------------------------------------------------------- per-tool reads (MCP) --

export function omListDomains(c: Connection): Promise<OmRead<OmDomain[]>> {
  return listOmDomains(omConnFrom(c));
}
export function omListDataProducts(c: Connection): Promise<OmRead<OmDataProduct[]>> {
  return listOmDataProducts(omConnFrom(c));
}
export function omListTables(c: Connection): Promise<OmRead<CatalogAsset[]>> {
  return listOmTables(omConnFrom(c));
}
export function omSearch(c: Connection, query: string): Promise<OmRead<CatalogAsset[]>> {
  return searchOmCatalog(omConnFrom(c), query);
}
export function omLineage(c: Connection, fqn: string, entity?: string): Promise<OmRead<unknown>> {
  return getOmLineage(omConnFrom(c), fqn, entity);
}
export function omVersion(c: Connection): Promise<string | undefined> {
  return detectOmVersion(omConnFrom(c));
}

// ---------------------------------------------------- catalog discovery fold ----

/** The shape the catalog assembler's optional `omConnection` source consumes. */
export type OmConnectionSource = {
  assets: CatalogAsset[] | null;
  status: string;
  severity?: SourceSeverity;
  ok?: boolean;
  count?: number;
};

/**
 * Fold an external OM's domains / data products / tables into the catalog union
 * as DLS-scoped discovery context. `visibleFqns` is the set of Iceberg FQNs the
 * caller may already see (from the registry/Trino sources) — OM tables are
 * CLAMPED to that set so the raw bot-token view is NEVER exposed to every user.
 * OM domains + data products are a discovery SIGNAL (counted in the status), not
 * an authorization boundary, so they are summarised rather than dumped as rows.
 *
 * Never throws: an unreachable/absent OM degrades to a calm source status.
 */
export async function omConnectionSource(
  c: Connection | null,
  visibleFqns: Set<string>,
): Promise<OmConnectionSource | null> {
  if (!c) return null; // no external OM connected/visible → the source is absent

  const conn = omConnFrom(c);
  const [domains, products, tables] = await Promise.all([
    listOmDomains(conn),
    listOmDataProducts(conn),
    listOmTables(conn),
  ]);

  // Unreachable (every read failed with the network reason) → calm reconnecting.
  const allUnreachable =
    !domains.ok && !products.ok && !tables.ok &&
    domains.reason === 'unreachable';
  if (allUnreachable) {
    return {
      assets: null,
      ok: false,
      count: 0,
      status: `reconnecting to external catalog "${c.name}"…`,
      severity: 'warn',
    };
  }

  // DLS clamp: only surface OM tables whose FQN maps to something the caller may
  // already see. OM Trino FQNs are `<service>.<icebergFqn>`; strip an optional
  // leading service segment so `<service>.iceberg.<schema>.<table>` matches the
  // caller's own `iceberg.<schema>.<table>` entitlement. Never widen the view.
  const omTables = tables.ok ? tables.data : [];
  const clamped: CatalogAsset[] = omTables
    .map((t) => {
      const fqn = t.fqn;
      const idx = fqn.indexOf('iceberg.');
      const icebergFqn = idx >= 0 ? fqn.slice(idx) : fqn;
      return { ...t, source: 'om-connection' as const, fqn: icebergFqn };
    })
    .filter((t) => visibleFqns.has(t.fqn));

  const domainCount = domains.ok ? domains.data.length : 0;
  const productCount = products.ok ? products.data.length : 0;
  const bits = [
    `${clamped.length} discoverable table${clamped.length === 1 ? '' : 's'}`,
    `${domainCount} domain${domainCount === 1 ? '' : 's'}`,
    `${productCount} data product${productCount === 1 ? '' : 's'}`,
  ];
  return {
    assets: clamped.length ? clamped : null,
    ok: true,
    count: clamped.length,
    status: `external catalog "${c.name}" · ${bits.join(' · ')} (DLS-scoped)`,
    severity: 'ok',
  };
}

// =============================================================================
// Phase 2 — SCOPED WRITE-BACK bridge (server-only)
// =============================================================================
//
// The WRITE path resolves a SEPARATE, least-privilege WRITER bot token (Guard 7 —
// its OM Role/Policy is scoped to the sovereign_os Service + OS Domain + the
// SovereignOS classification, provisioned by the chart Job). The writer token is
// vaulted under a DISTINCT secret key on the SAME connection (`om-writer-jwt`),
// never returned/logged. Every write REFUSES on an out-of-range OM version, is
// preview-first (Guard 6), additive-only (Guards 1–4) and yields on a human edit
// (Guard 5). `preview*` is READ-ONLY; `apply*` runs ONLY after governance approval.

/** The vault key the least-privilege WRITER bot JWT is stored under — DISTINCT from
 *  the read bot's `om-bot-jwt` (Guard 7: separate credential, separate OM Role). */
const OM_WRITER_KEY = 'om-writer-jwt';

/** Build a WRITE-capable OM client from a resolved `om-catalog` connection: the
 *  writer bot JWT (separate vault key) + the last-detected OM version so the write
 *  helpers can refuse outside the tested range. Falls back to the read secretRef's
 *  `name` for the vault namespace; the writer token is a DIFFERENT key there. */
function omWriteConnFrom(c: Connection): OmConn {
  const token = getSecretServerSide({ name: c.secretRef.name, key: OM_WRITER_KEY }) ?? undefined;
  return { baseUrl: c.endpoint, token, fetchImpl: fetch, timeoutMs: 5000, omVersion: c.om?.version };
}

/** The injected sync-client verbs bound to the WRITER connection — used by the apply
 *  step. `readEntityMeta` reads `{ version, updatedBy }` for the optimistic-concurrency
 *  yield (Guard 5); it uses the READ token (metadata is readable by the read bot). */
function syncVerbsFor(c: Connection) {
  const write = omWriteConnFrom(c);
  const read = omConnFrom(c);
  return {
    omVersion: c.om?.version,
    readEntityMeta: async (entityPath: string) => {
      const r = await getOmLineageRaw(read, entityPath);
      if (!r.ok) return null;
      const d = r.data as { version?: number; updatedBy?: string };
      return d && (d.version !== undefined || d.updatedBy !== undefined) ? { version: d.version, updatedBy: d.updatedBy } : null;
    },
    putEntity: (path: string, body: unknown): Promise<OmWrite> => putOmEntity(write, path, body),
    patchEntity: (entityPath: string, ops: OmPatchOp[]): Promise<OmWrite> => patchOmEntity(write, entityPath, ops),
    putLineage: async (edge: { fromFqn: string; toFqn: string }): Promise<OmWrite> => {
      // The pure client takes entity IDs; resolving FQN→id is an OM read. Kept simple:
      // OM's lineage PUT also accepts FQN refs, so we pass them through as ids here
      // (the fake client in tests matches this shape; a live resolver can be added).
      return putOmLineage(write, { fromId: edge.fromFqn, toId: edge.toFqn });
    },
  };
}

/** A tiny GET for entity metadata under the READ connection (never throws). Reuses
 *  the read client's never-throw discipline; returns the raw body for the caller. */
async function getOmLineageRaw(conn: OmConn, entityPath: string): Promise<OmRead<unknown>> {
  // entityPath is a full REST path like `/api/v1/tables/name/<fqn>`; read it directly.
  const base = conn.baseUrl.replace(/\/$/, '');
  try {
    const res = await conn.fetchImpl(`${base}${entityPath}`, {
      method: 'GET',
      headers: conn.token ? { accept: 'application/json', authorization: `Bearer ${conn.token}` } : { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, reason: `OpenMetadata ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

/** PREVIEW the additive sync plan for one OS dataset/product — READ-ONLY (Guard 6):
 *  computes the exact PUT bodies + JSON-Patch ops + lineage edges and renders the
 *  honest diff. NO write executes. `humanServiceFqn` (the customer's OM Trino service
 *  name) is optional; when absent, no human table is annotated at all. */
export function previewOmSyncForConnection(
  _c: Connection,
  dataset: Dataset,
  opts: { runId: string; humanServiceFqn?: string },
): OmSyncPreview {
  const plan = buildOmSyncPlan(dataset, opts);
  return previewOmSync(plan);
}

/** Recompute the plan (server-side, from the SAME dataset) and EXECUTE it through the
 *  writer connection AFTER governance approval. Never trusts a client-supplied plan —
 *  the payload only carries the datasetId + runId; the plan is rebuilt here so an
 *  approved item cannot smuggle a wider write. Provisions the OS namespace first
 *  (idempotent). Yields on a human edit (Guard 5). */
export async function applyOmSyncForConnection(
  c: Connection,
  dataset: Dataset,
  opts: { runId: string; humanServiceFqn?: string; lastSyncUpdatedBy?: string },
): Promise<OmSyncResult> {
  const write = omWriteConnFrom(c);
  // Guard 1 — provision the OS namespace shells idempotently before the first write.
  const prov = await provisionOmNamespace((path, body) => putOmEntity(write, path, body), c.om?.version);
  if (prov.refused) return { ok: false, applied: { creates: 0, patches: 0, edges: 0 }, conflicts: [], errors: [], refused: prov.refused };
  const plan = buildOmSyncPlan(dataset, { runId: opts.runId, humanServiceFqn: opts.humanServiceFqn });
  return applyOmSync(syncVerbsFor(c), plan, { lastSyncUpdatedBy: opts.lastSyncUpdatedBy });
}

export type { OmSyncPlan, OmSyncPreview, OmSyncResult };

// =============================================================================
// Phase 2 (DQ) — TestSuite / TestCase provisioning + result append
// =============================================================================
//
// The DQ leg of the write-back: provision OM TestSuites/TestCases for a governed
// dataset's DQ rules (preview → apply, all 7 guards), then append each governed
// run's verdict via the EXISTING createOmTestCaseResult(). Everything is GATED by
// `config.openmetadataDqWritebackEnabled` (default OFF) AND the fail-closed version
// guard; when OM is unreachable / out of range / the flag is off, the append is a
// NO-OP that never blocks the OS-side DQ run.

/** PREVIEW the DQ write-back plan for one dataset — READ-ONLY (Guard 6). */
export function previewDqSyncForConnection(_c: Connection, dataset: Dataset, opts: { runId: string }): OmDqPreview {
  return previewDqSync(buildDqSyncPlan(dataset, opts));
}

/** Recompute the DQ plan server-side and EXECUTE it through the writer connection AFTER
 *  governance approval. Never trusts a client-supplied plan (rebuilt here from the
 *  dataset). Refuses when the flag is off — the trigger holds the write behind approval,
 *  but the flag is the operator's master switch. */
export async function applyDqSyncForConnection(c: Connection, dataset: Dataset, opts: { runId: string }): Promise<OmDqSyncResult> {
  if (!config.openmetadataDqWritebackEnabled) {
    return { ok: false, applied: { suites: 0, testCases: 0 }, errors: [], refused: 'OpenMetadata DQ write-back is disabled (openmetadata.dqWriteback.enabled = false).' };
  }
  const write = omWriteConnFrom(c);
  const plan = buildDqSyncPlan(dataset, { runId: opts.runId });
  return applyDqSync({ putEntity: (path, body) => putOmEntity(write, path, body), omVersion: c.om?.version }, plan);
}

/**
 * Build a BEST-EFFORT result-appender for one dataset+connection: appends each governed
 * run's per-rule verdict to the matching OM TestCase time-series. HONEST + NON-BLOCKING:
 *  • returns `null` (no appender) when the flag is off or no OM is connected — the DQ run
 *    proceeds with zero OM coupling;
 *  • when present, it NEVER throws and NEVER fakes success — an unreachable / out-of-range
 *    OM simply appends nothing (the low-level verb refuses/degrades honestly).
 * The appender maps each CheckResult (pass/fail/not_run) → OM Success/Failed/Aborted and
 * PUTs to every TestCase FQN the plan provisioned for that rule.
 */
export async function omDqAppenderFor(
  user: CurrentUser,
  dataset: Dataset,
): Promise<((results: CheckResult[], ranAt: string) => Promise<void>) | null> {
  if (!config.openmetadataDqWritebackEnabled) return null;
  const c = await firstOmCatalogFor(user);
  if (!c) return null;
  const write = omWriteConnFrom(c);
  const { osDqTestCaseFqnsForRule } = await import('@/lib/connections/openmetadata-dq');

  return async (results: CheckResult[], ranAt: string): Promise<void> => {
    const ts = Date.parse(ranAt) || Date.now();
    const byRuleFqns = new Map<string, string[]>();
    for (const check of dataset.checks ?? []) byRuleFqns.set(check.id, osDqTestCaseFqnsForRule(dataset, check));
    for (const r of results) {
      const fqns = byRuleFqns.get(r.id);
      if (!fqns || fqns.length === 0) continue; // monitors / free-text intentions have no OM TestCase.
      // not_run ⇒ Aborted (honest — the check produced no verdict); fail ⇒ Failed; pass ⇒ Success.
      const status: 'Success' | 'Failed' | 'Aborted' = r.status === 'fail' ? 'Failed' : r.status === 'not_run' ? 'Aborted' : 'Success';
      const detail = r.violations != null ? `${r.violations} violation(s)` : (r.reason || r.status);
      for (const fqn of fqns) {
        try {
          await createOmTestCaseResult(write, fqn, { status, result: detail, timestamp: ts });
        } catch {
          /* best-effort — a failed append NEVER blocks the OS-side DQ run */
        }
      }
    }
  };
}

export type { OmDqPlan, OmDqPreview, OmDqSyncResult };

// =============================================================================
// Archive / restore hooks — OM soft-delete / reactivation (best-effort)
// =============================================================================
//
// Called AFTER the OS archive/unarchive has already succeeded. These are
// fire-and-forget from the API routes' perspective: if OM is unreachable or
// outside the tested version range, the error is silently swallowed — the
// OS-side archive always wins. Errors are returned for logging/tracing but
// NEVER re-thrown.

/** Build the {@link OmArchiveClient} surface bound to the WRITER connection. */
function archiveClientFrom(c: Connection): Parameters<typeof softDeleteOmDataset>[0] {
  const write = omWriteConnFrom(c);
  const read = omConnFrom(c);
  return {
    omVersion: c.om?.version,
    readEntityByFqn: async (entityType, fqn, includeDeleted = false) => {
      const r = await getOmEntityByFqn(read, entityType, fqn, includeDeleted);
      if (!r.ok) return r;
      const d = r.data;
      return {
        ok: true,
        data: {
          id: typeof d.id === 'string' ? d.id : undefined,
          extension: d.extension as Record<string, unknown> | undefined,
          deleted: d.deleted === true,
        },
      };
    },
    softDeleteEntity: (entityType, id) => softDeleteOmEntity(write, entityType, id),
    restoreEntity: (entityType, id) => restoreOmEntity(write, entityType, id),
  };
}

/**
 * Soft-delete the OS-namespace OM entities for an archived dataset. Best-effort:
 * never throws, never blocks the OS archive. Call AFTER the archive succeeds.
 * Skips silently when OM is unreachable or outside the tested version range.
 */
export async function omSoftDeleteForConnection(
  c: Connection,
  ref: OmDatasetRef,
): Promise<OmArchiveResult> {
  try {
    return await softDeleteOmDataset(archiveClientFrom(c), ref);
  } catch {
    return { ok: false, entities: {}, refused: 'unexpected error during OM soft-delete (best-effort, ignored)' };
  }
}

/**
 * Reactivate the OS-namespace OM entities for a restored (unarchived) dataset.
 * Best-effort: never throws, never blocks the OS unarchive.
 */
export async function omReactivateForConnection(
  c: Connection,
  ref: OmDatasetRef,
): Promise<OmArchiveResult> {
  try {
    return await reactivateOmDataset(archiveClientFrom(c), ref);
  } catch {
    return { ok: false, entities: {}, refused: 'unexpected error during OM reactivation (best-effort, ignored)' };
  }
}

export type { OmDatasetRef, OmArchiveResult };
