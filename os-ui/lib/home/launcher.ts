/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The Home **launcher adapter** (home-golden-path.md §"Centerpiece").
 *
 * A PURE, dependency-free path catalog → role→action deep-link + tutorial-link
 * resolver. No server imports, no I/O — so it is trivially unit-testable AND it
 * can render in a React Server Component without a round-trip. The illustrated
 * gallery (one card per golden path) is the platform's front door; this module
 * decides, per viewer persona, each card's:
 *
 *   • one-line explainer (what the path is for),
 *   • a role-aware PRIMARY ACTION verb + deep-link into that tab's flow,
 *   • whether the persona can ACT (else the card is explained-but-dimmed),
 *   • a "How it works" tutorial link (learning is ALWAYS available).
 *
 * Roles in the OS auth model are `participant | builder | admin`. Home expresses
 * the design's four personas (home-golden-path.md §"Role-aware emphasis") by
 * deriving a `HomePersona` from the role + the viewer's authoring activity:
 * a participant who has authored at least one artifact is acting as a *Creator*;
 * one who has not is a *User* (pure consumer). This keeps the security model
 * unchanged while giving the four-way emphasis the design calls for.
 */

import type { Role } from '../core/session.ts';

export type HomePersona = 'user' | 'creator' | 'builder' | 'admin';

/** Ordinal rank for "can this persona perform this path's primary action?". */
export const PERSONA_RANK: Record<HomePersona, number> = {
  user: 0,
  creator: 1,
  builder: 2,
  admin: 3,
};

/** Stable golden-path identifiers (also the tutorial-registry keys). */
export type PathId =
  | 'data'
  | 'knowledge'
  | 'connections'
  | 'agents'
  | 'software'
  | 'science'
  | 'metrics'
  | 'dashboards'
  | 'big-bets'
  | 'marketplace';

type PathDef = {
  id: PathId;
  title: string;
  /** One-line explainer — *what the path is for* (home-golden-path.md table). */
  blurb: string;
  /** The tab this card deep-links into. */
  tab: string;
  /** The Creator-tier action label from the design table (e.g. "Load data"). */
  createLabel: string;
  /**
   * Minimum persona rank to perform the PRIMARY (authoring) action. Consumer
   * paths are 0 (a User can Explore/Use). Connections + Big Bets are Builder-
   * gated authoring surfaces (rank 2), so they are explained-but-dimmed for a
   * User/Creator — exactly as the golden-path docs specify.
   */
  actRank: number;
  /** Illustration key (cohesive custom SVG set — components/home/illustrations). */
  art: PathId;
};

/**
 * The ten golden paths, in the design's gallery order. Copy mirrors
 * home-golden-path.md §"Centerpiece" (incl. the Science line decided in the
 * 2026-06-30 interview: "Train, run & monitor machine learning models.").
 */
export const PATHS: PathDef[] = [
  { id: 'data', title: 'Data', blurb: 'Turn raw data into governed, documented products.', tab: '/data', createLabel: 'Load data', actRank: 0, art: 'data' },
  { id: 'knowledge', title: 'Knowledge', blurb: "Curate the domain's operating manual for agents.", tab: '/knowledge', createLabel: 'Add knowledge', actRank: 0, art: 'knowledge' },
  { id: 'connections', title: 'Connections', blurb: 'Securely connect APIs, DBs & SaaS as governed tools.', tab: '/connections', createLabel: 'Add a connection', actRank: 2, art: 'connections' },
  { id: 'agents', title: 'Agents', blurb: 'Build agents that use your data, knowledge & tools.', tab: '/agents', createLabel: 'Create an agent', actRank: 0, art: 'agents' },
  { id: 'software', title: 'Software', blurb: 'Build & deploy governed apps by chat.', tab: '/software', createLabel: 'Build an app', actRank: 0, art: 'software' },
  { id: 'science', title: 'Science', blurb: 'Train, run & monitor machine learning models.', tab: '/science', createLabel: 'New model', actRank: 0, art: 'science' },
  { id: 'metrics', title: 'Metrics', blurb: 'Define the KPIs everyone agrees on.', tab: '/metrics', createLabel: 'Define a metric', actRank: 0, art: 'metrics' },
  { id: 'dashboards', title: 'Dashboards', blurb: 'See the KPIs; alert & report on them.', tab: '/dashboards', createLabel: 'Build a dashboard', actRank: 0, art: 'dashboards' },
  { id: 'big-bets', title: 'Big Bets', blurb: 'Plan an initiative that bundles all of the above.', tab: '/big-bets', createLabel: 'Start a Big Bet', actRank: 2, art: 'big-bets' },
  { id: 'marketplace', title: 'Marketplace', blurb: 'Discover & reuse certified products across domains.', tab: '/marketplace', createLabel: 'Browse', actRank: 0, art: 'marketplace' },
];

