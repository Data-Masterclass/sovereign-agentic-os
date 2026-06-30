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

const BANK_SUBMISSION_MD = `---
id: bank-submission
title: Bank Submission
domain: sales
visibility: Personal
status: draft
version: "1"
rules:
  - id: r1
    text: Quality over customer convenience
    hard: false
    scope: workflow
  - id: r2
    text: Error rate must be below 0.1%
    hard: true
    scope: step
    step_id: verify-submission
---

\`\`\`step
id: prepare-documents
title: Prepare Documents
actor: Human
actor_name: Loan Officer
inputs:
  - Customer application form
  - Identity documents
outputs:
  - Document package
links:
  - type: data
    ref: sales.gold.customer_applications
    label: Customer Applications
rules:
  - id: sr1
    text: All required fields must be completed before proceeding
    hard: false
\`\`\`

> tacit: Loan officers often miss the income verification date in section 4. Always double-check before assembly.

\`\`\`step
id: submit-to-bank
title: Submit to Bank Portal
actor: Software
actor_name: BankPortal
links:
  - type: app
    ref: app://bank-portal
    label: Bank Portal
rules:
  - id: sr2
    text: Submission must include the signed checklist
    hard: false
\`\`\`

\`\`\`step
id: verify-submission
title: Verify Submission
actor: Agent
actor_name: Verification Agent
outputs:
  - Submission receipt
links:
  - type: agent
    ref: sys_verify_agent
    label: Verification Agent
rules:
  - id: sr3
    text: Error rate must be below 0.1%
    hard: true
\`\`\`
`;

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

const workflows = new Map<string, WorkflowRecord>();
const domainKnowledge = new Map<string, DomainKnowledge>();
let seeded = false;

function ensureSeeded(): void {
  if (seeded) return;
  seeded = true;

  // Seed: "Bank submission" draft (sales, owned by amir — a participant)
  const bankId = 'wf_bank-submission';
  const bankW = makeRecord({
    id: bankId,
    domain: 'sales',
    owner: 'amir',
    md: BANK_SUBMISSION_MD,
    tacit:
      '# Tacit knowledge — Bank Submission\n\n' +
      '## What the manuals don\'t say\n' +
      '- The bank\'s portal silently truncates notes over 500 characters — keep the cover note short.\n' +
      '- Friday submissions after 14:00 CET land in the next-week batch; aim for Thursday.\n' +
      '- A rejected package almost always traces back to a missing income-verification date (section 4).\n\n' +
      '## Relationship notes\n' +
      '- Our contact at the bank prefers a heads-up email before any package over €2M.\n',
    title: 'Bank Submission',
    visibility: 'Personal',
    status: 'draft',
  });
  workflows.set(bankId, bankW);

  // Seed: a published shared workflow (published by bea — a builder)
  const onboardId = 'wf_customer-onboarding';
  const onboardMd = BANK_SUBMISSION_MD
    .replace('id: bank-submission', 'id: customer-onboarding')
    .replace('title: Bank Submission', 'title: Customer Onboarding')
    .replace('visibility: Personal', 'visibility: Shared')
    .replace('status: draft', 'status: live');
  const onboardW = makeRecord({
    id: onboardId,
    domain: 'sales',
    owner: 'bea',
    md: onboardMd,
    title: 'Customer Onboarding',
    visibility: 'Shared',
    status: 'live',
    publishedAt: now(),
    publishedBy: 'bea',
  });
  workflows.set(onboardId, onboardW);

  // Seed domain knowledge for 'sales'
  const dk = emptyDomainKnowledge('sales');
  dk.sections[0].content =
    'The Sales domain manages customer acquisition, contract management, and account renewal. All agreements are subject to the standard pricing and discount policy.';
  dk.sections[1].content =
    '**Data Product:** A certified, shared dataset in the marketplace.\n**Builder:** A user who can publish workflows and promote data assets.\n**Tacit Knowledge:** Unwritten domain expertise captured from practitioners.';
  dk.sections[2].content =
    '- Grow annual recurring revenue by 15% YoY\n- Reduce submission error rate to below 0.1%\n- Achieve 48h SLA on bank submissions';
  dk.sections[3].content =
    'Sales operates in 12 markets across Europe. The main banking partner is Deutsche Bank AG. Submission windows close every Friday at 16:00 CET.';
  domainKnowledge.set('sales', dk);
}

/** Test hook: wipe and reseed. */
export function __resetStore(): void {
  workflows.clear();
  domainKnowledge.clear();
  seeded = false;
}

// --------------------------------------------------------------- scoping -----

function get(id: string): WorkflowRecord {
  ensureSeeded();
  const rec = workflows.get(id);
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

  for (const rec of workflows.values()) {
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
  workflows.set(id, rec);
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
  workflows.delete(id);
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
  return domainKnowledge.get(domain) ?? emptyDomainKnowledge(domain);
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
  const dk = domainKnowledge.get(domain) ?? emptyDomainKnowledge(domain);

  if (patch.sections) {
    for (const s of patch.sections) {
      const sec = dk.sections.find((x) => x.id === s.id);
      if (sec) sec.content = s.content;
    }
  }

  dk.updatedAt = now();
  domainKnowledge.set(domain, dk);
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
