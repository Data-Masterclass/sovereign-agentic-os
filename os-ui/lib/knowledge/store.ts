/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import {
  type Workflow,
  type WorkflowMeta,
  type DomainKnowledge,
  type DomainSection,
  type Visibility,
  KnowledgeError,
  parseWorkflow,
  serializeWorkflow,
  emptyDomainKnowledge,
  reconcileSections,
} from './schema.ts';
import { canPromote, roleAtLeast } from '../core/session.ts';
import type { Role } from '../core/session.ts';
import { osMirror } from '../infra/os-mirror.ts';
import { type ArtifactVersion, versionLog } from '../core/versioning.ts';
import { canManageArtifact } from '../governance/edit-scope.ts';
import { type ManualScope, resolveManual } from './manual.ts';

export type { ArtifactVersion };
export type { ManualScope };

/**
 * Knowledge workflow store — the mock Forgejo repo behind the Knowledge tab
 * (kind-only, in-process; no STACKIT). Each workflow is a single canonical
 * `workflow.md` string. The store enforces the Creator(participant)/Builder role
 * gate: participants can create + edit drafts; builders (and admins) publish a
 * draft to live (Personal→Shared) and can further certify to Marketplace.
 *
 * Mirror of the agents/store.ts pattern: singleton Map, seeded, `__resetStore`
 * for tests, optimistic-concurrency sha.
 */

export type Principal = { id: string; domains: string[]; role: Role };

export type WorkflowRecord = {
  id: string;
  domain: string;
  owner: string;
  /** The single source of truth. */
  md: string;
  /**
   * The sibling `tacit.md` — the workflow-level tacit doc (locked decision: long
   * tacit notes live in a sibling file; short per-step notes stay inline in md).
   * Knowledge-agent-compressed markdown.
   */
  tacit: string;
  /** Denormalised from frontmatter for fast listing. */
  title: string;
  visibility: Visibility;
  status: 'draft' | 'live';
  updatedAt: string;
  publishedAt: string | null;
  publishedBy: string | null;
  /** Lighter knowledge-specific marketplace certification (decision #5). */
  certifiedAt: string | null;
  certifiedBy: string | null;
  /** Soft-archived: hidden from the working lists, reversible, retained. */
  archived?: boolean;
};

export type WorkflowSummary = Omit<WorkflowRecord, 'md' | 'tacit'>;

export type WorkflowView = WorkflowRecord & { workflow: Workflow; sha: string };

// ----------------------------------------------------------------- helpers ---

function now(): string {
  return new Date().toISOString();
}

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

/** Stable content sha for optimistic concurrency (mock Forgejo). */
export function sha(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) h = (Math.imul(31, h) + content.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

function fail(message: string, status: number): never {
  throw new KnowledgeError(message, status);
}

// --------------------------------------------------------------- seeding -----

function makeRecord(
  partial: Omit<WorkflowRecord, 'updatedAt' | 'publishedAt' | 'publishedBy' | 'tacit' | 'certifiedAt' | 'certifiedBy'> & Partial<WorkflowRecord>,
): WorkflowRecord {
  return {
    tacit: '',
    updatedAt: now(),
    publishedAt: null,
    publishedBy: null,
    certifiedAt: null,
    certifiedBy: null,
    ...partial,
  };
}

// --------------------------------------------------------- in-process state --

type KnowledgeStoreState = { workflows: Map<string, WorkflowRecord>; domainKnowledge: Map<string, DomainKnowledge>; seeded: boolean; hydration: Promise<void> | null };
const KS_KEY = Symbol.for('soa.knowledge.store');
function ks(): KnowledgeStoreState {
  const g = globalThis as unknown as Record<symbol, KnowledgeStoreState | undefined>;
  if (!g[KS_KEY]) g[KS_KEY] = { workflows: new Map(), domainKnowledge: new Map(), seeded: false, hydration: null };
  return g[KS_KEY]!;
}

// ---------------------------------------------------- durable mirror (best-effort) --
const mirror = osMirror({
  index: 'os-knowledge-records',
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        owner: { type: 'keyword' },
        domain: { type: 'keyword' },
        title: { type: 'keyword' },
        visibility: { type: 'keyword' },
        status: { type: 'keyword' },
        updatedAt: { type: 'date' },
        publishedAt: { type: 'date' },
        certifiedAt: { type: 'date' },
        md: { type: 'text', index: false },
        tacit: { type: 'text', index: false },
        archived: { type: 'boolean' },
      },
    },
  },
});

