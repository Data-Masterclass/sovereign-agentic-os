/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Cockpit **scoping** — the OPA/RLS security boundary for Home's personalized
 * modules (home-golden-path.md §"Cockpit modules"). PURE: it takes the raw
 * registry rows (approvals, artifacts, apps) the feed adapter already fetched
 * and shapes the per-viewer cockpit, applying the SAME visibility predicates the
 * owning tabs enforce — so Home never shows what the viewer isn't entitled to,
 * and never recomputes a number a tab already owns (it only re-surfaces rows).
 *
 * Home is a READ + ROUTE surface: every item carries a deep-link to its owning
 * tab; nothing here mutates. Promote/approve happen in the owning tab's governed
 * flow. Keeping this pure makes the entitlement boundary directly unit-testable
 * (feed.test / scope.test) with a second role, which is the validation gate.
 */

import type { HomePersona } from './launcher.ts';
import { roleAtLeast, type Role } from '../core/session.ts';

export type Viewer = { id: string; domains: string[]; role: Role };

// ---- Minimal structural inputs (decoupled from the server-only stores) -------

export type ApprovalInput = {
  id: string;
  kind: string;
  title: string;
  detail: string;
  domain: string;
  requestedBy: string;
  status: string;
  createdAt: string;
};

export type ArtifactInput = {
  id: string;
  type: string;
  name: string;
  owner: string;
  domain: string;
  visibility: 'Personal' | 'Shared' | 'Certified';
  origin: 'authored' | 'certified-copy';
  updatedAt: string;
};

export type AppInput = {
  id: string;
  name: string;
  owner: string;
  domain: string;
  visibility: 'Personal' | 'Shared' | 'Certified';
  updatedAt: string;
};

// ---- Cockpit output shapes ---------------------------------------------------

export type NeedItem = {
  id: string;
  kind: 'approval' | 'promote' | 'request';
  label: string;
  detail: string;
  /** True when THIS viewer can act on it now; false = informational (waiting). */
  actionable: boolean;
  href: string;
};

export type WipItem = {
  id: string;
  name: string;
  type: string;
  visibility: 'Personal' | 'Shared' | 'Certified';
  href: string;
  updatedAt: string;
};

export type ActivityItem = {
  id: string;
  name: string;
  type: string;
  event: 'certified' | 'shared';
  domain: string;
  href: string;
  at: string;
};

const TAB_FOR_TYPE: Record<string, string> = {
  dataset: '/data',
  transformation: '/data',
  metric: '/metrics',
  dashboard: '/dashboards',
  agent: '/agents',
  knowledge: '/knowledge',
  connection: '/connections',
  file: '/unstructured',
  app: '/software',
};

function isBuilderish(v: Viewer): boolean {
  return roleAtLeast(v.role, 'builder');
}

/** Whether the viewer has authored anything (User vs Creator persona signal). */
export function hasAuthored(viewer: Viewer, artifacts: ArtifactInput[], apps: AppInput[]): boolean {
  return (
    artifacts.some((a) => a.owner === viewer.id && a.origin === 'authored') ||
    apps.some((a) => a.owner === viewer.id)
  );
}

/**
 * "What needs me" — the personalized action inbox. RLS:
 *   • approvals are only ever visible inside the viewer's domains;
 *   • a Builder/Admin sees them as ACTIONABLE (their queue to clear);
 *   • a User/Creator sees ONLY the approvals THEY requested, as informational
 *     ("awaiting a Builder") — never another user's, never an actionable button.
 *   • drafts-ready-to-promote: a Creator/Builder's OWN Personal artifacts;
 *     an Admin additionally sees in-domain Shared artifacts ready to certify.
 */
export function whatNeedsMe(
  viewer: Viewer,
  approvals: ApprovalInput[],
  artifacts: ArtifactInput[],
): NeedItem[] {
  const items: NeedItem[] = [];
  const inDomain = (d: string) => viewer.domains.includes(d);

  for (const a of approvals) {
    if (a.status !== 'pending') continue;
    if (!inDomain(a.domain)) continue; // hard RLS: cross-domain never leaks
    const canDecide = isBuilderish(viewer);
    const mine = a.requestedBy === viewer.id;
    if (!canDecide && !mine) continue; // a consumer only sees their OWN request
    items.push({
      id: a.id,
      kind: canDecide ? 'approval' : 'request',
      label: canDecide ? a.title : `Awaiting approval: ${a.title}`,
      detail: canDecide ? a.detail : 'Submitted by you — a Builder/Admin will review it.',
      actionable: canDecide,
      href: '/governance',
    });
  }

  // Drafts ready to promote (mine), or to certify (admin, in-domain Shared).
  for (const art of artifacts) {
    if (art.origin !== 'authored') continue;
    const mineDraft = art.owner === viewer.id && art.visibility === 'Personal';
    const adminCertify = viewer.role === 'admin' && art.visibility === 'Shared' && inDomain(art.domain);
    if (!mineDraft && !adminCertify) continue;
    items.push({
      id: `promote_${art.id}`,
      kind: 'promote',
      label: adminCertify ? `Certify “${art.name}”` : `Promote “${art.name}”`,
      detail: adminCertify
        ? `Domain ${art.type} ready to certify to Company.`
        : `Your ${art.type} — promote to Domain when ready.`,
      actionable: adminCertify ? true : isBuilderish(viewer), // Creator drafts: a Builder promotes
      href: TAB_FOR_TYPE[art.type] ?? '/data',
    });
  }

  return items;
}

