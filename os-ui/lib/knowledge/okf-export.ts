/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { parseWorkflow } from './schema.ts';
import type { WorkflowRecord } from './store.ts';
import type { PersonalKnowledgeRecord } from './personal-store.ts';
import type { DomainKnowledge } from './schema.ts';
import {
  type OkfBundle,
  type OkfDoc,
  type OkfEvent,
  OKF_VERSION,
  RESOURCE_PREFIX,
  workflowToOkfDoc,
  serializeOkfDoc,
  renderIndexMd,
  tierToStatus,
} from './okf-model.ts';
import { validateBundle } from './okf-validate.ts';

/**
 * OKF EXPORT (server) — turn a governed Knowledge artifact, a personal-knowledge
 * doc, or a domain operating manual into an OKF v0.2 bundle (a directory tree of
 * markdown files). The pure field-mapping lives in okf-model.ts; this module wires
 * the STORE records into concept docs, lays out the directory tree with spec-correct
 * `index.md` files, and runs conformance validation on the result (decision #7).
 *
 * Round-trip rule (absolute for our own artifacts): every workflow structure
 * (steps / actors / rules / per-step tacit) survives export→import via the readable
 * body headings AND the lossless `sovereign_os:` extension block.
 */

const VISIBILITY_TIER: Record<string, string> = {
  Personal: 'Personal',
  Shared: 'Shared',
  Marketplace: 'Marketplace',
};

/** A slug safe for a bundle file/dir name. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
}

/** Build the `verified` events from a workflow record's publish/certify audit. */
function workflowVerified(rec: WorkflowRecord): OkfEvent[] {
  const events: OkfEvent[] = [];
  if (rec.publishedBy && rec.publishedAt) events.push({ by: `human:${rec.publishedBy}`, at: rec.publishedAt });
  if (rec.certifiedBy && rec.certifiedAt) events.push({ by: `human:${rec.certifiedBy}`, at: rec.certifiedAt });
  return events;
}

/** The OKF concept doc for a single workflow record. */
export function workflowRecordToOkfDoc(rec: WorkflowRecord): OkfDoc {
  const w = parseWorkflow(rec.md);
  return workflowToOkfDoc(w, {
    id: rec.id,
    owner: rec.owner,
    domain: rec.domain,
    tier: VISIBILITY_TIER[rec.visibility] ?? 'Personal',
    generatedAt: rec.updatedAt,
    verified: workflowVerified(rec),
    tacit: rec.tacit,
    links: rec.links,
  });
}

/** The OKF concept doc for a free-form personal-knowledge doc (→ `overview` type). */
export function personalRecordToOkfDoc(rec: PersonalKnowledgeRecord): OkfDoc {
  const doc: OkfDoc = {
    type: 'overview',
    title: rec.title,
    resource: `${RESOURCE_PREFIX}${rec.id}`,
    status: tierToStatus(VISIBILITY_TIER[rec.visibility] ?? 'Personal'),
    body: rec.md.trim() ? rec.md.trim() + '\n' : '',
    sovereign_os: {
      tier: VISIBILITY_TIER[rec.visibility] ?? 'Personal',
      owner: rec.owner,
      domain: rec.domain,
      id: rec.id,
    },
  };
  if (rec.owner && rec.updatedAt) doc.generated = { by: `human:${rec.owner}`, at: rec.updatedAt };
  return doc;
}

/**
 * Export ONE workflow record as a complete bundle:
 *   index.md               (bundle root listing)
 *   workflows/<slug>.md     (the concept)
 */