// Durable, per-artifact version history (reused across the OS). A workflow's
// canonical `md` + `tacit` is snapshotted on every meaningful edit + on restore.
const versions = versionLog('knowledge-workflow');

// The general DOMAIN-knowledge card (the pinned operating manual) rides the SAME
// version log primitive, keyed by domain, snapshotted on every meaningful edit.
const domainVersions = versionLog('domain-knowledge');

function writeThrough(rec: WorkflowRecord): void {
  mirror.writeThrough(rec.id, rec);
}

/** The versioned slice of a workflow record — the editable canonical source. */
function snapshotState(rec: WorkflowRecord): { md: string; tacit: string } {
  return { md: rec.md, tacit: rec.tacit };
}

export async function ensureHydrated(): Promise<void> {
  const s = ks();
  if (!s.hydration) s.hydration = Promise.all([hydrate(), versions.ensureHydrated(), domainVersions.ensureHydrated()]).then(() => {});
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = ks();
  const docs = (await mirror.hydrate(2000)) ?? [];
  for (const rec of docs as WorkflowRecord[]) {
    if (rec && rec.id && !s.workflows.has(rec.id)) s.workflows.set(rec.id, rec);
  }
  s.seeded = true;
}

/** A fresh tenant starts EMPTY. Workflows and domain knowledge are authored
 *  only through the platform's own governed flows (e.g. the Northpeak
 *  e-commerce seed), never baked in. */
function ensureSeeded(): void {
  if (ks().seeded) return;
  ks().seeded = true;
}

/** Test hook: wipe and reseed. */
export function __resetStore(): void {
  const s = ks();
  s.workflows.clear();
  s.domainKnowledge.clear();
  s.seeded = false;
  s.hydration = null;
  mirror.__reset();
  versions.__reset();
  domainVersions.__reset();
}

// --------------------------------------------------------------- scoping -----

function get(id: string): WorkflowRecord {
  ensureSeeded();
  const rec = ks().workflows.get(id);
  if (!rec) fail('Workflow not found', 404);
  return rec;
}

function canView(rec: WorkflowRecord, user: Principal): boolean {
  if (rec.owner === user.id) return true;
  if (rec.visibility === 'Shared') return user.domains.includes(rec.domain);
  if (rec.visibility === 'Marketplace') return true;
  // Personal drafts are visible to Builder+ in the same domain.
  return roleAtLeast(user.role, 'builder') && user.domains.includes(rec.domain);
}

function canEdit(rec: WorkflowRecord, user: Principal): boolean {
  // Fail-closed edit-scope: owner, domain_admin of the owning domain, or admin.
  // (Closes the gap where any in-domain Builder could mutate another's workflow.)
  return canManageArtifact(user, { owner: rec.owner, domain: rec.domain });
}

function requireView(id: string, user: Principal): WorkflowRecord {
  const rec = get(id);
  if (!canView(rec, user)) fail('Not permitted to view this workflow', 403);
  return rec;
}

function requireEdit(id: string, user: Principal): WorkflowRecord {
  const rec = get(id);
  if (!canEdit(rec, user)) fail('Not permitted to edit this workflow', 403);
  return rec;
}

// --------------------------------------------------------------------- CRUD --

export type WorkflowGroups = {
  mine: WorkflowSummary[];
  domain: WorkflowSummary[];
  marketplace: WorkflowSummary[];
};

function summarise(rec: WorkflowRecord): WorkflowSummary {
  const { md: _md, tacit: _tacit, ...rest } = rec;
  void _md;
  void _tacit;
  return rest;
}

