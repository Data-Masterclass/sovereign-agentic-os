/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { KnowledgeError } from './schema.ts';
import type { Visibility } from './schema.ts';
import { roleAtLeast } from '../core/session.ts';
import type { Role } from '../core/session.ts';
import { osMirror } from '../infra/os-mirror.ts';
import { type ArtifactVersion, versionLog } from '../core/versioning.ts';

/**
 * PERSONAL general-knowledge store — the "My knowledge" layer of the Knowledge
 * tab. Where `DomainKnowledge` is the SHARED domain operating manual (four pinned
 * sections, one per domain), a personal knowledge entry is a free-form titled
 * markdown doc ABOUT THE USER — their role, how they work, personal notes — that
 * feeds their OWN agents / assistant context. Owner-only by default.
 *
 * Mirrors the workflow store: authoritative in-process Map, best-effort os-mirror
 * durability, per-artifact version history, `__resetStore` for tests. Kept simple
 * on purpose — a personal entry is just { title, md, visibility }.
 *
 * Visibility ladder is the same governed Personal → Shared → Marketplace, but a
 * personal entry starts (and usually stays) Personal. Promotion is a later,
 * governed concern; this store just persists the entry + its tier for grouping.
 */

export type Principal = { id: string; domains: string[]; role: Role };

export type PersonalKnowledgeRecord = {
  id: string;
  owner: string;
  domain: string;
  title: string;
  md: string;
  visibility: Visibility;
  updatedAt: string;
  archived?: boolean;
};

export type PersonalKnowledgeSummary = Omit<PersonalKnowledgeRecord, 'md'>;

function now(): string {
  return new Date().toISOString();
}

