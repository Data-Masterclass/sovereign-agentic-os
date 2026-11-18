/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    "Describe & tag" a whole selection — the fix for a failed bulk promotion
 * USER STORY: As a Files owner whose 12 invoices were refused for having no description and no
 *             tag, I document them all from the same toolbar that refused them — and the tags a
 *             file already carried survive, because a bulk retag must not destroy work.
 * ARCHITECTURE:
 *   - Pure per-row patch builder for the EXISTING per-file write path: PATCH /api/files/[id]
 *     with `{ description?, tags? }` → `setDocs`, edit-gated by `editOf` → `canManageArtifact`.
 *     No new write path, so there is no second gate to keep in step with the first.
 *   - APPEND is the default (set-union) and REPLACE is an explicit act: a bulk action that
 *     silently dropped existing tags would destroy an author's work on a mis-click, which is
 *     the same rule the Knowledge actor registry learned ("a reference the registry does not
 *     hold is a warning, never a repair").
 *   - A row that would not change returns `null` — the caller SKIPS the request rather than
 *     recording a failure, so a selection of already-documented files costs no version churn
 *     (`setDocs` re-versions on every call).
 */

/** The listing fields this edit reads — a `FileSummary` row satisfies it. */
export type DocsRow = { id: string; name: string; description: string; tags: string[] };

export type DescribeAndTagInput = {
  description: string;
  tags: string[];
  /** Write the description over one the file already has (default: fill gaps only). */
  overwriteDescription: boolean;
  /** Replace the file's tags with exactly `tags` — including clearing them (default: append). */
  replaceTags: boolean;
};

/** Exactly the shape PATCH /api/files/[id] accepts; an absent key is not written. */
export type DocsPatch = { description?: string; tags?: string[] };

/** Split a free-text tag entry on commas and newlines. Trims; drops blanks. */
export function parseTagInput(raw: string): string[] {
  return cleanTags(raw.split(/[\n,]/));
}

/**
 * Trim, drop blanks, and dedupe case-insensitively keeping the FIRST spelling — so
 * "Finance, finance" is one tag and the file keeps the casing it already had.
 */
export function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const tag = t.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** Set-union: everything the file already carries, then every new tag, in entry order. */
export function unionTags(existing: string[], added: string[]): string[] {
  return cleanTags([...existing, ...added]);
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * The PATCH body for ONE file, or `null` when the file would not change.
 *
 *  • tags        — union with what the file has, unless `replaceTags` (then exactly the entry,
 *                  empty included). Omitted when the result equals the file's current tags.
 *  • description — written when the entry is non-empty AND (`overwriteDescription` or the file
 *                  has no description yet). An empty entry never blanks an existing one.
 */
export function describeAndTagPatch(row: DocsRow, input: DescribeAndTagInput): DocsPatch | null {
  const patch: DocsPatch = {};

  const entered = cleanTags(input.tags);
  const nextTags = input.replaceTags ? entered : unionTags(row.tags, entered);
  if (!same(cleanTags(row.tags), nextTags)) patch.tags = nextTags;

  const description = input.description.trim();
  const hasOwn = row.description.trim().length > 0;
  if (description && (input.overwriteDescription || !hasOwn) && description !== row.description.trim()) {
    patch.description = description;
  }

  return patch.tags === undefined && patch.description === undefined ? null : patch;
}
