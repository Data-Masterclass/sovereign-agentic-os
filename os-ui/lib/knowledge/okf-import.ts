/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { serializeWorkflow } from './schema.ts';
import {
  createWorkflow,
  updateWorkflow,
  updateTacit,
  getWorkflow,
  setWorkflowLinks,
  type Principal,
} from './store.ts';
import {
  createPersonalKnowledge,
  updatePersonalKnowledge,
  getPersonalKnowledge,
} from './personal-store.ts';
import {
  parseOkfDoc,
  OkfParseError,
  internalKindForType,
  idFromResource,
  okfDocToWorkflow,
  RESERVED_FILES,
  type OkfDoc,
  type OkfBundle,
} from './okf-model.ts';
import { validateBundle, type OkfValidationResult } from './okf-validate.ts';
import { unzipBundle } from './okf-zip.ts';

/**
 * OKF IMPORT (server) — accept an OKF v0.2 bundle and land its concepts as GOVERNED
 * Knowledge artifacts at PERSONAL tier, with the importer as owner, through the
 * NORMAL author ladder (createWorkflow / createPersonalKnowledge) — never a
 * governance bypass. Conformance is validated with the NARROWED rejection rules
 * (reject only unparseable frontmatter / missing type / malformed reserved files;
 * unknown types + unknown fields + broken links are ACCEPTED).
 *
 * Idempotency (decision #4): a concept whose `resource` is `sovereign-os://
 * knowledge/<id>` and whose <id> the importer can already edit becomes a NEW
 * VERSION of that artifact (normal versioning). Otherwise it is a new artifact. No
 * silent duplicates.
 *
 * SECURITY (decision #5): the zip layer (okf-zip.ts) sanitises paths (zip-slip) and
 * enforces caps BEFORE we ever see file contents.
 */

export type ImportedConcept = {
  path: string;
  /** The concept's OKF type string (kept verbatim + shown honestly). */
  type: string;
  /** The internal kind it mapped to. */
  kind: 'workflow' | 'general';
  title: string;
  /** The created / versioned artifact id. */
  id: string;
  /** `created` (new artifact) or `versioned` (matched an existing resource id). */
  outcome: 'created' | 'versioned';
};

export type ImportResult = {
  ok: boolean;
  /** Conformance validation of the whole bundle (runs on every import). */
  validation: OkfValidationResult;
  imported: ImportedConcept[];
  /** Concepts skipped with an honest reason (e.g. reserved file, edit denied on a matched id). */
  skipped: { path: string; reason: string }[];
  /** Present only when the bundle was REJECTED (conformance failure). */
  rejected?: string;
};

/** Decode a zip Buffer and import it. The zip layer enforces zip-slip + caps. */
export function importOkfZip(zip: Buffer, user: Principal, opts: { domain?: string } = {}): ImportResult {
  const bundle = unzipBundle(zip); // throws OkfZipError (honest reason) on a violation
  return importBundle(bundle, user, opts);
}

/**
 * Import an already-decoded in-memory bundle. Validates conformance first; a
 * conformance failure REJECTS the whole bundle with the honest first error.
 */
export function importBundle(bundle: OkfBundle, user: Principal, opts: { domain?: string } = {}): ImportResult {
  const validation = validateBundle(bundle);
  if (!validation.ok) {
    return {
      ok: false,
      validation,
      imported: [],
      skipped: [],
      rejected: validation.errors[0]?.message ?? 'bundle failed OKF conformance',
    };
  }

  const imported: ImportedConcept[] = [];
  const skipped: { path: string; reason: string }[] = [];

  for (const file of bundle.files) {
    if (!file.path.toLowerCase().endsWith('.md')) continue;
    const base = basename(file.path).toLowerCase();
    if (RESERVED_FILES.has(base)) {
      // Reserved files are structure, never concepts — silently not imported.
      continue;
    }

    let doc: OkfDoc;
    try {
      doc = parseOkfDoc(file.content);
    } catch (e) {
      // Should not happen (validation already passed), but stay honest if it does.
      if (e instanceof OkfParseError) { skipped.push({ path: file.path, reason: e.message }); continue; }
      throw e;
    }

    const kind = internalKindForType(doc.type);
    const domain = opts.domain;
    try {
      const result = kind === 'workflow'
        ? importWorkflowConcept(doc, user, domain)
        : importGeneralConcept(doc, user, domain);
      imported.push({ path: file.path, type: doc.type, kind, title: result.title, id: result.id, outcome: result.outcome });
    } catch (e) {
      skipped.push({ path: file.path, reason: (e as Error).message });
    }
  }

  return { ok: true, validation, imported, skipped };
}

// ------------------------------------------------------- per-concept import ----

