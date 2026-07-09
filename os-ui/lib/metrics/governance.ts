/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, Measure, Tier } from '../data/dataset-schema.ts';
import type { Role } from '../core/session.ts';
import { canTransition, tierAfter } from '../data/dataset-schema.ts';
import { type ConsistencyResult, type MemberResolver, consistencyCheck } from './consistency.ts';
import { measureMember } from './model.ts';

/**
 * Metric governance — a metric is a governed PRODUCT, on the SAME tiers/roles as data:
 *
 *   Personal → promote to the Domain (Builder) → certify to the Marketplace (Admin).
 *
 * We reuse the data lifecycle gate ({@link canTransition}) so metrics and datasets can
 * never drift on who-may-do-what (a non-Builder cannot promote; only an Admin certifies),
 * and we gate promotion/certification on the metric CONSISTENCY check (documented +
 * defined + resolves on its canonical member). The OM lineage edge (mart→measure→view)
 * rides in on the dbt exposure the Data build already emits — governance here is the
 * tier move + the consistency gate, not a second catalog write.
 *
 * Pure + tested. A MetricRecord is the governed unit (a measure on a dataset's view).
 */

export type MetricTier = 'personal' | 'domain' | 'marketplace';

const TIER_OF: Record<MetricTier, Tier> = { personal: 'dataset', domain: 'asset', marketplace: 'product' };
const METRIC_TIER: Record<Tier, MetricTier> = { dataset: 'personal', asset: 'domain', product: 'marketplace' };

export type MetricRecord = {
  id: string;
  dataset: Dataset;
  measure: Measure;
  tier: MetricTier;
  owner: string;
  /** The canonical member every consumer resolves (denormalized for listing/search). */
  member: string;
};

export function metricRecord(dataset: Dataset, measure: Measure, owner: string, tier: MetricTier = 'personal'): MetricRecord {
  return { id: `${dataset.id}.${measure.name}`, dataset, measure, tier, owner, member: measureMember(dataset, measure) };
}

export type GovernTransition = 'promote' | 'certify';

export type GovernResult = {
  ok: boolean;
  record: MetricRecord;
  /** The consistency gate evaluated for this transition (the audit trail). */
  consistency: ConsistencyResult;
  reason?: string;
};

/**
 * Move a metric along the lifecycle. Order of checks is deliberate:
 *   1. role gate (Builder to promote, Admin to certify) — fail fast, no side effect;
 *   2. consistency gate (documented + defined + resolves) — a metric that doesn't
 *      resolve the same everywhere may not become a shared/certified product.
 * Only when both pass does the tier advance. `resolve` proves it resolves on the live
 * member (offline define-time previews omit it; promotion in a live build supplies it).
 */
export async function governMetric(
  record: MetricRecord,
  transition: GovernTransition,
  approver: { id: string; role: Role },
  resolve?: MemberResolver,
): Promise<GovernResult> {
  const fromTier = TIER_OF[record.tier];
  const roleGate = canTransition(approver.role, fromTier, transition);
  const consistency = await consistencyCheck(record.dataset, record.measure, resolve);
  if (!roleGate.ok) {
    return { ok: false, record, consistency, reason: roleGate.reason };
  }
  if (!consistency.ok) {
    const bad = consistency.rows.find((r) => !r.ok);
    return { ok: false, record, consistency, reason: `consistency gate: ${bad?.detail ?? 'not consistent'}` };
  }
  const toTier = tierAfter(fromTier, transition);
  return { ok: true, record: { ...record, tier: METRIC_TIER[toTier] }, consistency };
}

/** Quick role predicates for the UI (enable/disable the promote/certify buttons). */
export function canPromote(role: Role): boolean {
  return canTransition(role, 'dataset', 'promote').ok;
}
export function canCertify(role: Role): boolean {
  return canTransition(role, 'asset', 'certify').ok;
}