function uid(): string {
  return `pk_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

function fail(message: string, status: number): never {
  throw new KnowledgeError(message, status);
}

// --------------------------------------------------------- in-process state --
type State = { entries: Map<string, PersonalKnowledgeRecord>; seeded: boolean; hydration: Promise<void> | null };
const PK_KEY = Symbol.for('soa.knowledge.personal-store');
function st(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  if (!g[PK_KEY]) g[PK_KEY] = { entries: new Map(), seeded: false, hydration: null };
  return g[PK_KEY]!;
}

// ---------------------------------------------------- durable mirror ---------
const mirror = osMirror({
  index: 'os-personal-knowledge',
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        owner: { type: 'keyword' },
        domain: { type: 'keyword' },
        title: { type: 'keyword' },
        visibility: { type: 'keyword' },
        updatedAt: { type: 'date' },
        md: { type: 'text', index: false },
        archived: { type: 'boolean' },
      },
    },
  },
});

const versions = versionLog('personal-knowledge');

function writeThrough(rec: PersonalKnowledgeRecord): void {
  mirror.writeThrough(rec.id, rec);
}

export async function ensureHydrated(): Promise<void> {
  const s = st();
  if (!s.hydration) s.hydration = Promise.all([hydrate(), versions.ensureHydrated()]).then(() => {});
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = st();
  const docs = (await mirror.hydrate(2000)) ?? [];
  for (const rec of docs as PersonalKnowledgeRecord[]) {
    if (rec && rec.id && !s.entries.has(rec.id)) s.entries.set(rec.id, rec);
  }
  s.seeded = true;
}

function ensureSeeded(): void {
  if (st().seeded) return;
  st().seeded = true;
}

export function __resetStore(): void {
  const s = st();
  s.entries.clear();
  s.seeded = false;
  s.hydration = null;
  mirror.__reset();
  versions.__reset();
}

// --------------------------------------------------------------- scoping -----
function get(id: string): PersonalKnowledgeRecord {
  ensureSeeded();
  const rec = st().entries.get(id);
  if (!rec) fail('Knowledge entry not found', 404);
  return rec;
}

/** Personal entries are owner-private unless promoted; Shared → same domain; Marketplace → all. */
function canView(rec: PersonalKnowledgeRecord, user: Principal): boolean {
  if (rec.owner === user.id) return true;
  if (rec.visibility === 'Shared') return user.domains.includes(rec.domain);
  if (rec.visibility === 'Marketplace') return true;
  return false;
}

function canEdit(rec: PersonalKnowledgeRecord, user: Principal): boolean {
  if (rec.owner === user.id) return true;
  return roleAtLeast(user.role, 'builder') && user.domains.includes(rec.domain);
}

function requireView(id: string, user: Principal): PersonalKnowledgeRecord {
  const rec = get(id);
  if (!canView(rec, user)) fail('Not permitted to view this knowledge entry', 403);
  return rec;
}

function requireEdit(id: string, user: Principal): PersonalKnowledgeRecord {
  const rec = get(id);
  if (!canEdit(rec, user)) fail('Not permitted to edit this knowledge entry', 403);
  return rec;
}

// --------------------------------------------------------------------- CRUD --
export type PersonalKnowledgeGroups = {
  mine: PersonalKnowledgeSummary[];
  domain: PersonalKnowledgeSummary[];
  marketplace: PersonalKnowledgeSummary[];
};

function summarise(rec: PersonalKnowledgeRecord): PersonalKnowledgeSummary {
  const { md: _md, ...rest } = rec;
  void _md;
  return rest;
}

/** Grouped payload matching every other OS store: mine / domain / marketplace. */
export function listPersonalKnowledge(
  user: Principal,
  opts: { includeArchived?: boolean } = {},
): PersonalKnowledgeGroups {
  ensureSeeded();
  const mine: PersonalKnowledgeSummary[] = [];
  const domain: PersonalKnowledgeSummary[] = [];
  const marketplace: PersonalKnowledgeSummary[] = [];

  for (const rec of st().entries.values()) {
    if (rec.archived && !opts.includeArchived) continue;
    if (!canView(rec, user)) continue;
    if (rec.visibility === 'Marketplace') marketplace.push(summarise(rec));
    else if (rec.visibility === 'Shared') domain.push(summarise(rec));
    else mine.push(summarise(rec));
  }

  const byTitle = (a: PersonalKnowledgeSummary, b: PersonalKnowledgeSummary) => a.title.localeCompare(b.title);
  return { mine: mine.sort(byTitle), domain: domain.sort(byTitle), marketplace: marketplace.sort(byTitle) };
}

export function getPersonalKnowledge(id: string, user: Principal): PersonalKnowledgeRecord {
  return requireView(id, user);
}

export function createPersonalKnowledge(
  user: Principal,
  input: { title: string; md?: string; domain?: string },
): PersonalKnowledgeRecord {
  ensureSeeded();
  const domain = input.domain && user.domains.includes(input.domain) ? input.domain : user.domains[0] ?? 'default';
  const title = input.title.trim() || 'Untitled Note';
  const id = uid();
  const rec: PersonalKnowledgeRecord = {
    id,
    owner: user.id,
    domain,
    title,
    md: input.md ?? '',
    visibility: 'Personal',
    updatedAt: now(),
  };
  st().entries.set(id, rec);
  writeThrough(rec);
  return rec;
}

export type PersonalKnowledgePatch = { title?: string; md?: string };

export function updatePersonalKnowledge(
  id: string,
  user: Principal,
  patch: PersonalKnowledgePatch,
): PersonalKnowledgeRecord {
  const rec = requireEdit(id, user);
  const nextTitle = patch.title !== undefined ? patch.title.trim() || rec.title : rec.title;
  const nextMd = patch.md !== undefined ? patch.md : rec.md;
  if (nextTitle === rec.title && nextMd === rec.md) return rec; // no-op → no version churn
  versions.record(id, user.id, { title: rec.title, md: rec.md }, 'edit');
  rec.title = nextTitle;
  rec.md = nextMd;
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

export function deletePersonalKnowledge(id: string, user: Principal): void {
  requireEdit(id, user);
  mirror.deleteThrough(id);
  versions.purge(id);
  st().entries.delete(id);
}

export function archivePersonalKnowledge(id: string, user: Principal): PersonalKnowledgeRecord {
  const rec = requireEdit(id, user);
  rec.archived = true;
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

export function unarchivePersonalKnowledge(id: string, user: Principal): PersonalKnowledgeRecord {
  const rec = requireEdit(id, user);
  rec.archived = false;
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

export function listPersonalKnowledgeVersions(id: string, user: Principal): ArtifactVersion[] {
  requireView(id, user);
  return versions.list(id);
}

/**
 * Restore a prior version of a personal entry's {title, md}. Auditable +
 * reversible: the CURRENT state is snapshotted as a new version first, THEN the
 * chosen version is applied. Edit-scoped — mirrors `restoreWorkflowVersion`.
 */
export function restorePersonalKnowledgeVersion(id: string, user: Principal, version: number): PersonalKnowledgeRecord {
  const rec = requireEdit(id, user);
  const snap = versions.get(id, version);
  if (!snap) fail(`Version ${version} not found`, 404);
  const state = snap.state as { title?: string; md?: string };
  if (typeof state.md !== 'string') fail(`Version ${version} has no restorable source`, 422);
  // Snapshot the live state first so the restore can itself be undone.
  versions.record(id, user.id, { title: rec.title, md: rec.md }, `restore of v${version}`);
  rec.title = typeof state.title === 'string' && state.title.trim() ? state.title : rec.title;
  rec.md = state.md;
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

// ------------------------------------------------------ promotion ladder ------
// Personal knowledge rides the SAME governed Personal → Shared → Marketplace
// ladder as every other artifact: these two flips are the applier-half invoked
// by `lib/governance/effects.ts` after the seam enforces separation-of-duties
// (owner files request_promotion → Builder approves → Admin certifies). The role
// gate here is a defence-in-depth backstop; the seam is the primary gate.

/** Personal → Shared. Builder+ only (the effect seam already enforced SoD). */
export function promotePersonalKnowledge(id: string, user: Principal): PersonalKnowledgeRecord {
  if (!roleAtLeast(user.role, 'builder')) fail('Only builders and admins can promote knowledge', 403);
  const rec = requireEdit(id, user);
  if (rec.visibility !== 'Personal') fail('This knowledge is already promoted', 409);
  rec.visibility = 'Shared';
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

/** Shared → Marketplace. Admin only. */
export function certifyPersonalKnowledge(id: string, user: Principal): PersonalKnowledgeRecord {
  if (!roleAtLeast(user.role, 'admin')) fail('Only admins can certify knowledge to the marketplace', 403);
  const rec = requireEdit(id, user);
  if (rec.visibility === 'Marketplace') fail('This knowledge is already certified', 409);
  if (rec.visibility !== 'Shared') fail('Promote this knowledge to the domain before certifying', 409);
  rec.visibility = 'Marketplace';
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}