export function listWorkflows(user: Principal, opts: { includeArchived?: boolean } = {}): WorkflowGroups {
  ensureSeeded();
  const mine: WorkflowSummary[] = [];
  const domain: WorkflowSummary[] = [];
  const marketplace: WorkflowSummary[] = [];

  for (const rec of ks().workflows.values()) {
    if (rec.archived && !opts.includeArchived) continue;
    if (!canView(rec, user)) continue;
    // Group by VISIBILITY, not ownership: Shared workflows are domain knowledge and
    // belong under Domain even when the caller authored them; Marketplace under
    // Marketplace; Personal (the caller's own drafts, plus same-domain drafts a
    // builder stewards — already gated by canView) under Personal.
    if (rec.visibility === 'Marketplace') {
      marketplace.push(summarise(rec));
    } else if (rec.visibility === 'Shared') {
      domain.push(summarise(rec));
    } else {
      mine.push(summarise(rec));
    }
  }

  const byTitle = (a: WorkflowSummary, b: WorkflowSummary) => a.title.localeCompare(b.title);
  return {
    mine: mine.sort(byTitle),
    domain: domain.sort(byTitle),
    marketplace: marketplace.sort(byTitle),
  };
}

export function getWorkflow(id: string, user: Principal): WorkflowView {
  const rec = requireView(id, user);
  return { ...rec, workflow: parseWorkflow(rec.md), sha: sha(rec.md) };
}

export function createWorkflow(
  user: Principal,
  input: { title: string; domain?: string },
): WorkflowRecord {
  ensureSeeded();
  const domain =
    input.domain && user.domains.includes(input.domain) ? input.domain : user.domains[0] ?? 'default';

  const title = input.title.trim() || 'Untitled Workflow';
  const id = uid('wf');
  const workflow: Workflow = {
    id,
    title,
    domain,
    visibility: 'Personal',
    status: 'draft',
    version: '1',
    rules: [],
    actors: [],
    steps: [],
    body: '',
  };

  const rec = makeRecord({
    id,
    domain,
    owner: user.id,
    md: serializeWorkflow(workflow),
    title,
    visibility: 'Personal',
    status: 'draft',
  });
  ks().workflows.set(id, rec);
  writeThrough(rec);
  return rec;
}

/**
 * Governed offboard support: transfer this owner's PERSONAL-lane records to a new
 * owner (used by lib/platform-admin/offboard.ts when a user is offboarded with
 * reassignment). Only personal, owner-only artifacts move; shared/domain/certified
 * are untouched. Returns the count moved. Only the workflows map is touched —
 * domain knowledge is domain-scoped, not personal.
 */
export function reassignOwner(fromId: string, toId: string): number {
  let moved = 0;
  for (const rec of ks().workflows.values()) {
    if (rec.owner !== fromId) continue;
    if (rec.visibility !== 'Personal') continue; // personal lane only
    rec.owner = toId;
    rec.updatedAt = now();
    writeThrough(rec);
    moved++;
  }
  return moved;
}

export type WorkflowPatch = {
  md?: string;
  sha?: string;
};

export function updateWorkflow(
  id: string,
  user: Principal,
  patch: WorkflowPatch,
): WorkflowRecord {
  const rec = requireEdit(id, user);

  if (patch.md !== undefined) {
    // Validate the incoming markdown parses correctly.
    parseWorkflow(patch.md); // throws KnowledgeError on bad shape

    // Optimistic concurrency: the caller must pass the sha of what they last read.
    if (patch.sha && patch.sha !== sha(rec.md)) {
      fail('The workflow changed since you opened it (stale sha) — reload and re-apply', 409);
    }

    if (patch.md === rec.md) return rec; // no-op edit → no version churn

    // Snapshot the PRIOR canonical source before overwriting it.
    versions.record(id, user.id, snapshotState(rec), 'edit md');

    // Parse to extract denormalised title + visibility/status.
    const w = parseWorkflow(patch.md);
    rec.md = patch.md;
    rec.title = w.title;
    rec.visibility = w.visibility;
    rec.status = w.status;
    rec.updatedAt = now();
    writeThrough(rec);
  }

  return rec;
}

export function deleteWorkflow(id: string, user: Principal): void {
  const rec = requireEdit(id, user);
  // OS-wide lifecycle: Delete is reachable only after Archive (the UI exposes
  // Delete solely on an archived artifact). A live workflow is still shared with
  // the domain, so it may NOT be deleted directly — archive it first. But once
  // archived it is out of every working list and safe to permanently remove,
  // regardless of its prior published/live tier. Blocking live-AND-archived was
  // the bug that made every published workflow undeletable (it could be archived
  // but never removed, so the tile persisted forever).
  if (rec.status === 'live' && !rec.archived) {
    fail('Archive this published workflow before deleting it', 400);
  }
  mirror.deleteThrough(id);
  versions.purge(id);
  ks().workflows.delete(id);
}