/** "My work in progress" — the viewer's in-flight Personal artifacts + apps. */
export function myWip(viewer: Viewer, artifacts: ArtifactInput[], apps: AppInput[]): WipItem[] {
  const out: WipItem[] = [];
  for (const a of artifacts) {
    if (a.owner !== viewer.id) continue;
    if (a.visibility !== 'Personal') continue; // in-flight = not yet shared/certified
    out.push({ id: a.id, name: a.name, type: a.type, visibility: a.visibility, href: TAB_FOR_TYPE[a.type] ?? '/data', updatedAt: a.updatedAt });
  }
  for (const ap of apps) {
    if (ap.owner !== viewer.id) continue;
    if (ap.visibility === 'Certified') continue;
    out.push({ id: ap.id, name: ap.name, type: 'app', visibility: ap.visibility, href: '/software', updatedAt: ap.updatedAt });
  }
  return out.sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
}

/**
 * "Recent activity" — domain changes for awareness/discovery: newly Shared
 * items in the viewer's domains + newly Certified products (cross-domain
 * discovery). RLS: Shared is gated to the viewer's domains; Personal never
 * appears (it isn't a domain event).
 */
export function recentActivity(viewer: Viewer, artifacts: ArtifactInput[]): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const a of artifacts) {
    if (a.origin !== 'authored') continue;
    if (a.visibility === 'Shared' && viewer.domains.includes(a.domain)) {
      out.push({ id: a.id, name: a.name, type: a.type, event: 'shared', domain: a.domain, href: TAB_FOR_TYPE[a.type] ?? '/data', at: a.updatedAt });
    } else if (a.visibility === 'Certified') {
      out.push({ id: a.id, name: a.name, type: a.type, event: 'certified', domain: a.domain, href: '/marketplace', at: a.updatedAt });
    }
  }
  return out.sort((x, y) => y.at.localeCompare(x.at)).slice(0, 8);
}

/**
 * Cockpit module ordering by persona (home-golden-path.md §"Role-aware
 * emphasis"). Same modules, different emphasis: a User leads with use + ask; a
 * Creator with their drafts/WIP; a Builder with approvals + domain pulse; an
 * Admin with the action inbox + health/cost. This is the load-bearing "Creator
 * vs Builder see different emphasis" signal, alongside launcher dimming.
 */
export type ModuleKey = 'needs' | 'wip' | 'pulse' | 'health' | 'recent' | 'ask';

export function cockpitOrder(persona: HomePersona): ModuleKey[] {
  switch (persona) {
    case 'user':
      return ['ask', 'recent', 'wip', 'pulse', 'health', 'needs'];
    case 'creator':
      return ['needs', 'wip', 'ask', 'pulse', 'recent', 'health'];
    case 'builder':
      return ['needs', 'pulse', 'wip', 'health', 'recent', 'ask'];
    case 'admin':
      return ['needs', 'health', 'pulse', 'recent', 'wip', 'ask'];
  }
}

// ---- Top items per artifact (the scannable "what's notable" board) -----------

/**
 * "Top items per artifact" — a scannable board of the viewer's most-notable
 * entries per registry type (datasets, metrics, dashboards, agents, knowledge,
 * files, connections, software, big bets, strategy pillars), each deep-linking
 * into its owning tab. PURE: it shapes ONLY the pre-scoped rows the feed adapter
 * already fetched with the viewer's identity (listForUser / listAppsForUser /
 * listBets / listPillars), so the same RLS boundary holds — nothing cross-domain
 * and no other user's Personal item can appear. Empty types are omitted (honest
 * empty state); each group keeps a `count` so the UI can say "+N more".
 */
export type TopItem = {
  id: string;
  name: string;
  /** Short type-specific descriptor (visibility · domain, status, scope, …). */
  meta: string;
  href: string;
  /** A small visual key for the row dot ('shared' | 'certified' | 'personal' | status). */
  tone: string;
};

export type TopGroup = {
  key: string;
  /** Plural, human label ("Datasets", "Big Bets", "Strategy pillars"). */
  label: string;
  /** Single-glyph marker, matching the sidebar's visual language. */
  icon: string;
  /** Owning tab. */
  tab: string;
  /** Total available to the viewer in this type (may exceed `items.length`). */
  count: number;
  items: TopItem[];
};

