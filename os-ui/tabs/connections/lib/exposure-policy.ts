/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { publishOpa } from '@core/policy/opa-publish';
import { compileExposures, type ExposureGovernanceInput } from '@tabs/data/lib/policy/compiler';
import { allActiveExposures } from '@tabs/connections/lib/exposures';
import { getConnectionById } from '@tabs/connections/lib/store';

/**
 * EXPOSURE → OPA recompile (lakehouse-import-exposure.md, Phase 1). This is the seam the
 * exposure CRUD routes fire after create/update/revoke, mirroring how a dataset build's
 * `policy` adapter pushes the compiled `data.governance` bundle to OPA.
 *
 * WHY PER-KEY, not a wholesale `governance/tables` PUT: exposures write each FQN to its
 * OWN OPA path (`governance/tables/<encoded-fqn>`) — purely ADDITIVE, exactly the
 * discipline the dataset build uses for `governance/principals/<id>`. A revoked exposure's
 * FQN is DELETEd, so the rego's fail-closed floor closes it again (zero rows) on the next
 * recompile. The FULL active set is recompiled every time (not a delta) so the pushed
 * state always reflects the registry.
 *
 * DURABLE SOURCE OF TRUTH = the registry, not OPA. OPA holds this data in memory only, so the
 * OPA state reconciler (`core/policy/opa-reconcile.ts`, source registered in `instrumentation.ts`)
 * re-runs this recompile at boot, every five minutes and after an OPA restart. All writes go
 * through the one OPA publisher (`core/policy/opa-publish.ts`). Never silently fabricates access:
 * a missing key means the fail-closed floor denies, not allows.
 */

/** OPA stores table keys with `.` as a path separator, so encode the FQN as one segment. */
function tableKeyPath(fqn: string): string {
  return `governance/tables/${encodeURIComponent(fqn)}`;
}

/**
 * Resolve every active exposure to its compiler input by looking up the connection's
 * owning domain + registered catalog. An exposure whose connection is gone (deleted) is
 * skipped — its FQNs then fall back to the fail-closed floor (zero rows), which is the
 * safe outcome.
 */
export async function activeExposureGovernanceInputs(): Promise<ExposureGovernanceInput[]> {
  const exposures = await allActiveExposures();
  const out: ExposureGovernanceInput[] = [];
  for (const e of exposures) {
    const c = await getConnectionById(e.connectionId);
    // Skip a gone OR ARCHIVED connection (M3): an archived connection's exposures are
    // frozen, so its FQNs fall back to the fail-closed floor (zero rows) on recompile.
    if (!c || c.archived || c.template !== 'warehouse' || !c.warehouse) continue;
    out.push({
      domain: c.domain,
      catalog: c.warehouse.catalog,
      domains: e.domains,
      tables: e.tables,
    });
  }
  return out;
}

/**
 * The set of `catalog.schema.table` FQNs an exposure currently maps to — the caller
 * snapshots these BEFORE an update/revoke so any FQN the change DROPS can be withdrawn
 * from OPA (the recompile re-adds anything still exposed by another set). Returns [] when
 * the exposure or its connection is gone.
 */
export async function exposureFqns(exposureId: string): Promise<string[]> {
  const exposures = await allActiveExposures();
  // allActiveExposures excludes revoked; for a just-revoked one the caller passes the
  // pre-revoke snapshot instead. Here we resolve from the connection registry.
  const e = exposures.find((x) => x.id === exposureId);
  if (!e) return [];
  const c = await getConnectionById(e.connectionId);
  if (!c || !c.warehouse) return [];
  return e.tables.map((t) => `${c.warehouse!.catalog}.${t.schema}.${t.table}`);
}

export type ExposurePushResult = { ok: boolean; pushed: number; detail: string };

/**
 * Recompile ALL active exposures → OPA, pushing each FQN to its own `governance/tables`
 * key. `withdraw` lists FQNs that MUST be removed (a just-revoked/edited exposure's
 * dropped tables) so a removed table closes immediately. Best-effort + honest: an
 * unreachable OPA returns `{ ok:false }` with the reason — the in-memory registry stays
 * authoritative and the next recompile heals it.
 */
export async function recompileExposures(opts: { withdraw?: string[] } = {}): Promise<ExposurePushResult> {
  const inputs = await activeExposureGovernanceInputs();
  const tables = compileExposures(inputs);
  const active = new Set(Object.keys(tables));

  // Withdraw first: any explicitly-dropped FQN that is no longer active.
  for (const fqn of opts.withdraw ?? []) {
    if (active.has(fqn)) continue; // still exposed by another set — keep it
    const res = await publishOpa({ kind: 'delete', path: tableKeyPath(fqn) });
    if (!res.ok) return { ok: false, pushed: 0, detail: `OPA withdraw of ${fqn} failed — ${res.detail}` };
  }

  let pushed = 0;
  for (const [fqn, meta] of Object.entries(tables)) {
    const res = await publishOpa({ kind: 'data', path: tableKeyPath(fqn), value: meta });
    if (!res.ok) return { ok: false, pushed, detail: `OPA governance push failed at ${fqn} — ${res.detail}` };
    pushed++;
  }
  return { ok: true, pushed, detail: `Pushed ${pushed} exposed table(s) to OPA governance.` };
}
