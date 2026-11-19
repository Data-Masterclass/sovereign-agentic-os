/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { KnowledgeError } from '@tabs/knowledge/lib/schema';
import type { Visibility } from '@tabs/knowledge/lib/schema';
import { roleAtLeast } from '@core/kernel/session';
import type { Role } from '@core/kernel/session';
import { osMirror } from '@core/infra/os-mirror';
import { newSeenFields, noteSeen, writeDeleted, writeChanged, writeNew, type SeenFields } from '@core/infra/field-writes';
import { type ArtifactVersion, versionLog } from '@core/kernel/versioning';
import { canManageArtifact, type ArtifactScope } from '@core/policy/edit-scope';
import { normaliseFolderPath } from '@core/kernel/folders';
import { createFolder, type FolderScope, type Principal as FolderPrincipal } from '@core/folders/index';

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
  folder: string;
  updatedAt: string;
  archived?: boolean;
  /**
   * What produced this entry, when a program did (an agent run saving a declared output:
   * `agent-output:<system>:<run>:<output>`). It makes that save REPEATABLE: asking again with
   * the same key returns this entry instead of writing a second one. Absent on entries a person
   * wrote. Never an access rule.
   */
  sourceKey?: string;
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
type State = { entries: Map<string, PersonalKnowledgeRecord>; seeded: boolean; hydration: Promise<void> | null
  /** What this process last knew the mirror held per note (see `core/infra/field-writes.ts`). */
  seen: SeenFields;
};
const PK_KEY = Symbol.for('soa.knowledge.personal-store');
function st(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  if (!g[PK_KEY]) g[PK_KEY] = { entries: new Map(), seeded: false, hydration: null, seen: newSeenFields() };
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
        folder: { type: 'keyword' },
        updatedAt: { type: 'date' },
        md: { type: 'text', index: false },
        archived: { type: 'boolean' },
        sourceKey: { type: 'keyword' },
      },
    },
  },
});

const versions = versionLog('personal-knowledge');

/** The ONE write path for an existing note: only the fields this process changed reach the mirror,
 *  and the run worker never re-creates a note deleted elsewhere (`core/infra/field-writes.ts`). */
function writeThrough(rec: PersonalKnowledgeRecord): void {
  writeChanged(mirror, st().seen, rec.id, rec as unknown as Record<string, unknown>);
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
    if (rec && rec.id && !s.entries.has(rec.id)) {
      s.entries.set(rec.id, rec);
      noteSeen(s.seen, rec.id, rec as unknown as Record<string, unknown>);
    }
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
  s.seen.clear();
  s.seeded = false;
  s.hydration = null;
  mirror.__reset();
  versions.__reset();
}

/**
 * Cross-domain governance move (admin-only, gated in lib/platform-admin/domain-move.ts).
 * Scoping reads the record's `domain` field, so we set it and write through.
 * `sel.id` moves one; `sel.onlyUnassigned` sweeps only empty-domain records.
 * Returns the ids moved.
 */
export function movePersonalKnowledgeDomain(sel: { id?: string; onlyUnassigned?: boolean }, target: string): string[] {
  const moved: string[] = [];
  for (const rec of st().entries.values()) {
    if (sel.id !== undefined && rec.id !== sel.id) continue;
    if (sel.onlyUnassigned && rec.domain) continue;
    if (rec.domain === target) continue;
    rec.domain = target;
    writeThrough(rec);
    moved.push(rec.id);
  }
  return moved;
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
  // Fail-closed edit-scope: owner always; a Personal entry is owner-only (no admin/
  // domain_admin reaches another user's private know-how). Shared / Marketplace
  // admits an in-domain domain_admin or a platform admin. (Closes the gap where any
  // in-domain Builder could mutate/unshare another's entry.)
  const scope: ArtifactScope = rec.visibility === 'Personal' ? 'personal' : rec.visibility === 'Marketplace' ? 'certified' : 'shared';
  return canManageArtifact(user, { owner: rec.owner, domain: rec.domain, scope });
}

function requireView(id: string, user: Principal): PersonalKnowledgeRecord {
  const rec = get(id);
  if (!canView(rec, user)) fail('Not permitted to view this knowledge entry', 403);
  return rec;
}

