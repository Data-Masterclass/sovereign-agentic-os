/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import {
  type Workflow,
  type WorkflowMeta,
  type DomainKnowledge,
  type Visibility,
  KnowledgeError,
  parseWorkflow,
  serializeWorkflow,
  emptyDomainKnowledge,
} from './schema.ts';
import { canPromote } from '../session.ts';
import type { Role } from '../session.ts';

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

type KnowledgeStoreState = { workflows: Map<string, WorkflowRecord>; domainKnowledge: Map<string, DomainKnowledge>; seeded: boolean };
const KS_KEY = Symbol.for('soa.knowledge.store');
function ks(): KnowledgeStoreState {
  const g = globalThis as unknown as Record<symbol, KnowledgeStoreState | undefined>;
  if (!g[KS_KEY]) g[KS_KEY] = { workflows: new Map(), domainKnowledge: new Map(), seeded: false };
  return g[KS_KEY]!;
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
  // Personal drafts are visible to builders/admins in the same domain.
  return (user.role === 'builder' || user.role === 'admin') && user.domains.includes(rec.domain);
}

function canEdit(rec: WorkflowRecord, user: Principal): boolean {
  if (rec.owner === user.id) return true;
  return (user.role === 'builder' || user.role === 'admin') && user.domains.includes(rec.domain);
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

export function listWorkflows(user: Principal): WorkflowGroups {
  ensureSeeded();
  const mine: WorkflowSummary[] = [];
  const domain: WorkflowSummary[] = [];
  const marketplace: WorkflowSummary[] = [];

  for (const rec of ks().workflows.values()) {
    if (rec.owner === user.id) {
      mine.push(summarise(rec));
    } else if (rec.visibility === 'Marketplace') {
      marketplace.push(summarise(rec));
    } else if (rec.visibility === 'Shared' && user.domains.includes(rec.domain)) {
      domain.push(summarise(rec));
    } else if (
      (user.role === 'builder' || user.role === 'admin') &&
      user.domains.includes(rec.domain) &&
      rec.visibility === 'Personal'
    ) {
      // Builders can see all drafts in their domain.
      domain.push(summarise(rec));
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
  return rec;
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

    // Parse to extract denormalised title + visibility/status.
    const w = parseWorkflow(patch.md);
    rec.md = patch.md;
    rec.title = w.title;
    rec.visibility = w.visibility;
    rec.status = w.status;
    rec.updatedAt = now();
  }

  return rec;
}

export function deleteWorkflow(id: string, user: Principal): void {
  const rec = requireEdit(id, user);
  if (rec.status === 'live') fail('Cannot delete a published workflow — unpublish it first', 400);
  ks().workflows.delete(id);
}

/**
 * Publish gate: Personal(draft) → Shared(live).
 * Only builders and admins may publish; participants (Creators) may not.
 * Reuses the session.canPromote gate.
 */
export function publishWorkflow(id: string, user: Principal): WorkflowRecord {
  if (!canPromote(user.role, 'Personal')) {
    fail('Only builders and admins can publish workflows', 403);
  }
  const rec = requireEdit(id, user);
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
  const rec = requireEdit(id, user);
  if (rec.status !== 'live') fail('Workflow must be published before marketplace certification', 400);
  if (rec.visibility === 'Marketplace') fail('Workflow is already in the marketplace', 400);

  const w = parseWorkflow(rec.md);
  w.visibility = 'Marketplace';
  rec.md = serializeWorkflow(w);
  rec.visibility = 'Marketplace';
  rec.certifiedAt = now();
  rec.certifiedBy = user.id;
  rec.updatedAt = now();

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

export function updateDomainKnowledge(
  domain: string,
  user: Principal,
  patch: DomainKnowledgePatch,
): DomainKnowledge {
  if (!user.domains.includes(domain)) fail('Not permitted to edit knowledge for this domain', 403);
  ensureSeeded();
  const dk = ks().domainKnowledge.get(domain) ?? emptyDomainKnowledge(domain);

  if (patch.sections) {
    for (const s of patch.sections) {
      const sec = dk.sections.find((x) => x.id === s.id);
      if (sec) sec.content = s.content;
    }
  }

  dk.updatedAt = now();
  ks().domainKnowledge.set(domain, dk);
  return dk;
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
  rec.tacit = tacit;
  rec.updatedAt = now();
  return rec;
}
