/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { roleAtLeast } from '../../core/session.ts';
import { assetTarget } from './store-fqn.ts';
import type { Dataset } from './dataset-schema.ts';
import type { Principal } from './store.ts';
import type { MaterializationVerifier } from './store.ts';
import type { RematerializeOutcome } from './publish.ts';

/**
 * The governed RECONCILE SWEEP behind `reconcileDomainTables` — the SELF-HEAL for the
 * recurring "domain gold table not materialized" drift (#96 / #151, the Northpeak class).
 *
 * A promoted dataset's registry says tier=asset + queryable + cube.ready, but the physical
 * Iceberg table `iceberg.<domain>.gold_<slug>` has drifted out of the warehouse (a
 * catalog/warehouse event, or a demote→re-promote round-trip), and NO `domainTableStale`
 * flag was set — so the OS believes it is fine and every dashboard dead-ends. The sweep
 * PROBES each promoted domain table the operator governs; when it is MISSING (or already
 * flagged STALE), it re-runs the SAFE stored publish CTAS via {@link rematerializeDomainTable}
 * (preserves grain + measures — it re-runs the stored plan, never reconstructs), re-probes,
 * and clears the flag. Best-effort per dataset: one failure never aborts the sweep, and the
 * honest error rides in the per-dataset report.
 *
 * Pure module: the governed dataset list, the physical probe and the re-materialize are all
 * INJECTED, so the decision (missing→refresh, stale→refresh, ok→skip), the report shape and
 * the governance gate are unit-testable against fakes — no cluster required.
 */

export type ReconcileBefore = 'missing' | 'stale' | 'ok';
export type ReconcileAfter = 'refreshed' | 'failed' | 'skipped';

export type ReconcileEntry = {
  datasetId: string;
  name: string;
  fqn: string;
  before: ReconcileBefore;
  after: ReconcileAfter;
  error?: string;
};

export type ReconcileReport = {
  scanned: number;
  refreshed: number;
  failed: number;
  skipped: number;
  entries: ReconcileEntry[];
};

export type ReconcileDeps = {
  /** All governed (asset/product) datasets, UNSCOPED — the store's `listGovernedDatasets`. */
  governedDatasets(): Dataset[];
  /** Physical-existence probe of a domain FQN via the governed query path (the SAME
   *  `tableQueryable`/`probeQueryable` the publish uses). true ⇒ the table resolves. */
  verifyDomainTable: MaterializationVerifier;
  /** Re-run the stored publish CTAS for one promoted dataset — `rematerializeDomainTable`. */
  rematerialize(datasetId: string): Promise<RematerializeOutcome>;
};

/**
 * Governance floor for the sweep: an operator may reconcile a domain's tables when they are
 * an ADMIN (tenant-wide), or a BUILDER+ who BELONGS to the dataset's domain — the SAME
 * domain-schema write floor {@link rematerializeDomainTable} enforces (only a Builder+ may
 * re-run a CTAS into the governed domain schema). A creator can never heal a domain table.
 */
export function mayReconcile(operator: Principal, domain: string): boolean {
  if (roleAtLeast(operator.role, 'admin')) return true;
  return operator.domains.includes(domain) && roleAtLeast(operator.role, 'builder');
}

/**
 * Reconcile the promoted domain tables the operator governs. Optionally scope to ONE domain.
 * For each in-scope promoted dataset: probe the physical domain table; if MISSING or already
 * flagged STALE, re-materialize (stored plan); if it resolves and isn't flagged, skip. The
 * probe is fail-soft (a probe throw is treated as "missing" → repair, never a crash), and
 * each re-materialize is best-effort (a failure is reported, the sweep continues).
 */
export async function reconcileDomainTables(
  operator: Principal,
  deps: ReconcileDeps,
  opts: { domain?: string } = {},
): Promise<ReconcileReport> {
  const entries: ReconcileEntry[] = [];

  const inScope = deps
    .governedDatasets()
    .filter((d) => (opts.domain ? d.domain === opts.domain : true))
    .filter((d) => mayReconcile(operator, d.domain));

  for (const d of inScope) {
    const fqn = assetTarget(d);

    // PROMOTE-AS-VIEW: a view is a live pass-through to the owner's personal lane — it can
    // NEVER drift out of sync, so it is ALWAYS-materialized by construction. Skip it (no
    // probe, no CTAS re-run): reconcile is a no-op for view-promoted datasets. The CTAS
    // heal below stays for legacy table-promoted datasets.
    if (d.domainArtifact === 'view') {
      entries.push({ datasetId: d.id, name: d.name, fqn, before: 'ok', after: 'skipped' });
      continue;
    }

    // Physical-existence probe (fail-soft: a probe throw ⇒ treat as missing, repair it).
    let present: boolean;
    try {
      present = await deps.verifyDomainTable(fqn, operator.domains[0] ?? operator.id);
    } catch {
      present = false;
    }

    // In-sync AND not flagged ⇒ nothing to do (the healthy, common case: no CTAS re-run).
    if (present && !d.domainTableStale) {
      entries.push({ datasetId: d.id, name: d.name, fqn, before: 'ok', after: 'skipped' });
      continue;
    }

    const before: ReconcileBefore = present ? 'stale' : 'missing';
    try {
      const out = await deps.rematerialize(d.id);
      entries.push({
        datasetId: d.id,
        name: d.name,
        fqn,
        before,
        after: out.ok ? 'refreshed' : 'failed',
        ...(out.ok ? {} : { error: out.error }),
      });
    } catch (e) {
      entries.push({
        datasetId: d.id,
        name: d.name,
        fqn,
        before,
        after: 'failed',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    scanned: entries.length,
    refreshed: entries.filter((e) => e.after === 'refreshed').length,
    failed: entries.filter((e) => e.after === 'failed').length,
    skipped: entries.filter((e) => e.after === 'skipped').length,
    entries,
  };
}
