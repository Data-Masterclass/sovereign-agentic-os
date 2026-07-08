/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, Layer } from './dataset-schema.ts';
import type { Principal } from './store.ts';
import type { ExecuteIdentity } from '@/lib/governed';
import { domainSchema, personalSchema, slug } from './store-fqn.ts';

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

export type PhysicalDrop = { fqn: string; schema: string; layer: Layer };

const LAYERS: Layer[] = ['bronze', 'silver', 'gold'];

/**
 * Every physical table this dataset's BUILT layers may occupy. The golden path
 * builds into the owner's `personal_<uid>` lane; a promoted asset/product ALSO has
 * its published copy in the (sanitized) domain schema. `DROP TABLE IF EXISTS`
 * makes an unbuilt candidate harmless, but we still only plan built layers.
 */
export function dropPlan(d: Dataset): PhysicalDrop[] {
  const s = slug(d.name);
  const personal = personalSchema(d.owner);
  const out: PhysicalDrop[] = [];
  for (const layer of LAYERS) {
    if (!d.versions[layer].built) continue;
    out.push({ fqn: `iceberg.${personal}.${layer}_${s}`, schema: personal, layer });
    if (d.tier !== 'dataset') {
      const dom = domainSchema(d.domain);
      out.push({ fqn: `iceberg.${dom}.${layer}_${s}`, schema: dom, layer });
    }
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
export async function dropPhysicalTables(d: Dataset, user: Principal, exec: ExecFn): Promise<PhysicalDeleteReport> {
  const report: PhysicalDeleteReport = { dropped: [], orphaned: [] };
  for (const t of dropPlan(d)) {
    // Personal-lane tables are owner-only in Trino→OPA: the drop must run under the
    // uid; governed schemas run under the domain principal (same rule as the builds).
    const identity: ExecuteIdentity = {
      principal: t.schema.startsWith('personal_') ? user.id : (user.domains[0] ?? user.id),
      uid: user.id,
      domains: user.domains,
      role: user.role,
    };
    try {
      await exec(`drop table if exists ${t.fqn}`, identity);
      report.dropped.push(t.fqn);
    } catch (e) {
      report.orphaned.push({ fqn: t.fqn, reason: (e as Error).message || 'drop failed' });
    }
  }
  return report;
}