/**
 * Read an entry for a GOVERNANCE act on the AUDIENCE ladder — the view gate UNIONED with the
 * ladder's appointed approvers for the entry's domain (an in-domain `domain_admin`, or a
 * platform `admin`). The exact twin of `getDashboardForGovernance`, for the same reason.
 *
 * `canView` keeps a Personal entry owner-only — deliberately, since private know-how is nobody
 * else's business, and unlike a workflow draft not even an in-domain Builder may read it. But
 * `promotePersonalKnowledge` read through that gate, so the domain admin who must approve a
 * filed `artifact_promote` could not see the record: every personal-knowledge promotion was
 * fileable and then permanently unapprovable ("Not permitted to view this knowledge entry"),
 * and the owner could not decide it either (four-eyes, for the rung-1 carve-out's own reasons —
 * the owner here is a creator). The entry could not leave My at all.
 *
 * THE OWNER'S FILED REQUEST IS THE CONSENT. A Personal entry only reaches this function because
 * its owner asked for it to be shared (`fileArtifactPromotion` is owner-only, and the one-shot
 * admits a non-owner only as the approve-half of a request that already exists). Never narrower
 * than `canView`; the list and read surfaces are untouched.
 */
export function getPersonalKnowledgeForGovernance(id: string, user: Principal): PersonalKnowledgeRecord {
  const rec = get(id);
  if (canView(rec, user)) return rec;
  const isLadderApprover = user.role === 'admin' || (user.role === 'domain_admin' && user.domains.includes(rec.domain));
  if (isLadderApprover) return rec;
  fail('Not permitted to view this knowledge entry', 403);
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

/** Grouped payload matching every other OS store: mine / domain / marketplace.
 *
 *  `activeDomain` mirrors the OS-wide domain switcher: when non-null EVERY tier is
 *  restricted to entries stamped with that domain (STRICT DOMAIN ISOLATION —
 *  consistent with how `listFolders` and the artifact lists behave on a scoped
 *  domain). "My", "Domain" (Shared) AND "Company" (Marketplace/Certified) all narrow:
 *  a certified entry homed in domain A must not show while acting in domain B — cross-
 *  domain discovery is the dedicated Marketplace's job, not this list's. A domainless
 *  entry always shows. null / undefined = "All domains" — shows every owned / visible
 *  entry. */
export function listPersonalKnowledge(
  user: Principal,
  opts: { includeArchived?: boolean; activeDomain?: string | null } = {},
): PersonalKnowledgeGroups {
  ensureSeeded();
  const activeDomain = opts.activeDomain ?? null;
  const mine: PersonalKnowledgeSummary[] = [];
  const domain: PersonalKnowledgeSummary[] = [];
  const marketplace: PersonalKnowledgeSummary[] = [];

  for (const rec of st().entries.values()) {
    if (rec.archived && !opts.includeArchived) continue;
    if (!canView(rec, user)) continue;
    // Strict active-domain isolation for EVERY tier: hide anything homed in another
    // domain (a domainless entry always shows so the admin can domain-move it).
    if (activeDomain !== null && rec.domain && rec.domain !== activeDomain) continue;
    if (rec.visibility === 'Marketplace') {
      marketplace.push(summarise(rec));
    } else if (rec.visibility === 'Shared') {
      domain.push(summarise(rec));
    } else {
      mine.push(summarise(rec));
    }
  }

  const byTitle = (a: PersonalKnowledgeSummary, b: PersonalKnowledgeSummary) => a.title.localeCompare(b.title);
  return { mine: mine.sort(byTitle), domain: domain.sort(byTitle), marketplace: marketplace.sort(byTitle) };
}

export function getPersonalKnowledge(id: string, user: Principal): PersonalKnowledgeRecord {
  return requireView(id, user);
}

export function createPersonalKnowledge(
  user: Principal,
  input: { title: string; md?: string; domain?: string; folder?: string; sourceKey?: string },
): PersonalKnowledgeRecord {
  ensureSeeded();
  const sourceKey = input.sourceKey?.trim() || undefined;
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
    folder: normaliseFolderPath(input.folder),
    updatedAt: now(),
    ...(sourceKey ? { sourceKey } : {}),
  };
  st().entries.set(id, rec);
  writeNew(mirror, st().seen, id, rec as unknown as Record<string, unknown>);
  return rec;
}

