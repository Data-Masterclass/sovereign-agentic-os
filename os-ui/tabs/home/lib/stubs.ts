/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Home domain-pulse and spend/health readers
 * USER STORY: As a builder I want Home to show how many creators and builders are active in my domain and
 *             how much of the cost cap is spent, so that I see the state of my domain at a glance.
 * ARCHITECTURE:
 *   - Server-only. Despite the file name and the `*Stub` suffix, both functions read live in-process
 *     stores: `listUsers()` from `@tabs/admin/lib` and `listCaps()` / `getSpend()` from `@core/policy`.
 *   - Partly unimplemented: `promotedThisPeriod` and `certifiedThisPeriod` are always 0 and
 *     `redItems` is always empty, while the result is still marked `source: 'live'`.
 *   - Most specific cap wins (domain before tenant). Called only by `./feed`.
 */
import 'server-only';

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
