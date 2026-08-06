/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { compileExposures, type ExposureGovernanceInput } from '@/lib/data/policy/compiler';
import { allActiveExposures } from '@/lib/connections/exposures';
import { getConnectionById } from '@/lib/connections/store';

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
 * DURABLE SOURCE OF TRUTH = the registry, not OPA. The dataset build's `realPolicy` does a
 * WHOLESALE `PUT governance/tables` with only ITS compiled tables, and OPA state is also
 * seeded from `values.yaml opa.governance.tables` — so OPA's `tables` doc can be
 * transiently overwritten by a dataset build. That is fine and self-healing: the exposure
 * REGISTRY (`os-exposures`, durable across a pod roll like the grants) is authoritative,
 * and this recompile re-pushes the full active set — fire it on every exposure change (as
 * the routes do) and re-run it if OPA is ever reconciled from the registry. Never silently
 * fabricates access: a missing key means the fail-closed floor denies, not allows.
 */

async function opaFetch(path: string, init: RequestInit, ms = 5000): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(`${config.opaUrl}/v1/data/${path}`, {
      ...init,
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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
    const res = await opaFetch(tableKeyPath(fqn), { method: 'DELETE' });
    if (!res) return { ok: false, pushed: 0, detail: `OPA unreachable while withdrawing ${fqn}` };
  }

  let pushed = 0;
  for (const [fqn, meta] of Object.entries(tables)) {
    const res = await opaFetch(tableKeyPath(fqn), { method: 'PUT', body: JSON.stringify(meta) });
    if (!res || !res.ok) {
      return { ok: false, pushed, detail: `OPA governance push failed at ${fqn} (${res?.status ?? 'unreachable'})` };
    }
    pushed++;
  }
  return { ok: true, pushed, detail: `Pushed ${pushed} exposed table(s) to OPA governance.` };
}
