/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';

/**
 * The Home **home-feed adapter** (home-golden-path.md §"Under the hood").
 *
 * A thin, per-viewer/OPA aggregator that REUSES the existing per-tab data
 * sources and never duplicates their logic:
 *   • approvals  → lib/approvals (Governance queue)            [LIVE]
 *   • my WIP +   → lib/artifacts + lib/apps (registry/OM)      [LIVE]
 *     recent activity
 *   • domain pulse → lib/home/stubs (Strategy roll-up)         [LIVE]
 *   • health & cost → lib/home/stubs (Governance cost store)   [LIVE]
 *
 * It fetches the raw rows, then hands them to the PURE scope.ts shapers which
 * apply the SAME RLS predicates the owning tabs enforce. Home is read + route —
 * this module triggers nothing and mutates nothing; it only re-surfaces, scoped.
 * The two live feeds read from real in-process stores and return `source:'live'`.
 */

import type { CurrentUser } from '@/lib/core/auth';
import { listApprovals } from '@/lib/approvals';
import { listForUser, listMarketplace } from '@/lib/core/artifacts';
import { listAppsForUser } from '@/lib/apps';
import { listBets } from '@/lib/bigbets/store';
import { listPillars } from '@/lib/strategy/pillars';
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
} from './scope.ts';
import { personaFor, launcherFor, personaLabel, personaStance, type HomePersona, type LauncherCard } from './launcher.ts';
import { domainPulseStub, healthCostStub, type DomainPulse, type HealthCost } from './stubs.ts';

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
  const [artifactsRaw, appsRaw, marketRaw, betsRaw, pillarsRaw] = await Promise.all([
    listForUser(user), // RLS: Personal(own) + Shared(in-domain) + certified copies
    listAppsForUser(user), // RLS: Personal(own) + Shared(in-domain) + Certified
    // Certified catalog is cross-domain by design (Marketplace) — used ONLY to
    // surface "newly certified" in Recent activity (discovery), never in the
    // entitlement-sensitive What-needs-me / My-WIP modules.
    listMarketplace(),
    Promise.resolve(listBets(user)), // RLS: canView (owner/member/in-domain)
    listPillars(user), // RLS: tenant pillars + the viewer's domain pillars
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

  // Scoped inputs for the "top items" board (already entitlement-filtered above
  // / by the scoped list calls). Shaped by the pure topItems() shaper.
  const bets = betsRaw.map((b) => ({ id: b.id, name: b.name, domain: b.domain, status: b.status, updatedAt: b.updatedAt }));
  const pillars = pillarsRaw.map((p) => ({ id: p.id, name: p.name, scope: p.scope, domain: p.domain, updatedAt: p.updatedAt }));

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
    pulse: await domainPulseStub(domain, { pillars: pillarsRaw, bets: betsRaw }), // LIVE
    health: healthCostStub(user.id, domain), // LIVE
    topItems: topItems(viewer, artifacts, apps, bets, pillars),
  };
}

/**
 * The **Cockpit feed** — the canonical name for the OPA/RLS-scoped aggregate the
 * `/cockpit` route renders (modules + top-items board). It is the SAME governed
 * aggregator as `homeFeed`; Home reads only its launcher slice, the Cockpit reads
 * the modules + board. Kept as one source so the two surfaces can never drift.
 */
export const cockpitFeed = homeFeed;
