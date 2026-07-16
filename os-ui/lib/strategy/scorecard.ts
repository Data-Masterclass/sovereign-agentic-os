/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { allArtifacts } from '@/lib/core/artifacts';
import { listUsers } from '@/lib/platform-admin';
import type { CurrentUser } from '@/lib/core/auth';
import { entitledToDomain } from '@/lib/strategy/model';
import { buildScorecard, type Scorecard } from '@/lib/strategy/scorecard-core';

/**
 * Strategy scorecard adapter — the LIVE Self Service + Foundations numbers for a
 * viewer, derived from the registry + user roster and RLS-scoped to the viewer's
 * own company/domain. A tenant-wide viewer (an Admin on the platform) sees the
 * whole company; a domain member sees only the domains they are entitled to, so
 * the sections never leak another domain's footprint. The pure reduction lives
 * in `scorecard-core.ts`; this module just supplies the scoped inputs.
 */

/** Is this viewer entitled across the whole tenant (sees every domain)? */
function isTenantWide(user: CurrentUser): boolean {
  return user.role === 'admin' && user.domains.includes('platform');
}

export async function strategyScorecard(user: CurrentUser): Promise<Scorecard> {
  const [arts, users] = await Promise.all([allArtifacts(), listUsers()]);
  const tenantWide = isTenantWide(user);
  const inScope = (domain: string) => tenantWide || entitledToDomain(user, domain);

  const scopedArts = arts.filter((a) => inScope(a.domain));
  const scopedUsers = users
    .filter((u) => u.domains.some((d) => inScope(d)))
    .map((u) => ({ id: u.id, role: u.role }));

  const scopeLabel = tenantWide
    ? 'Company'
    : user.domains.length === 1
      ? user.domains[0]
      : 'Company';

  return buildScorecard(scopedArts, scopedUsers, { scopeLabel });
}