/**
 * Publish gate: Personal(draft) → Shared(live).
 * Only builders and admins may publish; participants (Creators) may not.
 * Reuses the session.canPromote gate.
 */
export function publishWorkflow(id: string, user: Principal): WorkflowRecord {
  if (!canPromote(user.role, 'Personal')) {
    fail('Only domain admins and admins can publish workflows', 403);
  }
  // The APPROVER authority is `canPromote` (above) — an approver need not be the
  // artifact owner, so gate on VIEW here, not edit (which is owner/domain_admin-only).
  const rec = requireView(id, user);
  if (rec.status === 'live') fail('Workflow is already published', 400);

  // Patch the frontmatter in the md to reflect the new state.
  const w = parseWorkflow(rec.md);
  w.visibility = 'Shared';
  w.status = 'live';
  rec.md = serializeWorkflow(w);
  rec.visibility = 'Shared';
  rec.status = 'live';
  rec.publishedAt = now();
  rec.publishedBy = user.id;
  rec.updatedAt = now();
  writeThrough(rec);

  return rec;
}

/**
 * Certify to Marketplace: Shared(live) → Marketplace(live).
 * Only admins may certify; reuses the canPromote('Shared') gate.
 */
export function certifyWorkflow(id: string, user: Principal): WorkflowRecord {
  if (!canPromote(user.role, 'Shared')) {
    fail('Only admins can certify workflows to the marketplace', 403);
  }
  // Approver authority is the canPromote gate above — not artifact ownership.
  const rec = requireView(id, user);
  if (rec.status !== 'live') fail('Workflow must be published before marketplace certification', 400);
  if (rec.visibility === 'Marketplace') fail('Workflow is already in the marketplace', 400);

  const w = parseWorkflow(rec.md);
  w.visibility = 'Marketplace';
  rec.md = serializeWorkflow(w);
  rec.visibility = 'Marketplace';
  rec.certifiedAt = now();
  rec.certifiedBy = user.id;
  rec.updatedAt = now();
  writeThrough(rec);

  return rec;
}

// --------------------------------------------- domain knowledge CRUD ---------

export function getDomainKnowledge(domain: string): DomainKnowledge {
  ensureSeeded();
  return ks().domainKnowledge.get(domain) ?? emptyDomainKnowledge(domain);
}

export type DomainKnowledgePatch = {
  sections?: { id: string; content: string }[];
};

/** The versioned slice of a domain-knowledge card — its guided sections. */
function snapshotDomain(dk: DomainKnowledge): { sections: DomainSection[] } {
  return { sections: dk.sections.map((s) => ({ ...s })) };
}

export function updateDomainKnowledge(
  domain: string,
  user: Principal,
  patch: DomainKnowledgePatch,
): DomainKnowledge {
  if (!user.domains.includes(domain)) fail('Not permitted to edit knowledge for this domain', 403);
  ensureSeeded();
  const dk = ks().domainKnowledge.get(domain) ?? emptyDomainKnowledge(domain);

  if (patch.sections) {
    // Snapshot the PRIOR card before overwriting it, but only if this edit
    // actually changes something (no version churn on a no-op save).
    const changes = patch.sections.some((s) => {
      const sec = dk.sections.find((x) => x.id === s.id);
      return sec !== undefined && sec.content !== s.content;
    });
    if (changes) {
      domainVersions.record(domain, user.id, snapshotDomain(dk), 'edit domain knowledge');
      for (const s of patch.sections) {
        const sec = dk.sections.find((x) => x.id === s.id);
        if (sec) sec.content = s.content;
      }
      dk.updatedAt = now();
    }
  }

  ks().domainKnowledge.set(domain, dk);
  return dk;
}

/** Version history for a domain-knowledge card, newest first (view-scoped, in-domain). */
export function listDomainKnowledgeVersions(domain: string, user: Principal): ArtifactVersion[] {
  if (!user.domains.includes(domain)) fail('Not permitted to view knowledge for this domain', 403);
  ensureSeeded();
  return domainVersions.list(domain);
}

