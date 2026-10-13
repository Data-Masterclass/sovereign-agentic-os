/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, Layer } from './dataset-schema.ts';
import type { Principal } from './store.ts';
import type { ExecuteIdentity } from '@/lib/infra/governed';
import { domainSchema, personalSchema, physicalSlug } from './store-fqn.ts';

/**
 * PHYSICAL cleanup for a dataset DELETE (never for archive — archive is a
 * reversible registry-only soft-hide; restore must bring the dataset back intact).
 *
 * Deleting a dataset removes its registry record AND its Iceberg tables: a
 * "deleted" dataset that still shows up in Trino isn't deleted. The drops run
 * through the SAME governed `/execute` path as every build (`DROP TABLE IF
 * EXISTS iceberg.<schema>.<table>` is on the query-tool allowlist), AS the
 * caller — a personal-lane drop runs under the uid (owner-only schema), a
 * governed-schema drop under the domain principal (builder-floor enforced by
 * the guard). If a drop can't run (engine offline / not permitted) the delete
 * still stands, but the orphaned table is REPORTED honestly — never silent.
 *
 * Pure planning + injected executor, so the plan and the outcome fold are unit-
 * testable without a cluster; the route injects the real `executeRun`.
 */

export type PhysicalDrop = {
  fqn: string;
  schema: string;
  layer: Layer;
  /** The Iceberg object at `fqn`: a physical `'table'` (the classic CTAS copy) or a governed
   *  `'view'` (promote-as-view). Decides `DROP TABLE` vs `DROP VIEW`. Defaults to `'table'`
   *  (byte-stable — every existing drop is a table drop). */
  object?: 'view' | 'table';
};

const LAYERS: Layer[] = ['bronze', 'silver', 'gold'];

/**
 * Every physical table this dataset's BUILT layers may occupy. The golden path
 * builds into the owner's `personal_<uid>` lane; a promoted asset/product ALSO has
 * its published copy in the (sanitized) domain schema. `DROP TABLE IF EXISTS`
 * makes an unbuilt candidate harmless, but we still only plan built layers.
 */
export function dropPlan(d: Dataset): PhysicalDrop[] {
  const s = physicalSlug(d); // FROZEN — drop the ACTUAL physical tables, not the new name's
  const personal = personalSchema(d.owner);
  const out: PhysicalDrop[] = [];
  for (const layer of LAYERS) {
    if (!d.versions[layer].built) continue;
    out.push({ fqn: `iceberg.${personal}.${layer}_${s}`, schema: personal, layer });
    if (d.tier !== 'dataset') {
      const dom = domainSchema(d.domain);
      // The domain copy is a VIEW under promote-as-view, else the classic physical table.
      const object: 'view' | 'table' = d.domainArtifact === 'view' ? 'view' : 'table';
      out.push({ fqn: `iceberg.${dom}.${layer}_${s}`, schema: dom, layer, object });
    }
  }
  return out;
}

/**
 * The DOMAIN-schema copies of a dataset's built layers — the governed published tables
 * (`iceberg.<domain>.<layer>_<slug>`) a promotion materialized. NEVER the owner's personal
 * lane (the owner keeps their own build). This is the RETIRE plan for a DEMOTE (unshare):
 * when a dataset leaves the domain tier it must stop being readable as a served domain
 * asset, so its orphaned domain copies are dropped. Pass the PRE-demote dataset (its slug +
 * built layers are read here); the tier is irrelevant (the caller already decided to retire).
 */
export function domainDropPlan(d: Dataset): PhysicalDrop[] {
  const s = physicalSlug(d);
  const dom = domainSchema(d.domain);
  // A view-promoted dataset's domain artifact is a VIEW — demote must DROP VIEW (dropping the
  // owner's personal table is never attempted here; the personal lane is untouched either way).
  const object: 'view' | 'table' = d.domainArtifact === 'view' ? 'view' : 'table';
  const out: PhysicalDrop[] = [];
  for (const layer of LAYERS) {
    if (!d.versions[layer].built) continue;
    out.push({ fqn: `iceberg.${dom}.${layer}_${s}`, schema: dom, layer, object });
  }
  return out;
}

