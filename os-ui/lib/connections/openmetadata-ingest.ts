/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { Connection } from '@/lib/connections/schema';
import type { Dataset } from '@/lib/data';
import { config } from '@/lib/core/config';
import { listDatasets, getDataset } from '@/lib/data/store';
import {
  previewOmSyncForConnection,
  applyOmSyncForConnection,
  previewDqSyncForConnection,
  applyDqSyncForConnection,
  firstOmCatalogFor,
} from '@/lib/connections/openmetadata';
import type { OmSyncPreview, OmSyncResult } from '@/lib/connections/openmetadata-sync';
import type { OmDqPreview, OmDqSyncResult } from '@/lib/connections/openmetadata-dq';

/**
 * #147 — INGESTION ORCHESTRATOR: keep a customer's OpenMetadata reflecting the LIVE
 * governed lakehouse, in ONE governed "refresh catalog" pass.
 *
 * OpenMetadata was HOLLOW: the metadata + DQ write-back engines exist
 * (`openmetadata-sync.ts`, `openmetadata-dq.ts`) but were only ever driven ONE
 * dataset at a time by a human MCP call. This orchestrator FOLDS those SAME engines
 * over EVERY governed gold/silver mart in the registry the caller may see (DLS-scoped),
 * so a single trigger (or the scheduled CronJob) ensures OM has, for each mart:
 *   • the Table entity (schema + columns) under the dedicated `sovereign_os` Service,
 *   • the OS Data Product (for product-tier marts) + its consumption lineage edge,
 *   • the linked DQ TestSuite / TestCases (Phase 2 DQ).
 *
 * It REUSES the existing preview/apply engines verbatim (import only — no re-implementation)
 * so all seven guards + `omVersionWritable` fail-closed apply UNCHANGED:
 *   1. namespace isolation to `sovereign_os`      5. optimistic concurrency
 *   2. additive JSON-Patch only                   6. dry-run / preview → apply
 *   3. managedBy=SovereignOS                       7. least-privilege writer bot + version range
 *   4. idempotent create-or-update
 *
 * HONESTY (Karpathy goal-driven): a ✗ catalogs NOTHING. Preview is READ-ONLY (no I/O
 * against OM). Apply runs the engines per dataset; when OM is unreachable / out of the
 * tested version range / a leg is disabled, that dataset degrades to a no-op with the
 * honest reason recorded — it NEVER fabricates success and NEVER blocks. Cross-namespace
 * upstream lineage (bronze→silver→gold, mart→exposure) over the customer's OWN Trino
 * tables is left to OM's native crawl (the `openmetadata-trino-ingestion` CronJob), so
 * this orchestrator only ever writes ADDITIVELY inside the OS namespace.
 */

/** One dataset's slice of the refresh preview (metadata leg + optional DQ leg). */
export type OmIngestDatasetPreview = {
  datasetId: string;
  name: string;
  domain: string;
  tier: Dataset['tier'];
  /** The additive metadata plan (tables/product/lineage). */
  metadata: OmSyncPreview;
  /** The DQ plan (TestSuites/TestCases) — present only when DQ write-back is enabled. */
  dq?: OmDqPreview;
};

export type OmIngestPreview = {
  ok: boolean;
  /** The om-catalog connection the refresh would write through (null → nothing to do). */
  connectionName: string | null;
  /** One entry per governed mart the caller may see (only the syncable ones are `ok`). */
  datasets: OmIngestDatasetPreview[];
  /** Roll-up counts across every syncable dataset. */
  totals: { datasets: number; syncable: number; creates: number; edges: number; suites: number; testCases: number };
  summary: string;
};

/** One dataset's slice of the applied refresh. */
export type OmIngestDatasetResult = {
  datasetId: string;
  name: string;
  /** The metadata write result (creates/patches/edges + conflicts/refused). */
  metadata: OmSyncResult;
  /** The DQ write result — present only when DQ write-back is enabled. */
  dq?: OmDqSyncResult;
};

export type OmIngestResult = {
  ok: boolean;
  connectionName: string | null;
  datasets: OmIngestDatasetResult[];
  totals: { datasets: number; creates: number; patches: number; edges: number; suites: number; testCases: number };
  summary: string;
};

/**
 * The DLS-scoped governed marts the caller may catalog: promoted assets + certified
 * products (never a private `dataset`), archived ones already excluded by the store.
 * Loads each full {@link Dataset} (canView re-checked in `getDataset`). The Gold-built
 * gate is left to the plan builder — a mart with no built Gold is REJECTED there with
 * the honest reason, so it still appears in the preview as a non-syncable line.
 */
function governedMartsFor(user: CurrentUser): Dataset[] {
  const groups = listDatasets({ id: user.id, domains: user.domains, role: user.role });
  const out: Dataset[] = [];
  for (const s of [...groups.domain, ...groups.marketplace]) {
    try {
      out.push(getDataset(s.id, { id: user.id, domains: user.domains, role: user.role }));
    } catch {
      /* canView race / removed since listing — skip (never throw the whole refresh). */
    }
  }
  return out;
}

/**
 * PREVIEW the full catalog refresh — READ-ONLY (Guard 6): computes every dataset's
 * additive metadata plan (+ DQ plan when enabled) with ZERO writes to OM. When no
 * om-catalog connection is visible, returns an empty, ok preview (nothing to do —
 * OM-absent is a calm no-op, never an error). `humanServiceFqn` is threaded through
 * to the metadata leg so the operator can additively annotate the human table copy.
 */
