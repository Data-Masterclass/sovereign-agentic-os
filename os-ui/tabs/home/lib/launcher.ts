/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Home launcher adapter — the golden-path cards and their role-aware actions
 * USER STORY: As a user I want Home to show one card per golden path with an action I can actually take,
 *             and explain the paths I cannot act on, so that I know where to start.
 * ARCHITECTURE:
 *   - Pure, no I/O and no server imports, so it is unit-tested and can render in a server component.
 *   - Derives a Home persona from the auth role plus authoring activity: admin → admin; builder or
 *     domain_admin → builder; any other role is creator if it has authored something, else user.
 *   - Each card gets a deep link (`<tab>?from=home&action=…`) and is dimmed when the persona rank is
 *     below the path's `actRank`. Used by `./feed` and `tabs/home/ui/HomeLauncher.tsx`.
 *   - I18N: the English titles, blurbs and labels stay here for non-UI readers (feed, MCP, tests). The UI
 *     renders `home.launcher.paths.<id>.{title,blurb,action}`, `home.launcher.explore`, `home.launcher.dimmed`
 *     and `home.persona.{label,stance}.<persona>` — keyed by the stable ids, `actionKey` says which verb.
 */

import type { Role } from '@core/kernel/session';

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
  | 'files'
  | 'knowledge'
  | 'connections'
  | 'metrics'
  | 'dashboards'
  | 'agents'
  | 'workflows'
  | 'software';

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
   * paths are 0 (a User can Explore/Use). Connections is a Builder-
   * gated authoring surface (rank 2), so it is explained-but-dimmed for a
   * User/Creator — exactly as the golden-path docs specify.
   */
  actRank: number;
  /** Illustration key (cohesive custom SVG set — components/home/illustrations). */
  art: PathId;
};

/**
 * The golden paths, in the order the product actually reads: bring context in,
 * agree on the numbers, then put it to work. One card per tab a person CREATES
 * something in — Governance, Monitoring and Admin are not creation paths and are
 * reached from the sidebar instead.
 */
export const PATHS: PathDef[] = [
  // 1. Bring context in — nothing downstream works without this.
  { id: 'data', title: 'Data', blurb: 'Turn raw data into governed, documented products.', tab: '/data', createLabel: 'Load data', actRank: 0, art: 'data' },
  { id: 'files', title: 'Files', blurb: 'Bring documents in and make them readable by agents.', tab: '/unstructured', createLabel: 'Upload a document', actRank: 0, art: 'files' },
  { id: 'knowledge', title: 'Knowledge', blurb: "Curate the domain's operating manual for agents.", tab: '/knowledge', createLabel: 'Add knowledge', actRank: 0, art: 'knowledge' },
  { id: 'connections', title: 'Connections', blurb: 'Securely connect APIs, DBs & SaaS as governed tools.', tab: '/connections', createLabel: 'Add a connection', actRank: 2, art: 'connections' },

  // 2. Agree on the numbers — one definition, used everywhere.
  { id: 'metrics', title: 'KPIs', blurb: 'Define the numbers everyone agrees on, once.', tab: '/metrics', createLabel: 'Define a KPI', actRank: 0, art: 'metrics' },
  { id: 'dashboards', title: 'Dashboards', blurb: 'Put the KPIs in front of people; alert and report.', tab: '/dashboards', createLabel: 'Build a dashboard', actRank: 0, art: 'dashboards' },

  // 3. Put it to work — the reason the rest exists.
  { id: 'agents', title: 'Agents', blurb: 'Build agents that use your data, knowledge & tools.', tab: '/agents', createLabel: 'Create an agent', actRank: 0, art: 'agents' },
  { id: 'workflows', title: 'Workflows', blurb: 'Write down how the work actually runs, step by step.', tab: '/workflows', createLabel: 'Map a workflow', actRank: 0, art: 'workflows' },
  { id: 'software', title: 'Software', blurb: 'Build & deploy governed apps by chat.', tab: '/software', createLabel: 'Build an app', actRank: 0, art: 'software' },
];

/** Resolved launcher card for one viewer persona. */
export type LauncherCard = {
  id: PathId;
  title: string;
  blurb: string;
  art: PathId;
  /** Role-aware verb shown on the primary action (English). */
  actionLabel: string;
  /** Which verb that is, for the translated UI: the path's own create verb, or "Explore". */
  actionKey: 'create' | 'explore';
  /** Deep-link into the owning tab's create/explore flow (with a Home hint). */
  href: string;
  /** Whether this persona may perform the primary action (else dimmed). */
  canAct: boolean;
  /** When dimmed, a short reason ("Builders & Admins can …") for awareness. */
  dimmedReason?: string;
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
  // Consumers Explore; authors get the create verb; stewards/admins keep the
  // create verb (they can author too) so the action stays a working deep-link,
  // while EMPHASIS shifts via cockpit ordering + the persona banner (kept
  // simple + honest on purpose).
  if (PERSONA_RANK[persona] === 0) return 'Explore';
  return def.createLabel;
}

function tabFor(id: PathId): string {
  return PATHS.find((p) => p.id === id)?.tab ?? '/';
}

/** Build the persona's full launcher gallery (all cards, ordered). */

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
      actionKey: rank === 0 ? 'explore' : 'create',
      href,
      canAct,
      dimmedReason: canAct ? undefined : 'Builders & Admins can act here — explore to learn the path.',
    };
  });
}
