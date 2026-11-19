/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Home feed adapter — assembles one viewer's Home page data
 * USER STORY: As any signed-in user I want Home to show my approvals, work in progress, recent activity,
 *             domain pulse and spend in one place, limited to what I am entitled to see.
 * ARCHITECTURE:
 *   - Server-only. Fetches rows with the caller's identity from the existing stores
 *     (`@core/policy/approvals`, `@core/kernel/artifacts`, `@tabs/software/lib`, `./stubs`) and passes
 *     them to the pure shapers in `./scope` and `./launcher`. No logic is duplicated from those tabs.
 *   - Read and route only: it mutates nothing. Approvals are listed per viewer domain; the certified
 *     marketplace rows are used only for the "recent activity" feed.
 *   - Called by `app/api/home/feed/route.ts` and `app/page.tsx`.
 */
import 'server-only';

import type { CurrentUser } from '@core/kernel/auth';
import { listApprovals } from '@core/policy/approvals';
import { listForUser, listMarketplace } from '@core/kernel/artifacts';
import { listAppsForUser } from '@tabs/software/lib/index';
import {
  hasAuthored,
  whatNeedsMe,
  myWip,
  recentActivity,
  cockpitOrder,
  topItems,
  type Viewer,
  type ArtifactInput,
  type AppInput,
  type ApprovalInput,
  type NeedItem,
  type WipItem,
  type ActivityItem,
  type ModuleKey,
  type TopGroup,
} from '@tabs/home/lib/scope';
import { personaFor, launcherFor, personaLabel, personaStance, type HomePersona, type LauncherCard } from '@tabs/home/lib/launcher';
import { domainPulseStub, healthCostStub, type DomainPulse, type HealthCost } from '@tabs/home/lib/stubs';

export type HomeFeed = {
  persona: HomePersona;
  personaLabel: string;
  personaStance: string;
  /** The viewer's primary domain (pulse/health are scoped to it). */
  domain: string;
  launcher: LauncherCard[];
  order: ModuleKey[];
  needs: NeedItem[];
  wip: WipItem[];
  recent: ActivityItem[];
  pulse: DomainPulse;
  health: HealthCost;
  /** Scannable "top items per artifact" board, OPA/RLS-scoped to the viewer. */
  topItems: TopGroup[];
};

function toViewer(user: CurrentUser): Viewer {
  return { id: user.id, domains: user.domains, role: user.role };
}

/**
 * Aggregate one viewer's full Home, OPA/RLS-scoped. Every source is fetched
 * with the caller's identity so nothing they aren't entitled to can appear.
 */
export async function homeFeed(user: CurrentUser): Promise<HomeFeed> {
  const viewer = toViewer(user);
  const domain = user.domains[0] ?? 'default';

  // LIVE registry/governance rows, each fetched scoped to the viewer.
  const [artifactsRaw, appsRaw, marketRaw] = await Promise.all([
    listForUser(user), // RLS: Personal(own) + Shared(in-domain) + certified copies
    listAppsForUser(user), // RLS: Personal(own) + Shared(in-domain) + Certified
    // Certified catalog is cross-domain by design (Marketplace) — used ONLY to
    // surface "newly certified" in Recent activity (discovery), never in the
    // entitlement-sensitive What-needs-me / My-WIP modules.
    listMarketplace(),
  ]);
  // Approvals are listed per the viewer's domains only (then scope.ts further
  // gates decide-rights by role / requester) — cross-domain never enters.
  const approvalsRaw: ApprovalInput[] = viewer.domains.flatMap((d) =>
    listApprovals({ domain: d }).map((a) => ({
      id: a.id,
      kind: a.kind,
      title: a.title,
      detail: a.detail,
      domain: a.domain,
      requestedBy: a.requestedBy,
      status: a.status,
      createdAt: a.createdAt,
    })),
  );

  const artifacts: ArtifactInput[] = artifactsRaw.map((a) => ({
    id: a.id,
    type: a.type,
    name: a.name,
    owner: a.owner,
    domain: a.domain,
    visibility: a.visibility,
    origin: a.origin,
    updatedAt: a.updatedAt,
  }));
  const apps: AppInput[] = appsRaw.map((a) => ({
    id: a.id,
    name: a.name,
    owner: a.owner,
    domain: a.domain,
    visibility: a.visibility,
    updatedAt: a.updatedAt,
  }));
  // Certified catalog rows, shaped for the Recent-activity discovery feed only.
  const market: ArtifactInput[] = marketRaw.map((a) => ({
    id: a.id,
    type: a.type,
    name: a.name,
    owner: a.owner,
    domain: a.domain,
    visibility: a.visibility,
    origin: a.origin,
    updatedAt: a.updatedAt,
  }));

  const persona = personaFor(user.role, hasAuthored(viewer, artifacts, apps));

  return {
    persona,
    personaLabel: personaLabel(persona),
    personaStance: personaStance(persona),
    domain,
    launcher: launcherFor(persona),
    order: cockpitOrder(persona),
    needs: whatNeedsMe(viewer, approvalsRaw, artifacts),
    wip: myWip(viewer, artifacts, apps),
    // Shared in-domain events (scoped) + newly Certified products (cross-domain).
    recent: recentActivity(viewer, [...artifacts, ...market]),
    pulse: await domainPulseStub(domain), // LIVE
    health: healthCostStub(user.id, domain), // LIVE
    topItems: topItems(viewer, artifacts, apps),

  };
}