/** Resolved launcher card for one viewer persona. */
export type LauncherCard = {
  id: PathId;
  title: string;
  blurb: string;
  art: PathId;
  /** Role-aware verb shown on the primary action. */
  actionLabel: string;
  /** Deep-link into the owning tab's create/explore flow (with a Home hint). */
  href: string;
  /** Whether this persona may perform the primary action (else dimmed). */
  canAct: boolean;
  /** When dimmed, a short reason ("Builders & Admins can …") for awareness. */
  dimmedReason?: string;
  /** "How it works" → the path's tutorial (single source, two entry points). */
  tutorialHref: string;
};

/**
 * Map the OS auth role + authoring activity to a Home persona. `hasAuthored`
 * is true when the viewer owns ≥1 artifact/app/draft (computed by the feed
 * adapter from the registry); it only ever distinguishes User vs Creator.
 */
export function personaFor(role: Role, hasAuthored: boolean): HomePersona {
  if (role === 'admin') return 'admin';
  if (role === 'builder' || role === 'domain_admin') return 'builder'; // both steward a domain
  return hasAuthored ? 'creator' : 'user';
}

/** Human label for a persona (used in the role-emphasis banner). */
export function personaLabel(p: HomePersona): string {
  return p === 'user' ? 'User' : p === 'creator' ? 'Creator' : p === 'builder' ? 'Builder' : 'Administrator';
}

/** The persona's stance verb (home-golden-path.md §"Role-aware emphasis"). */
export function personaStance(p: HomePersona): string {
  return p === 'user' ? 'Use' : p === 'creator' ? 'Build' : p === 'builder' ? 'Steward' : 'Run';
}

function actionLabel(persona: HomePersona, def: PathDef): string {
  // Marketplace always reads "Browse"; consumers Explore; authors get the
  // create verb; stewards/admins keep the create verb (they can author too) so
  // the action stays a working deep-link, while EMPHASIS shifts via cockpit
  // ordering + the persona banner (kept simple + honest on purpose).
  if (def.id === 'marketplace') return 'Browse';
  if (PERSONA_RANK[persona] === 0) return 'Explore';
  return def.createLabel;
}

function tutorialHref(id: PathId): string {
  // Single tutorial registry key per golden path (tutorials-golden-path.md):
  // Home's "How it works" + the tab header's "Tutorial" resolve the same key.
  return `${tabFor(id)}?tutorial=${id}`;
}

function tabFor(id: PathId): string {
  return PATHS.find((p) => p.id === id)?.tab ?? '/';
}

/** Build the persona's full launcher gallery (all ten cards, ordered). */
export function launcherFor(persona: HomePersona): LauncherCard[] {
  const rank = PERSONA_RANK[persona];
  return PATHS.map((def) => {
    const canAct = rank >= def.actRank;
    const href = canAct ? `${def.tab}?from=home&action=${rank === 0 ? 'explore' : 'create'}` : def.tab;
    return {
      id: def.id,
      title: def.title,
      blurb: def.blurb,
      art: def.art,
      actionLabel: actionLabel(persona, def),
      href,
      canAct,
      dimmedReason: canAct ? undefined : 'Builders & Admins can act here — explore to learn the path.',
      tutorialHref: tutorialHref(def.id),
    };
  });
}