/**
 * The entry THIS OWNER already saved under `sourceKey`, or null. Owner-scoped on purpose: a key
 * is only ever matched against the caller's own entries, so it cannot be used to find out
 * whether somebody else saved something. An archived entry still counts (it was saved).
 */
export function findPersonalKnowledgeBySourceKey(user: Principal, sourceKey: string): PersonalKnowledgeRecord | null {
  ensureSeeded();
  const key = sourceKey.trim();
  if (!key) return null;
  for (const rec of st().entries.values()) {
    if (rec.owner === user.id && rec.sourceKey === key) return rec;
  }
  return null;
}

/** Move a personal knowledge entry into a folder. Edit-scoped — owner, in-domain domain_admin, or admin. */
export function moveKnowledge(id: string, user: Principal, folder: string): PersonalKnowledgeRecord {
  const rec = requireEdit(id, user);
  const normalised = normaliseFolderPath(folder);
  versions.record(id, user.id, { title: rec.title, md: rec.md, folder: rec.folder }, 'move');
  rec.folder = normalised;
  rec.updatedAt = now();
  writeThrough(rec);
  // Upsert an explicit folder row — best-effort, swallow errors so a move is never rolled back.
  if (normalised !== '/') {
    const scope: FolderScope = rec.visibility === 'Personal' ? 'personal' : 'domain';
    const principal: FolderPrincipal = { id: user.id, role: user.role, domains: user.domains };
    try {
      createFolder(principal, { tab: 'knowledge', scope, path: normalised, domain: rec.domain });
    } catch {
      /* folder-registry mirror is best-effort */
    }
  }
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
  writeDeleted(mirror, st().seen, id);
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

/** Personal → Shared. Domain admin+ only (the effect seam already enforced SoD). */
export function promotePersonalKnowledge(id: string, user: Principal): PersonalKnowledgeRecord {
  if (!roleAtLeast(user.role, 'domain_admin')) fail('Only domain admins and admins can promote knowledge', 403);
  // Approver authority is the role gate above — approvers need not own the entry, and a Personal
  // entry is owner-only to VIEW, so the governance read is what makes a filed request appliable.
  const rec = getPersonalKnowledgeForGovernance(id, user);
  if (rec.visibility !== 'Personal') fail('This knowledge is already promoted', 409);
  rec.visibility = 'Shared';
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

/** Shared → Marketplace. Admin only. */
export function certifyPersonalKnowledge(id: string, user: Principal): PersonalKnowledgeRecord {
  if (!roleAtLeast(user.role, 'admin')) fail('Only admins can certify knowledge to the marketplace', 403);
  const rec = getPersonalKnowledgeForGovernance(id, user);
  if (rec.visibility === 'Marketplace') fail('This knowledge is already certified', 409);
  if (rec.visibility !== 'Shared') fail('Promote this knowledge to the domain before certifying', 409);
  rec.visibility = 'Marketplace';
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

/** Marketplace → Shared. Admin only (only an admin certified it). */
export function decertifyPersonalKnowledge(id: string, user: Principal): PersonalKnowledgeRecord {
  if (!roleAtLeast(user.role, 'admin')) fail('Only admins can revoke knowledge from the marketplace', 403);
  const rec = requireView(id, user);
  if (rec.visibility !== 'Marketplace') fail('This knowledge is not certified', 409);
  rec.visibility = 'Shared';
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

/** Shared → Personal. Owner or in-domain builder/admin (mirrors who could promote). */
export function unsharePersonalKnowledge(id: string, user: Principal): PersonalKnowledgeRecord {
  const rec = requireEdit(id, user); // owner OR in-domain builder/admin
  if (rec.visibility !== 'Shared') {
    fail(rec.visibility === 'Marketplace' ? 'Revoke from the marketplace before unsharing' : 'This knowledge is already personal', 409);
  }
  rec.visibility = 'Personal';
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}