export type TopBetInput = { id: string; name: string; domain: string; status: string; updatedAt: string };
export type TopPillarInput = { id: string; name: string; scope: string; domain?: string; updatedAt: string };

/** Per-artifact-type display config + canonical board order. */
const TOP_TYPES: { type: string; key: string; label: string; icon: string; tab: string }[] = [
  { type: 'dataset', key: 'dataset', label: 'Datasets', icon: '▤', tab: '/data' },
  { type: 'transformation', key: 'transformation', label: 'Transformations', icon: '⑂', tab: '/data' },
  { type: 'metric', key: 'metric', label: 'Metrics', icon: '∑', tab: '/metrics' },
  { type: 'dashboard', key: 'dashboard', label: 'Dashboards', icon: '▦', tab: '/dashboards' },
  { type: 'agent', key: 'agent', label: 'Agents', icon: '✦', tab: '/agents' },
  { type: 'knowledge', key: 'knowledge', label: 'Knowledge', icon: '❦', tab: '/knowledge' },
  { type: 'file', key: 'file', label: 'Files', icon: '❏', tab: '/unstructured' },
  { type: 'connection', key: 'connection', label: 'Connections', icon: '⇄', tab: '/connections' },
];

const TOP_PER_GROUP = 4;

function visTone(v: ArtifactInput['visibility'], origin: ArtifactInput['origin']): string {
  if (origin === 'certified-copy' || v === 'Certified') return 'certified';
  if (v === 'Shared') return 'shared';
  return 'personal';
}

export function topItems(
  viewer: Viewer,
  artifacts: ArtifactInput[],
  apps: AppInput[],
  bets: TopBetInput[],
  pillars: TopPillarInput[],
): TopGroup[] {
  const groups: TopGroup[] = [];
  const byRecent = (a: { updatedAt: string }, b: { updatedAt: string }) => b.updatedAt.localeCompare(a.updatedAt);

  // Registry artifact types — already RLS-scoped by listForUser upstream.
  for (const cfg of TOP_TYPES) {
    const rows = artifacts.filter((a) => a.type === cfg.type).sort(byRecent);
    if (rows.length === 0) continue;
    groups.push({
      key: cfg.key,
      label: cfg.label,
      icon: cfg.icon,
      tab: cfg.tab,
      count: rows.length,
      items: rows.slice(0, TOP_PER_GROUP).map((a) => ({
        id: a.id,
        name: a.name,
        meta: `${a.visibility}${viewer.domains.length > 1 ? ` · ${a.domain}` : ''}`,
        href: TAB_FOR_TYPE[a.type] ?? cfg.tab,
        tone: visTone(a.visibility, a.origin),
      })),
    });
  }

  // Software (apps) — owner/in-domain/certified scoped by listAppsForUser.
  const appRows = [...apps].sort(byRecent);
  if (appRows.length > 0) {
    groups.push({
      key: 'software',
      label: 'Software',
      icon: '⌘',
      tab: '/software',
      count: appRows.length,
      items: appRows.slice(0, TOP_PER_GROUP).map((a) => ({
        id: a.id,
        name: a.name,
        meta: `${a.visibility}${viewer.domains.length > 1 ? ` · ${a.domain}` : ''}`,
        href: '/software',
        tone: visTone(a.visibility, 'authored'),
      })),
    });
  }

  // Big Bets — scoped by listBets (canView). Tone tracks lifecycle status.
  const betRows = [...bets].sort(byRecent);
  if (betRows.length > 0) {
    groups.push({
      key: 'big-bets',
      label: 'Big Bets',
      icon: '◆',
      tab: '/big-bets',
      count: betRows.length,
      items: betRows.slice(0, TOP_PER_GROUP).map((b) => ({
        id: b.id,
        name: b.name,
        meta: `${b.status}${viewer.domains.length > 1 ? ` · ${b.domain}` : ''}`,
        href: `/big-bets/${b.id}`,
        tone: b.status,
      })),
    });
  }

  // Strategy pillars — scoped by listPillars (tenant + viewer-domain only).
  const pillarRows = [...pillars].sort(byRecent);
  if (pillarRows.length > 0) {
    groups.push({
      key: 'strategy',
      label: 'Strategy pillars',
      icon: '▲',
      tab: '/strategy',
      count: pillarRows.length,
      items: pillarRows.slice(0, TOP_PER_GROUP).map((p) => ({
        id: p.id,
        name: p.name,
        meta: p.scope === 'tenant' ? 'Tenant-wide' : `Domain${p.domain ? ` · ${p.domain}` : ''}`,
        href: '/strategy',
        tone: p.scope === 'tenant' ? 'certified' : 'shared',
      })),
    });
  }

  return groups;
}