export async function previewCatalogIngest(
  user: CurrentUser,
  opts: { humanServiceFqn?: string } = {},
): Promise<OmIngestPreview> {
  const c = await firstOmCatalogFor(user);
  if (!c) {
    return {
      ok: true,
      connectionName: null,
      datasets: [],
      totals: { datasets: 0, syncable: 0, creates: 0, edges: 0, suites: 0, testCases: 0 },
      summary: 'No OpenMetadata (om-catalog) connection is connected/visible — nothing to refresh.',
    };
  }

  const marts = governedMartsFor(user);
  const datasets: OmIngestDatasetPreview[] = [];
  const totals = { datasets: marts.length, syncable: 0, creates: 0, edges: 0, suites: 0, testCases: 0 };

  for (const d of marts) {
    const runId = 'plan';
    const metadata = previewOmSyncForConnection(c, d, { runId, humanServiceFqn: opts.humanServiceFqn });
    const dq = config.openmetadataDqWritebackEnabled ? previewDqSyncForConnection(c, d, { runId }) : undefined;
    if (metadata.ok || (dq && dq.ok)) totals.syncable += 1;
    if (metadata.ok) {
      totals.creates += metadata.counts.creates;
      totals.edges += metadata.counts.edges;
    }
    if (dq && dq.ok) {
      totals.suites += dq.counts.suites;
      totals.testCases += dq.counts.testCases;
    }
    datasets.push({ datasetId: d.id, name: d.name, domain: d.domain, tier: d.tier, metadata, dq });
  }

  return {
    ok: true,
    connectionName: c.name,
    datasets,
    totals,
    summary:
      `Refresh "${c.name}": ${totals.syncable}/${totals.datasets} governed mart(s) syncable — ` +
      `${totals.creates} entity create/update, ${totals.edges} lineage edge(s)` +
      (config.openmetadataDqWritebackEnabled ? `, ${totals.suites} TestSuite + ${totals.testCases} TestCase(s)` : '') +
      ' — touch ZERO human fields.',
  };
}

/**
 * APPLY the full catalog refresh — call ONLY after governance approval (the trigger
 * holds it as a Write-approval). Recomputes each dataset's plan server-side (the held
 * payload carries no plan) and executes the SAME engines the one-shot MCP tools use, so
 * every guard applies unchanged. HONEST + NON-BLOCKING: a per-dataset failure (OM
 * unreachable, version-refused, a rejected plan) is recorded and the fold continues —
 * the refresh never throws and never fabricates success. Skips silently (empty result)
 * when no om-catalog connection is visible.
 */
export async function applyCatalogIngest(
  user: CurrentUser,
  opts: { humanServiceFqn?: string } = {},
): Promise<OmIngestResult> {
  const c = await firstOmCatalogFor(user);
  if (!c) {
    return {
      ok: true,
      connectionName: null,
      datasets: [],
      totals: { datasets: 0, creates: 0, patches: 0, edges: 0, suites: 0, testCases: 0 },
      summary: 'No OpenMetadata (om-catalog) connection is connected/visible — nothing to refresh.',
    };
  }

  const marts = governedMartsFor(user);
  const datasets: OmIngestDatasetResult[] = [];
  const totals = { datasets: marts.length, creates: 0, patches: 0, edges: 0, suites: 0, testCases: 0 };
  let ok = true;

  for (const d of marts) {
    const runId = `refresh-${Date.now()}`;
    // Metadata leg — never throws; a rejected/refused plan yields a no-op result.
    const metadata = await runLeg<OmSyncResult>(
      () => applyOmSyncForConnection(c, d, { runId, humanServiceFqn: opts.humanServiceFqn }),
      (reason) => ({ ok: false, applied: { creates: 0, patches: 0, edges: 0 }, conflicts: [], errors: [], refused: reason }),
    );
    totals.creates += metadata.applied.creates;
    totals.patches += metadata.applied.patches;
    totals.edges += metadata.applied.edges;
    // A refused/rejected plan (no Gold, not promoted, OM off-range) is NOT a failure of
    // the refresh — it is an honest skip. Only a real write error flips `ok`.
    if (!metadata.ok && !metadata.refused && metadata.errors.length > 0) ok = false;

    let dq: OmDqSyncResult | undefined;
    if (config.openmetadataDqWritebackEnabled) {
      dq = await runLeg<OmDqSyncResult>(
        () => applyDqSyncForConnection(c, d, { runId }),
        (reason) => ({ ok: false, applied: { suites: 0, testCases: 0 }, errors: [], refused: reason }),
      );
      totals.suites += dq.applied.suites;
      totals.testCases += dq.applied.testCases;
      if (!dq.ok && !dq.refused && dq.errors.length > 0) ok = false;
    }

    datasets.push({ datasetId: d.id, name: d.name, metadata, dq });
  }

  return {
    ok,
    connectionName: c.name,
    datasets,
    totals,
    summary:
      `Refreshed "${c.name}" across ${totals.datasets} governed mart(s): ` +
      `${totals.creates} create/update, ${totals.patches} annotation(s), ${totals.edges} lineage edge(s)` +
      (config.openmetadataDqWritebackEnabled ? `, ${totals.suites} TestSuite + ${totals.testCases} TestCase(s)` : '') +
      '.',
  };
}

/** Run one write leg, converting an UNEXPECTED throw into an honest refused no-op. The
 *  engines already never-throw for expected failures; this is the belt-and-braces catch
 *  so the whole refresh can never be brought down by one dataset. */
async function runLeg<T>(fn: () => Promise<T>, onThrow: (reason: string) => T): Promise<T> {
  try {
    return await fn();
  } catch {
    return onThrow('unexpected error during catalog refresh (skipped, non-blocking)');
  }
}