/**
 * The set of physical FQNs some OTHER live dataset ALSO occupies (a name/slug collision).
 * Because the physical table is keyed on `physicalSlug` (name-slug), not the id, two datasets
 * with the same slug in one domain resolve to the SAME `iceberg.<domain>.<layer>_<slug>`
 * table. Dropping `target`'s tables would then ORPHAN a still-live sibling. This returns the
 * union of `dropPlan(o)` FQNs for every non-archived `o !== target`, so the drop can SKIP
 * (protect) any table a sibling still needs. Archived datasets are excluded — they hold no
 * live claim (their footprint is reclaimable).
 */
export function sharedFootprintFqns(
  target: Dataset,
  others: (Dataset & { archived?: boolean })[],
): Set<string> {
  const out = new Set<string>();
  for (const o of others) {
    if (o.id === target.id || o.archived) continue;
    for (const drop of dropPlan(o)) out.add(drop.fqn);
  }
  return out;
}

export type PhysicalDeleteReport = {
  dropped: string[];
  orphaned: { fqn: string; reason: string }[];
};

/** The governed write runner (`executeRun`) shape, injected for testability. */
export type ExecFn = (sql: string, identity: ExecuteIdentity) => Promise<unknown>;

/**
 * Drop every planned table, best-effort per table: one failure (engine offline,
 * guard 403 for a non-owner caller on the personal lane) never blocks the others,
 * and every miss is reported as an orphan with its real reason.
 */
export async function dropPhysicalTables(
  d: Dataset,
  user: Principal,
  exec: ExecFn,
  protectedFqns: Set<string> = new Set(),
): Promise<PhysicalDeleteReport> {
  return dropTables(dropPlan(d), user, exec, protectedFqns);
}

/**
 * RETIRE a dataset's DOMAIN-schema copies on a DEMOTE (unshare): drop the governed
 * published tables so a demoted dataset can NEVER be read as a served domain asset again
 * (the zombie-asset fix). Best-effort + honestly reported, exactly like the delete drop.
 * The personal lane is untouched — the owner keeps their own build to re-promote later.
 */
export async function retireDomainTables(
  d: Dataset,
  user: Principal,
  exec: ExecFn,
  protectedFqns: Set<string> = new Set(),
): Promise<PhysicalDeleteReport> {
  return dropTables(domainDropPlan(d), user, exec, protectedFqns);
}

/** Drop a planned set of tables, best-effort per table (shared by delete + demote-retire).
 *  A table in `protectedFqns` is SKIPPED (never dropped): some OTHER live dataset shares it
 *  via a name/slug collision, so dropping it would orphan the still-served sibling. */
async function dropTables(
  plan: PhysicalDrop[],
  user: Principal,
  exec: ExecFn,
  protectedFqns: Set<string> = new Set(),
): Promise<PhysicalDeleteReport> {
  const report: PhysicalDeleteReport = { dropped: [], orphaned: [] };
  for (const t of plan) {
    // Never drop a table another live dataset still occupies (name/slug collision) — the
    // drop would leave that sibling's metadata "served" with its physical table gone.
    if (protectedFqns.has(t.fqn)) {
      report.orphaned.push({ fqn: t.fqn, reason: 'kept: physical table still shared by another dataset (name/slug collision)' });
      continue;
    }
    // Personal-lane tables are owner-only in Trino→OPA: the drop must run under the
    // uid; governed schemas run under the domain principal (same rule as the builds).
    const identity: ExecuteIdentity = {
      principal: t.schema.startsWith('personal_') ? user.id : (user.domains[0] ?? user.id),
      uid: user.id,
      domains: user.domains,
      role: user.role,
    };
    try {
      // A governed VIEW (promote-as-view) must be dropped with DROP VIEW, not DROP TABLE —
      // Trino rejects a DROP TABLE on a view (and vice versa). Both are on the /execute allowlist.
      const drop = t.object === 'view' ? `drop view if exists ${t.fqn}` : `drop table if exists ${t.fqn}`;
      await exec(drop, identity);
      report.dropped.push(t.fqn);
    } catch (e) {
      report.orphaned.push({ fqn: t.fqn, reason: (e as Error).message || 'drop failed' });
    }
  }
  return report;
}