export function exportWorkflowBundle(rec: WorkflowRecord): OkfBundle {
  const doc = workflowRecordToOkfDoc(rec);
  const fileName = `${slug(rec.title)}.md`;
  const conceptPath = `workflows/${fileName}`;
  const files = [
    { path: 'index.md', content: bundleRootIndex('This bundle', [{ path: 'workflows/index.md', title: 'Workflows', description: 'Business processes.', isDir: true }]) },
    { path: 'workflows/index.md', content: renderIndexMd([{ path: fileName, title: rec.title, description: firstLine(doc.description) }]) },
    { path: conceptPath, content: serializeOkfDoc(doc) },
    { path: 'log.md', content: logMd(`Workflow “${rec.title}”`, rec.updatedAt) },
  ];
  return { files };
}

/**
 * Export a personal-knowledge doc as a bundle (concepts/ dir).
 */
export function exportPersonalBundle(rec: PersonalKnowledgeRecord): OkfBundle {
  const doc = personalRecordToOkfDoc(rec);
  const fileName = `${slug(rec.title)}.md`;
  return {
    files: [
      { path: 'index.md', content: bundleRootIndex('This bundle', [{ path: 'concepts/index.md', title: 'Concepts', description: 'Knowledge documents.', isDir: true }]) },
      { path: 'concepts/index.md', content: renderIndexMd([{ path: fileName, title: rec.title }]) },
      { path: `concepts/${fileName}`, content: serializeOkfDoc(doc) },
      { path: 'log.md', content: logMd(`Knowledge “${rec.title}”`, rec.updatedAt) },
    ],
  };
}

/**
 * Export a domain operating manual (the pinned 7-section card) as an `overview`
 * concept — the manual's sections become the body headings; the resource URI is
 * keyed by the manual's domain so a re-import versions the same manual concept.
 */
export function exportManualBundle(dk: DomainKnowledge, domain: string): OkfBundle {
  const body = dk.sections
    .filter((s) => s.content.trim())
    .map((s) => `# ${s.title}\n\n${s.content.trim()}\n`)
    .join('\n');
  const doc: OkfDoc = {
    type: 'overview',
    title: `${domain} — Operating Manual`,
    description: `The operating manual for the ${domain} domain.`,
    resource: `${RESOURCE_PREFIX}manual:${domain}`,
    status: 'stable',
    body: body || '',
    sovereign_os: { tier: 'Shared', domain, id: `manual:${domain}` },
  };
  if (dk.updatedAt) doc.generated = { by: `process:operating-manual`, at: dk.updatedAt };
  const fileName = 'operating-manual.md';
  return {
    files: [
      { path: 'index.md', content: bundleRootIndex(`${domain} operating manual`, [{ path: 'manual/index.md', title: 'Manual', description: 'The domain operating manual.', isDir: true }]) },
      { path: 'manual/index.md', content: renderIndexMd([{ path: fileName, title: doc.title!, description: doc.description }]) },
      { path: `manual/${fileName}`, content: serializeOkfDoc(doc) },
      { path: 'log.md', content: logMd(`${domain} operating manual`, dk.updatedAt) },
    ],
  };
}

// ------------------------------------------------------------- helpers ---------

function bundleRootIndex(_title: string, subdirs: { path: string; title: string; description?: string; isDir?: boolean }[]): string {
  const header = `<!-- OKF ${OKF_VERSION} bundle exported from the Sovereign Agentic OS Knowledge tab. -->\n`;
  const fm = `---\nokf_version: "${OKF_VERSION}"\n---\n\n`;
  return fm + header + renderIndexMd(subdirs);
}

function logMd(subject: string, at: string): string {
  const date = (at || new Date().toISOString()).slice(0, 10);
  return `---\ntype: Log\ntitle: Bundle history\n---\n\n# Bundle history\n\n## ${date}\n\n- Exported ${subject} from the Sovereign Agentic OS as an OKF ${OKF_VERSION} bundle.\n`;
}

function firstLine(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s.split('\n')[0].trim() || undefined;
}

/** Validate a produced bundle; returns the bundle + its conformance result. */
export function exportAndValidate(bundle: OkfBundle): { bundle: OkfBundle; validation: ReturnType<typeof validateBundle> } {
  return { bundle, validation: validateBundle(bundle) };
}