/**
 * Restore a prior version of a domain-knowledge card's sections. Auditable +
 * reversible: the CURRENT card is snapshotted as a new version first, THEN the
 * chosen version is applied. Edit-scoped (in-domain) — mirrors
 * `restoreWorkflowVersion` / `restorePersonalKnowledgeVersion`.
 */
export function restoreDomainKnowledgeVersion(
  domain: string,
  user: Principal,
  version: number,
): DomainKnowledge {
  if (!user.domains.includes(domain)) fail('Not permitted to edit knowledge for this domain', 403);
  ensureSeeded();
  const snap = domainVersions.get(domain, version);
  if (!snap) fail(`Version ${version} not found`, 404);
  const state = snap.state as { sections?: DomainSection[] };
  const restored = state.sections;
  // Reject a corrupt snapshot rather than go live with it.
  if (!Array.isArray(restored) || restored.some((s) => typeof s?.content !== 'string')) {
    fail(`Version ${version} has no restorable source`, 422);
  }
  const dk = ks().domainKnowledge.get(domain) ?? emptyDomainKnowledge(domain);
  // Snapshot the live card first so the restore can itself be undone.
  domainVersions.record(domain, user.id, snapshotDomain(dk), `restore of v${version}`);
  // Apply restored content onto the current section template (keeps ids/titles stable).
  for (const sec of dk.sections) {
    const from = restored.find((s) => s.id === sec.id);
    if (from) sec.content = from.content;
  }
  dk.updatedAt = now();
  ks().domainKnowledge.set(domain, dk);
  return dk;
}

// ------------------------------------ Operating Model (My/Domain/Company) ----
// The Operating Model tab renders the SAME guided-sections card at three scopes,
// each backed by a `DomainKnowledge` record keyed by a reserved storage key
// (`user:<id>`, the real domain, or `tenant`). These wrappers resolve the key +
// per-scope gating (see lib/knowledge/manual.ts) then reuse the exact domain-card
// primitives above, so version history + restore work identically for all three.
// Governance is enforced HERE (server-side), never trusted from the client.

function fail403(): never {
  fail('Not permitted', 403);
}

export function getManual(scope: ManualScope, user: Principal, domain?: string): DomainKnowledge {
  const r = resolveManual(scope, user, domain);
  if (!r.canView) fail403();
  ensureSeeded();
  const raw = ks().domainKnowledge.get(r.key) ?? emptyDomainKnowledge(r.key);
  // Migrate old 4-section cards (overview/goals/context/glossary) to the canonical
  // 7-section shape (general/strategy/business/organization/architecture/data/glossary)
  // on every read — no data loss, version history preserved, no schema migration needed.
  return reconcileSections(raw);
}

export function updateManual(
  scope: ManualScope,
  user: Principal,
  patch: DomainKnowledgePatch,
  domain?: string,
): DomainKnowledge {
  const r = resolveManual(scope, user, domain);
  if (!r.canEdit) fail403();
  ensureSeeded();
  const dk = ks().domainKnowledge.get(r.key) ?? emptyDomainKnowledge(r.key);
  if (patch.sections) {
    const changes = patch.sections.some((s) => {
      const sec = dk.sections.find((x) => x.id === s.id);
      return sec !== undefined && sec.content !== s.content;
    });
    if (changes) {
      domainVersions.record(r.key, user.id, snapshotDomain(dk), `edit ${scope} operating manual`);
      for (const s of patch.sections) {
        const sec = dk.sections.find((x) => x.id === s.id);
        if (sec) sec.content = s.content;
      }
      dk.updatedAt = now();
    }
  }
  ks().domainKnowledge.set(r.key, dk);
  // Always return the reconciled (new 7-section) shape to the caller.
  return reconcileSections(dk);
}

export function listManualVersions(
  scope: ManualScope,
  user: Principal,
  domain?: string,
): ArtifactVersion[] {
  const r = resolveManual(scope, user, domain);
  if (!r.canView) fail403();
  ensureSeeded();
  return domainVersions.list(r.key);
}

