/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { claimsFromUser, delegate, type DelegatedToken } from '@core/kernel/identity';
import { getMetric, listMetrics } from '@tabs/metrics/lib/store';
import { getPublicUser } from '@tabs/admin/lib/users';
import { liveDomains } from '@core/kernel/auth';
import type { Principal } from '@tabs/data/lib/store';
import type { Dataset, Measure } from '@tabs/data/lib/index';
import { exploreMetric } from '@tabs/metrics/lib/build/explore-server';
import type { AlertRuleRecord } from '@tabs/metrics/lib/alert-store';

/**
 * Headless alert evaluation (Phase 2): resolve an alert rule's metric value through the SAME
 * governed-SQL path the explorer + dashboards use ({@link exploreMetric}) — Cube is off the
 * read path. An alert runs HEADLESS, so it must evaluate AS THE RULE'S OWNER would see the
 * number, not as whoever triggered the cron: we mint an owner-DELEGATED token from the owner's
 * governed identity (R2 — never a service account), so the exact per-viewer row/column security
 * the owner sees is what the threshold is tested against.
 *
 * HONESTY: a real-deployment Trino outage makes exploreMetric return `unavailable` — the alert
 * then SKIPS with status 'unavailable' (never a fabricated value, never a false alarm). A metric
 * that has no number yet (a window measure with no time slice, or an empty result) is 'pending'.
 * Only a genuinely computed number is 'ok'.
 */

export type AlertValue =
  | { status: 'ok'; value: number }
  /** Trino unreachable on a real deployment — evaluation is SKIPPED, no value fabricated. */
  | { status: 'unavailable'; reason: string }
  /** No number yet (metric un-computable for this slice / empty result). */
  | { status: 'pending'; reason?: string }
  /** The alert has nothing left to watch, or no one to watch it for: its metric was deleted or
   *  archived (or is no longer visible to its owner), or its owner was deleted or deactivated.
   *  Never evaluated, and never retried as if a number were merely late. */
  | { status: 'orphaned'; reason: string };

/** The owner Principal the headless evaluation runs as (RLS-scoped registry + dataset reads):
 *  the owner as the user directory has them NOW (role, active domains). `null` when the owner
 *  no longer exists or is deactivated — the alert then does not run at all, rather than run
 *  under an identity assembled from what the rule remembered. */
async function ownerPrincipal(rule: AlertRuleRecord): Promise<Principal | null> {
  const pub = await getPublicUser(rule.owner);
  if (!pub || pub.disabled) return null;
  return { id: rule.owner, domains: liveDomains(pub.domains), role: pub.role };
}

/** The owner's DELEGATED token so the headless read runs AS the owner (R2/R3 — the per-viewer
 *  RLS the owner sees), never a service account and never the cron-triggerer's identity. */
function ownerToken(owner: Principal): DelegatedToken {
  return delegate(claimsFromUser({ id: owner.id, domains: owner.domains, role: owner.role }), 'domain');
}

/** Resolve a governed metric MEMBER (`View.measure`) to its dataset + measure, scoped to the
 *  OWNER's entitlement (the same registry resolution the dashboards panel path uses). */
export function resolveMemberForOwner(member: string, owner: Principal): { dataset: Dataset; measure: Measure } | null {
  const groups = listMetrics(owner);
  const summary = [...groups.mine, ...groups.domain, ...groups.marketplace].find((s) => s.member === member);
  if (!summary) return null;
  try {
    const rec = getMetric(summary.id, owner);
    return { dataset: rec.dataset, measure: rec.measure };
  } catch {
    return null;
  }
}

/**
 * Resolve an alert rule's current metric value AS its owner, honestly classified. The member is
 * matched against the owner's visible metrics (never outside their entitlement), then served via
 * the governed-SQL path. `resolve`/`explore` are injectable for unit tests.
 */
export async function resolveAlertValue(
  rule: AlertRuleRecord,
  deps: {
    explore?: typeof exploreMetric;
    resolve?: (member: string, owner: Principal) => { dataset: Dataset; measure: Measure } | null;
    owner?: (rule: AlertRuleRecord) => Promise<Principal | null>;
  } = {},
): Promise<AlertValue> {
  const explore = deps.explore ?? exploreMetric;
  const resolve = deps.resolve ?? resolveMemberForOwner;
  const owner = await (deps.owner ?? ownerPrincipal)(rule);
  if (!owner) {
    return { status: 'orphaned', reason: `the owner of this alert (${rule.owner}) was deleted or deactivated, so it is not evaluated` };
  }
  const token = ownerToken(owner);

  const found = resolve(rule.member, owner);
  if (!found) {
    return {
      status: 'orphaned',
      reason: `the metric ${rule.member} this alert watches was deleted or archived, or its owner can no longer see it`,
    };
  }

  const result = await explore(found.dataset, found.measure, token, {});
  if (result.unavailable) {
    return { status: 'unavailable', reason: result.warning ?? 'the governed lakehouse is unreachable' };
  }
  if (result.pending || result.rows.length === 0) {
    return { status: 'pending', reason: result.warning };
  }
  const value = result.rows.reduce((sum, row) => sum + Number(row[result.member] ?? 0), 0);
  return { status: 'ok', value };
}
