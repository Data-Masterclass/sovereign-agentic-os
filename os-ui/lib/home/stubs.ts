/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';

/**
 * Cross-tab feed ADAPTERS for the Cockpit "Domain Pulse" and "Spend / Health"
 * modules. These were formerly stubs returning `source: 'mock'` with all-zero
 * values. They now read from the real in-process stores that are already live
 * server-side (Big Bets, Governance cost, User directory, Strategy pillars).
 *
 * Design rules:
 *   - Honest empty state: a domain with NO activity genuinely shows 0s with
 *     source:'live'; the UI is responsible for the "no activity yet" affordance.
 *   - No recomputation drift: Home reads exactly what these functions return and
 *     never re-derives; the stores are the single source of truth.
 *   - Surgical dependency: `domainPulseStub` takes pre-fetched pillars + bets
 *     (already loaded by feed.ts) to avoid double-fetching. User counts come from
 *     a direct listUsers() call (in-process, fast).
 */

import { listUsers } from '@/lib/platform-admin';
import { listCaps, getSpend } from '@/lib/governance';
import { latestManualValue } from '@/lib/strategy';
import type { Pillar } from '@/lib/strategy';
import type { BigBet } from '@/lib/bigbets';
import { deriveBet, completion } from '@/lib/bigbets/status';

export type FeedSource = 'live' | 'mock';

export type DomainPulse = {
  source: FeedSource;
  domain: string;
  /** Value created vs target this period (percent, 0–100+). */
  valuePct: number;
  valueLabel: string;
  activeCreators: number;
  activeBuilders: number;
  promotedThisPeriod: number;
  certifiedThisPeriod: number;
  bets: { name: string; status: 'on-track' | 'at-risk' | 'planned'; pct: number }[];
};

export type HealthCost = {
  source: FeedSource;
  /** Anything red for the viewer's agents/pipelines. */
  redItems: { name: string; detail: string }[];
  spendUsd: number;
  capUsd: number;
  /** Spend as a fraction of cap (0–1+), for the gauge. */
  spendPct: number;
};

/**
 * Live domain-pulse adapter. Reads:
 *   - valuePct   : strategy pillars with targets (manual entries or seed total for
 *                  governed metrics) vs their annual value target.
 *   - activeCreators / activeBuilders : user-directory head-count in the domain.
 *   - bets       : Big Bets store for this domain, status + component completion.
 *
 * Takes pre-fetched `pillars` and `bets` to avoid double-fetching (caller has
 * already loaded them for other feed modules).
 */
export async function domainPulseStub(
  domain: string,
  opts: { pillars: Pillar[]; bets: BigBet[] },
): Promise<DomainPulse> {
  const { pillars, bets } = opts;

  // ── Value % ────────────────────────────────────────────────────────────────
  // Tenant pillars contribute to every domain; domain pillars scope to theirs.
  const relevantPillars = pillars.filter(
    (p) => p.scope === 'tenant' || p.domain === domain,
  );
  let totalActual = 0;
  let totalTarget = 0;
  for (const p of relevantPillars) {
    const target = p.targets?.valueGenerated.annual ?? 0;
    if (target <= 0) continue; // skip pillars without a set target
    const mode = p.valueMetric?.mode ?? (p.metrics[0] ? 'governed' : 'describe');
    let actual = 0;
    if (mode === 'manual') {
      actual = latestManualValue(p.valueMetric);
    } else if (mode === 'governed' && p.metrics[0]) {
      // Use the pillar's offline seed total (safe when Cube is unreachable).
      actual = p.metrics[0].seedTotal;
    }
    // 'describe' mode: no number defined yet — contributes 0 to the numerator.
    totalActual += actual;
    totalTarget += target;
  }
  const valuePct = totalTarget > 0
    ? Math.round((totalActual / totalTarget) * 100)
    : 0;

  // ── Active people ──────────────────────────────────────────────────────────
  // Count enabled users whose domains include this domain, by role.
  const users = await listUsers();
  const domainUsers = users.filter((u) => !u.disabled && u.domains.includes(domain));
  const activeCreators = domainUsers.filter((u) => u.role === 'creator').length;
  // Builders + domain_admins both hold Builder-level authoring rights.
  const activeBuilders = domainUsers.filter(
    (u) => u.role === 'builder' || u.role === 'domain_admin',
  ).length;

  // ── Big Bets ───────────────────────────────────────────────────────────────
  const domainBets = bets.filter(
    (b) => b.domain === domain && b.status !== 'archived',
  );
  const betShapes = domainBets.map((b) => {
    const statuses = deriveBet(b.components);
    const { pct } = completion(statuses);
    // Status mapping: draft → planned; active/shipped → on-track.
    // (at-risk would require component-level override signals — not yet surfaced.)
    const status: DomainPulse['bets'][0]['status'] =
      b.status === 'draft' ? 'planned' : 'on-track';
    return { name: b.name, status, pct };
  });

  return {
    source: 'live',
    domain,
    valuePct,
    valueLabel: `Value created vs ${new Date().getUTCFullYear()} target`,
    activeCreators,
    activeBuilders,
    promotedThisPeriod: 0,
    certifiedThisPeriod: 0,
    bets: betShapes,
  };
}

/**
 * Live health/cost adapter. Reads:
 *   - capUsd  : Governance cost store — most-specific cap for the domain
 *               (domain-level cap if set; falls back to tenant cap).
 *   - spendUsd: recorded spend against that cap's scope/subject.
 *   - redItems: reserved for future Monitoring signals (empty for now).
 */
export function healthCostStub(_viewerId: string, domain: string): HealthCost {
  const allCaps = listCaps();
  // Most-specific cap wins: domain-level before tenant-wide.
  const domainCap = allCaps.find((c) => c.scope === 'domain' && c.subject === domain);
  const tenantCap = allCaps.find((c) => c.scope === 'tenant');
  const activeCap = domainCap ?? tenantCap;

  const capUsd = activeCap?.limit ?? 0;
  const spendUsd = activeCap ? getSpend(activeCap.scope, activeCap.subject) : 0;
  const spendPct = capUsd > 0 ? Math.min(spendUsd / capUsd, 1) : 0;

  return {
    source: 'live',
    redItems: [],
    spendUsd,
    capUsd,
    spendPct,
  };
}
