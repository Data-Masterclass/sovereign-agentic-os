/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { queryToolReachable, realTrino } from './build/live-clients.ts';
import { listGovernedDatasets } from './store.ts';
import { rematerializeDomainTableLive } from './publish-server.ts';
import { reconcileDomainTables, type ReconcileReport } from './reconcile.ts';
import { assetTarget } from './store-fqn.ts';
import type { Dataset } from './dataset-schema.ts';
import type { MaterializationVerifier, Principal } from './store.ts';

/**
 * The server-boundary RECONCILE SWEEP: enumerate the promoted domain tables the operator
 * governs (optionally one domain), probe each physically, and re-materialize any that are
 * MISSING or STALE via the SAME stored-plan re-materialize as the Data tab. One entry point
 * for the governed route + the MCP verb, so the honest per-dataset report is identical on
 * both surfaces. Never throws into the caller for a per-dataset failure — the failure rides
 * in the report.
 *
 * The physical-existence probe (`verifyDomainTable`) is wired here. Reachability is checked
 * ONCE, up front, against the WRITE/Trino path the domain tables actually live in
 * (`queryToolReachable`) — NOT Cube's `/meta` (`liveDataReachable`), which is slow while a
 * CTAS-heavy sweep is reloading Cube's schema and would intermittently time out, flipping the
 * probe to a blanket "present" and SKIPPING a genuinely-missing table (the live
 * `gold_northpeak_service_cases` false-skip). On a reachable engine every table is probed for
 * REAL and the sweep fails CLOSED: a probe throw ⇒ treat as missing ⇒ repair (the
 * re-materialize is an idempotent CREATE-OR-REPLACE, guarded against a zero-row clobber). Only
 * a genuinely unreachable engine (true offline-mock — no domain schema exists) makes the sweep
 * a deliberate no-op, so the teaching mock never triggers a spurious re-materialize storm.
 */
export async function reconcileDomainTablesLive(
  operator: Principal,
  opts: { domain?: string } = {},
): Promise<ReconcileReport> {
  const engineLive = await queryToolReachable();
  const verifyDomainTable: MaterializationVerifier = engineLive
    ? (fqn, principal) => realTrino().tableQueryable(fqn, principal)
    : async () => true;
  return reconcileDomainTables(
    operator,
    {
      governedDatasets: listGovernedDatasets,
      verifyDomainTable,
      rematerialize: (datasetId) => rematerializeDomainTableLive(datasetId, operator),
    },
    opts,
  );
}

/**
 * PROBE-BEFORE-CLAIM for the single-dataset DETAIL read (#96 honesty): a promoted dataset's
 * registry can say served (tier=asset, queryable, cube-ready) while the PHYSICAL domain table
 * has drifted away — so the detail route must never claim served without checking. Returns
 * `true` when the promoted dataset's domain gold table is MISSING (so the caller flags it
 * `domainTableStale` + surfaces the re-materialize affordance). Fail-SOFT: an un-promoted
 * dataset, or an unreachable engine (offline-mock), returns `false` (don't cry wolf) — only a
 * live, reachable engine that answers "table absent" flips it true. Single-read only — never
 * called per row in a list (it costs one governed probe query).
 */
export async function domainTableMissing(d: Dataset): Promise<boolean> {
  if (d.tier === 'dataset') return false; // not promoted — nothing is claimed served
  // Gate on the WRITE/Trino path the table lives in — NOT Cube's /meta, which is slow under
  // load and would falsely report "engine down" and hide a genuinely-missing table.
  if (!(await queryToolReachable())) return false; // engine unreachable / offline-mock: don't cry wolf
  const present = await realTrino().tableQueryable(assetTarget(d), d.domain).catch(() => true);
  return !present;
}