export function restoreManualVersion(
  scope: ManualScope,
  user: Principal,
  version: number,
  domain?: string,
): DomainKnowledge {
  const r = resolveManual(scope, user, domain);
  if (!r.canEdit) fail403();
  ensureSeeded();
  const snap = domainVersions.get(r.key, version);
  if (!snap) fail(`Version ${version} not found`, 404);
  const state = snap.state as { sections?: DomainSection[] };
  const restored = state.sections;
  if (!Array.isArray(restored) || restored.some((s) => typeof s?.content !== 'string')) {
    fail(`Version ${version} has no restorable source`, 422);
  }
  const dk = ks().domainKnowledge.get(r.key) ?? emptyDomainKnowledge(r.key);
  domainVersions.record(r.key, user.id, snapshotDomain(dk), `restore of v${version}`);
  // Restore onto the reconciled template — handles both old and new section ids.
  const reconciled = reconcileSections(dk);
  for (const sec of reconciled.sections) {
    const from = restored.find((s) => s.id === sec.id);
    if (from) sec.content = from.content;
    else {
      // Try migration mapping for old-shaped snapshots (overview→general etc.)
      const legacyId = Object.entries({ overview: 'general', goals: 'strategy', context: 'business', glossary: 'glossary' })
        .find(([, newId]) => newId === sec.id)?.[0];
      if (legacyId) {
        const legacySec = restored.find((s) => s.id === legacyId);
        if (legacySec) sec.content = legacySec.content;
      }
    }
  }
  reconciled.updatedAt = now();
  ks().domainKnowledge.set(r.key, reconciled);
  return reconciled;
}

// ----------------------------------------------- tacit (sibling tacit.md) ----

/** Read the workflow's sibling tacit.md (the workflow-level tacit doc). */
export function getTacit(id: string, user: Principal): { tacit: string } {
  const rec = requireView(id, user);
  return { tacit: rec.tacit };
}

/** Replace the workflow's sibling tacit.md (knowledge-agent-compressed markdown). */
export function updateTacit(id: string, user: Principal, tacit: string): WorkflowRecord {
  const rec = requireEdit(id, user);
  if (tacit === rec.tacit) return rec; // no-op edit → no version churn
  versions.record(id, user.id, snapshotState(rec), 'edit tacit');
  rec.tacit = tacit;
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

// ------------------------------------------ archive / delete / versions -------

/**
 * Archive a workflow: reversible soft-hide. Edit-scoped — only the owner or a
 * same-domain Builder+ may archive. The record + its history are retained;
 * the workflow leaves the working lists until unarchived.
 */
export function archiveWorkflow(id: string, user: Principal): WorkflowRecord {
  const rec = requireEdit(id, user);
  rec.archived = true;
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

/** Restore an archived workflow back into the working lists (edit-scoped). */
export function unarchiveWorkflow(id: string, user: Principal): WorkflowRecord {
  const rec = requireEdit(id, user);
  rec.archived = false;
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

/** Version history for a workflow, newest first (view-scoped). */
export function listWorkflowVersions(id: string, user: Principal): ArtifactVersion[] {
  requireView(id, user);
  return versions.list(id);
}

/**
 * Restore a prior version of a workflow's canonical source. Auditable + reversible:
 * the CURRENT state is snapshotted as a new version first, THEN the chosen version
 * is applied. Edit-scoped. The restored md is re-validated before going live.
 */
export function restoreWorkflowVersion(id: string, user: Principal, version: number): WorkflowRecord {
  const rec = requireEdit(id, user);
  const snap = versions.get(id, version);
  if (!snap) fail(`Version ${version} not found`, 404);
  const state = snap.state as { md?: string; tacit?: string };
  const restored = state.md;
  if (typeof restored !== 'string') fail(`Version ${version} has no restorable source`, 422);
  parseWorkflow(restored); // reject a corrupt snapshot rather than go live with it
  // Snapshot the live state first so the restore can itself be undone.
  versions.record(id, user.id, snapshotState(rec), `restore of v${version}`);
  rec.md = restored;
  if (typeof state.tacit === 'string') rec.tacit = state.tacit;
  // Re-derive denormalised fields from the restored source.
  const w = parseWorkflow(restored);
  rec.title = w.title;
  rec.visibility = w.visibility;
  rec.status = w.status;
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}
