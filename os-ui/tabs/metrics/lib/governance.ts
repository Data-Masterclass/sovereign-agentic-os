/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Metric governance — promote and certify a metric along the data tiers
 * USER STORY: As a domain admin or admin I want a metric promoted only by an entitled role, only when it
 *             passes the consistency gate, and never above its dataset's tier, so that shared numbers are sound.
 * ARCHITECTURE:
 *   - Pure, tested. Tiers map to the data ladder (personal → dataset, domain → asset, marketplace →
 *     product) and the role gate reuses Data's `canTransition`, so metrics and datasets cannot drift.
 *   - Check order: role gate, then `consistencyCheck` (`./consistency.ts`), then the dataset-tier ceiling.
 *   - Used by the metric promote/govern routes, `./store.ts` and the MCP write tools.
 */
import type { Dataset, Measure, Tier } from '@tabs/data/lib/index';
import type { Role } from '@core/kernel/session';
import { canTransition, tierAfter } from '@tabs/data/lib/index';
import { type ConsistencyResult, type MemberResolver, consistencyCheck } from '@tabs/metrics/lib/consistency';
import { measureMember } from '@tabs/metrics/lib/model';

export type MetricTier = 'personal' | 'domain' | 'marketplace';

const TIER_OF: Record<MetricTier, Tier> = { personal: 'dataset', domain: 'asset', marketplace: 'product' };
const METRIC_TIER: Record<Tier, MetricTier> = { dataset: 'personal', asset: 'domain', product: 'marketplace' };

/**
 * THE DATASET CEILING (checklist M12). The ladder is ordered, so a tier can be compared.
 *
 * A metric IS a measure on a dataset: every number it serves is read from that dataset's table
 * through that dataset's grants. So a metric published WIDER than the data underneath it promises
 * an audience a number they cannot be shown — the promotion would succeed and every read by a
 * new viewer would then be refused by row-level security, or (worse, if the data were ever
 * widened by mistake) served. The audience of a metric can therefore never exceed the audience of
 * its dataset, and the refusal names the dataset so the fix is obvious: promote the dataset first.
 */
const TIER_RANK: Record<Tier, number> = { dataset: 0, asset: 1, product: 2 };
const TIER_WORD: Record<Tier, string> = { dataset: 'Personal', asset: 'Domain', product: 'Company' };

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
  // 3. the DATASET CEILING: a metric may not be promoted above the tier of the data it reads.
  //    Checked here, after the role and consistency gates, so one refusal is reported at a time
  //    and the audit trail still carries the consistency result for this attempt.
  const datasetTier = record.dataset.tier;
  if (TIER_RANK[toTier] > TIER_RANK[datasetTier]) {
    return {
      ok: false,
      record,
      consistency,
      reason:
        `dataset tier ceiling: '${record.dataset.name}' is ${TIER_WORD[datasetTier]}, so this metric cannot be ` +
        `${transition === 'certify' ? 'certified to' : 'promoted to'} ${TIER_WORD[toTier]} — promote the dataset first`,
    };
  }
  return { ok: true, record: { ...record, tier: METRIC_TIER[toTier] }, consistency };
}

/** Quick role predicates for the UI (enable/disable the promote/certify buttons). */
export function canPromote(role: Role): boolean {
  return canTransition(role, 'dataset', 'promote').ok;
}
export function canCertify(role: Role): boolean {
  return canTransition(role, 'asset', 'certify').ok;
}
