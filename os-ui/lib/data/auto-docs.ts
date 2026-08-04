/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { AssistantMessage } from '../assistant/complete.ts';
import type { ColumnDoc, Dataset } from './dataset-schema.ts';

/**
 * AUTO-DOCUMENTATION after ingestion (Data tab).
 *
 * When a dataset's FIRST Bronze build lands and it has NO documentation yet, we draft its
 * description + column notes ONCE, automatically, grounded in the REAL landed schema +
 * preview (never invented), and persist ONLY the empty fields — a human's words are never
 * overwritten. The write is marked `docsProvenance: 'ai-auto'` so the UI can show a subtle
 * "AI-drafted — review…" note, cleared the moment a human saves the section.
 *
 * This module is split PURE-from-IO so the mapping is unit-tested:
 *   - {@link needsAutoDocs}     — the trigger predicate (empty docs?).
 *   - {@link docsPromptMessages}— grounding → the SAME documentation instructions the
 *                                 Define/Documentation assistant stage uses (no duplicated
 *                                 prompt philosophy — one grounded, honest draft).
 *   - {@link parseDocsDraft}    — the model's JSON reply → `{ description, columns }`.
 *   - {@link mergeEmptyDocs}    — fill ONLY empty description/column notes (never clobber).
 * {@link autoDocumentAfterIngest} is the thin async orchestrator the ingest path fires and
 * forgets: if the model is unreachable it skips SILENTLY (no docs, no error) — the
 * Documentation section keeps its normal empty state.
 */

/** The real landed shape the draft is grounded in (straight from the ingest report). */
export type IngestGrounding = {
  name: string;
  columns: { name: string; type: string }[];
  preview: { columns: string[]; rows: string[][] };
};

/** The model's documentation draft (description + per-column meaning). */
export type DocsDraft = { description: string; columns: ColumnDoc[] };

/**
 * TRUE only when the dataset has NO documentation to preserve: an empty description AND no
 * column carrying a note. A dataset a human has already described is left untouched.
 */
export function needsAutoDocs(dataset: Pick<Dataset, 'description' | 'columns'>): boolean {
  const hasDescription = !!(dataset.description ?? '').trim();
  const hasColumnDoc = (dataset.columns ?? []).some((c) => !!(c.description ?? '').trim());
  return !hasDescription && !hasColumnDoc;
}

/** A compact, TRUTHFUL preview block for the prompt — the header + a few real rows. */
function previewBlock(preview: IngestGrounding['preview'], maxRows = 5): string {
  if (!preview.columns.length) return '(no preview available)';
  const head = preview.columns.join(' | ');
  const rows = preview.rows.slice(0, maxRows).map((r) => r.join(' | '));
  return [head, ...rows].join('\n');
}

/**
 * The system + user messages for a grounded documentation draft. Same instruction shape as
 * the Define/Documentation assistant stage: plain-language, business terms, ONLY the real
 * columns — but grounded ADDITIONALLY in the landed types + a real preview so the draft
 * describes what actually arrived. JSON-only reply: {"description", "columns":[{name,description}]}.
 */
export function docsPromptMessages(g: IngestGrounding): AssistantMessage[] {
  const cols = g.columns.map((c) => `${c.name} (${c.type})`).join(', ') || '(none)';
  return [
    {
      role: 'system',
      content:
        'You document a freshly-ingested dataset for a business user. You are given its name, its real column names + types, and a small preview of the actual rows. Draft (1) a one-line plain-language description of what the dataset holds, and (2) a short plain meaning for each column. Ground EVERY word in the provided schema + preview — never invent columns, values or facts you cannot see. Return ONLY a JSON object (no prose, no code fences): {"description": string, "columns": [{"name": string, "description": string}]}. Use ONLY the provided column names. Keep each description to one calm sentence, no jargon.',
    },
    {
      role: 'user',
      content: `Dataset: ${g.name || '(unnamed)'}\nColumns (name (type)): ${cols}\nPreview of the real rows:\n${previewBlock(g.preview)}\nReturn the JSON documentation draft.`,
    },
  ];
}

/**
 * Parse the model's reply into a {@link DocsDraft}. Tolerant of a stray code fence; returns
 * null on anything unusable (bad JSON / wrong shape) so the caller skips silently rather
 * than persisting garbage. Column entries with no `name` are dropped.
 */
export function parseDocsDraft(raw: string): DocsDraft | null {
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const description = typeof obj.description === 'string' ? obj.description.trim() : '';
  const columns: ColumnDoc[] = Array.isArray(obj.columns)
    ? obj.columns
        .map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>) : {}))
        .map((c) => ({ name: typeof c.name === 'string' ? c.name.trim() : '', description: typeof c.description === 'string' ? c.description.trim() : '' }))
        .filter((c) => c.name.length > 0)
    : [];
  if (!description && columns.length === 0) return null; // nothing usable
  return { description, columns };
}

/**
 * Merge a draft into the CURRENT docs, filling ONLY empty fields — a human's description or
 * column note is NEVER overwritten. Column notes are matched by name against the columns
 * the dataset already knows (from the Bronze preload); a draft note for an unknown column
 * is ignored (we never add columns the schema doesn't have). Returns the {description,
 * columns} to persist, or null when the draft fills nothing new.
 */
export function mergeEmptyDocs(
  current: Pick<Dataset, 'description' | 'columns'>,
  draft: DocsDraft,
): { description?: string; columns?: ColumnDoc[] } | null {
  let changed = false;
  const out: { description?: string; columns?: ColumnDoc[] } = {};

  if (!(current.description ?? '').trim() && draft.description) {
    out.description = draft.description;
    changed = true;
  }

  const byName = new Map(draft.columns.map((c) => [c.name, c.description]));
  const cols = (current.columns ?? []).map((c) => {
    if (!(c.description ?? '').trim()) {
      const note = byName.get(c.name);
      if (note) {
        changed = true;
        return { name: c.name, description: note };
      }
    }
    return c;
  });
  if (cols.some((c, i) => c.description !== (current.columns ?? [])[i]?.description)) out.columns = cols;

  return changed ? out : null;
}

/** The model caller shape (matches `assistantComplete` — injected so the orchestrator is testable). */
export type DocsCompleter = (messages: AssistantMessage[]) => Promise<{ content: string }>;
/** The persist shape (matches `setDocs` with the ai-auto provenance option). */
export type DocsPersister = (docs: { description?: string; columns?: ColumnDoc[] }) => void;

/**
 * Draft + persist auto-docs for a freshly-ingested dataset. PURE-orchestration over the two
 * injected effects (complete, persist), so the whole decision path is unit-tested and the
 * real wiring lives in the ingest module. Fires only when {@link needsAutoDocs}; on ANY
 * model/parse failure it skips silently (returns false) — no docs, no thrown error.
 *
 * Returns true iff it actually wrote docs.
 */
export async function autoDocumentAfterIngest(
  dataset: Pick<Dataset, 'description' | 'columns'>,
  grounding: IngestGrounding,
  deps: { complete: DocsCompleter; persist: DocsPersister },
): Promise<boolean> {
  if (!needsAutoDocs(dataset)) return false;
  try {
    const { content } = await deps.complete(docsPromptMessages(grounding));
    const draft = parseDocsDraft(content);
    if (!draft) return false;
    const merged = mergeEmptyDocs(dataset, draft);
    if (!merged) return false;
    deps.persist(merged);
    return true;
  } catch {
    // Model unreachable / cost-capped / any fault → skip silently-but-honestly.
    return false;
  }
}