/** Import a `workflow`-typed concept → a Personal-tier workflow artifact. */
function importWorkflowConcept(
  doc: OkfDoc,
  user: Principal,
  domain: string | undefined,
): { id: string; title: string; outcome: 'created' | 'versioned' } {
  const existingId = matchExisting(doc, user, 'workflow');
  const title = doc.title?.trim() || 'Imported Workflow';

  if (existingId) {
    // NEW VERSION of the existing artifact (idempotent re-import). We rebuild the
    // canonical workflow.md from the concept and PATCH it (which versions).
    const view = getWorkflow(existingId, user);
    const w = okfDocToWorkflow(doc, existingId, view.domain);
    // Preserve the live tier/status so a re-import of a Personal export doesn't
    // silently demote a since-published workflow.
    w.visibility = view.visibility;
    w.status = view.status;
    const md = spliceBody(serializeWorkflow(w), extraProseBody(doc));
    updateWorkflow(existingId, user, { md });
    const tacit = tacitFromDoc(doc);
    if (tacit) updateTacit(existingId, user, tacit);
    restoreLinks(existingId, user, doc);
    return { id: existingId, title, outcome: 'versioned' };
  }

  // New artifact — created at Personal tier, importer as owner (normal ladder).
  const rec = createWorkflow(user, { title, domain });
  const w = okfDocToWorkflow(doc, rec.id, rec.domain);
  const md = spliceBody(serializeWorkflow(w), extraProseBody(doc));
  updateWorkflow(rec.id, user, { md });
  const tacit = tacitFromDoc(doc);
  if (tacit) updateTacit(rec.id, user, tacit);
  restoreLinks(rec.id, user, doc);
  return { id: rec.id, title, outcome: 'created' };
}

/** Import any non-workflow concept (known `overview`/`term`/… OR an unknown type) → a free-form Personal knowledge doc. */
function importGeneralConcept(
  doc: OkfDoc,
  user: Principal,
  domain: string | undefined,
): { id: string; title: string; outcome: 'created' | 'versioned' } {
  const existingId = matchExisting(doc, user, 'general');
  const title = doc.title?.trim() || 'Imported Concept';
  // Keep the ORIGINAL type visible + foreign frontmatter preserved: prepend an
  // honest header so an unknown/foreign type is shown, not lost, in a free-form doc.
  const md = generalMarkdown(doc);

  if (existingId) {
    updatePersonalKnowledge(existingId, user, { title, md });
    return { id: existingId, title, outcome: 'versioned' };
  }
  const rec = createPersonalKnowledge(user, { title, md, domain });
  return { id: rec.id, title, outcome: 'created' };
}

// ----------------------------------------------------------------- helpers -----

/**
 * Idempotency lookup: if the concept's `resource` encodes one of OUR ids and the
 * importer can already view+edit that artifact, return the id (→ version it).
 * Otherwise null (→ create new). A matched id of the WRONG kind is ignored (never
 * cross-map a workflow onto a personal doc).
 */
function matchExisting(doc: OkfDoc, user: Principal, kind: 'workflow' | 'general'): string | null {
  const id = idFromResource(doc.resource);
  if (!id) return null;
  try {
    if (kind === 'workflow') {
      const v = getWorkflow(id, user);
      // Only version if the importer may actually edit it (owner or a domain steward).
      const canEdit = v.owner === user.id;
      return canEdit ? id : null;
    }
    const rec = getPersonalKnowledge(id, user);
    return rec.owner === user.id ? id : null;
  } catch {
    return null; // not found / not viewable → new artifact
  }
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** Splice a prose body back in right after the frontmatter of a serialized workflow. */
function spliceBody(md: string, body: string): string {
  if (!body.trim()) return md;
  return md.replace(/^(---\n[\s\S]*?\n---\n\n)/, `$1${body.trim()}\n\n`);
}

/**
 * Extra prose from a foreign workflow bundle that had NO `sovereign_os` structure —
 * the whole body becomes the workflow's prose body. For our own round-tripped
 * bundles the extension carries the structure, so the readable body is regenerated
 * and this returns empty.
 */
function extraProseBody(doc: OkfDoc): string {
  return doc.sovereign_os?.workflow?.steps ? '' : doc.body.trim();
}

/** Extract the `# Tacit knowledge` section from a round-tripped workflow body. */
function tacitFromDoc(doc: OkfDoc): string {
  const m = /(^|\n)#\s+Tacit knowledge\s*\n([\s\S]*?)(?=\n#\s|\n*$)/.exec(doc.body);
  return m ? m[2].trim() : '';
}

/** Restore Data & Metrics links from the extension (best-effort; ids re-scoped by the store elsewhere). */
function restoreLinks(id: string, user: Principal, doc: OkfDoc): void {
  const links = doc.sovereign_os?.workflow?.links;
  if (links && (links.datasets?.length || links.metrics?.length)) {
    try {
      setWorkflowLinks(id, user, { datasets: links.datasets ?? [], metrics: links.metrics ?? [] });
    } catch {
      /* links are best-effort — a missing linked id never blocks the import */
    }
  }
}

/**
 * Build the free-form markdown for a general/unknown concept. Foreign frontmatter is
 * preserved verbatim in a fenced block so nothing is lost and the original type is
 * shown honestly.
 */
function generalMarkdown(doc: OkfDoc): string {
  const parts: string[] = [];
  const isUnknownType = internalKindForType(doc.type) === 'general' && doc.type.trim().toLowerCase() !== 'overview';
  if (isUnknownType) {
    parts.push(`> Imported OKF concept — original type: \`${doc.type}\`.`, '');
  }
  if (doc.description?.trim()) parts.push(doc.description.trim(), '');
  if (doc.body.trim()) parts.push(doc.body.trim(), '');
  // Preserve foreign frontmatter verbatim so a re-export could carry it.
  if (doc.extra && Object.keys(doc.extra).length) {
    parts.push('<!-- preserved OKF frontmatter (foreign fields) -->', '```yaml');
    for (const [k, v] of Object.entries(doc.extra)) parts.push(`${k}: ${JSON.stringify(v)}`);
    parts.push('```', '');
  }
  return parts.join('\n').trim() + '\n';
}
