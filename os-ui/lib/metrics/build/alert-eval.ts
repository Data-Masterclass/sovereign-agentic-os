/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { claimsFromUser, delegate, type DelegatedToken } from '../../data/identity.ts';
import { getMetric, listMetrics } from '../store.ts';
import { getPublicUser } from '../../platform-admin/users.ts';
import type { Principal } from '../../data/store.ts';
import type { Dataset, Measure } from '../../data/index.ts';
import { exploreMetric } from './explore-server.ts';
import type { AlertRuleRecord } from '../alert-store.ts';

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
  /** No number yet (metric un-computable for this slice / empty result / unresolved member). */
  | { status: 'pending'; reason?: string };

/** The owner Principal the headless evaluation runs as (RLS-scoped registry + dataset reads).
 *  Derived from the governed user directory; falls back to the rule's stored owner/domain when
 *  the directory has no record (pre-IdP / seeded rules) — still the OWNER's subject. */
async function ownerPrincipal(rule: AlertRuleRecord): Promise<Principal> {
  const pub = await getPublicUser(rule.owner);
  return {
    id: rule.owner,
    domains: pub?.domains ?? (rule.domain ? [rule.domain] : []),
    role: pub?.role ?? 'creator',
  };
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
  } = {},
): Promise<AlertValue> {
  const explore = deps.explore ?? exploreMetric;
  const resolve = deps.resolve ?? resolveMemberForOwner;
  const owner = await ownerPrincipal(rule);
  const token = ownerToken(owner);

  const found = resolve(rule.member, owner);
  if (!found) return { status: 'pending', reason: 'the metric behind this alert could not be resolved for the owner' };

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
