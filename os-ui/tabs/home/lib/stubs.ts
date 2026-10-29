/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';

/**
 * NOTE: despite the filename (`stubs.ts`) and the `*Stub` export suffix, these are
 * LIVE readers, not stubs. The names are kept to avoid rippling imports across the
 * Home feed; the behavior below is real. (A rename is a separate, larger change.)
 *
 * Cross-tab feed ADAPTERS for the Cockpit "Domain Pulse" and "Spend / Health"
 * modules. These were formerly stubs returning `source: 'mock'` with all-zero
 * values. They now read from the real in-process stores that are already live
 * server-side (Governance cost, User directory).
 *
 * Design rules:
 *   - Honest empty state: a domain with NO activity genuinely shows 0s with
 *     source:'live'; the UI is responsible for the "no activity yet" affordance.
 *   - No recomputation drift: Home reads exactly what these functions return and
 *     never re-derives; the stores are the single source of truth.
 *   - Surgical dependency: user counts come from a direct listUsers() call
 *     (in-process, fast).
 */

import { listUsers } from '@tabs/admin/lib/index';
import { listCaps, getSpend } from '@core/policy/index';

export type FeedSource = 'live' | 'mock';

export type DomainPulse = {
  source: FeedSource;
  domain: string;
  activeCreators: number;
  activeBuilders: number;
  promotedThisPeriod: number;
  certifiedThisPeriod: number;
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
 *   - activeCreators / activeBuilders : user-directory head-count in the domain.
 */
export async function domainPulseStub(domain: string): Promise<DomainPulse> {
  // ── Active people ──────────────────────────────────────────────────────────
  // Count enabled users whose domains include this domain, by role.
  const users = await listUsers();
  const domainUsers = users.filter((u) => !u.disabled && u.domains.includes(domain));
  const activeCreators = domainUsers.filter((u) => u.role === 'creator').length;
  // Builders + domain_admins both hold Builder-level authoring rights.
  const activeBuilders = domainUsers.filter(
    (u) => u.role === 'builder' || u.role === 'domain_admin',
  ).length;

  return {
    source: 'live',
    domain,
    activeCreators,
    activeBuilders,
    promotedThisPeriod: 0,
    certifiedThisPeriod: 0,
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
