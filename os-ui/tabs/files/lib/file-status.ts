/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       files
 * FEATURE:    One rule for the file status chip, shared by the listing, the preview and MCP
 * USER STORY: As a file owner I want the chip on a file to say what the index really did with it
 *             ("Searchable" only after its rows were written; "Indexing failed" or "Not indexed"
 *             otherwise), so search behaves the way the chip says it will.
 * ARCHITECTURE:
 *   - Pure, type-only import of the asset schema, so the browser components can import it too
 *     (a `.tsx` cannot be tested; this `.ts` sibling is what the test reads).
 *   - Reads `indexing.outcome`, which `indexAsset` records after every run. The indexing MODE
 *     only says a file is ALLOWED to be indexed; it never decides "Searchable" on its own.
 */
import type { Extraction, IndexingMode, IndexOutcome } from '@tabs/files/lib/asset-schema';

/** The only fields the rule reads — so a browser view of a file satisfies it too. */
type StatusInput = { indexing: { mode: IndexingMode; extraction?: Pick<Extraction, 'status'>; outcome?: IndexOutcome } };

/** The calm status chip (deep-design A5), now tied to the recorded index outcome. */
export type FileStatus = 'processing' | 'searchable' | 'stored' | 'not-indexed' | 'index-failed';

export function fileStatusOf(a: StatusInput): FileStatus {
  // A binary whose text is being read right now is neither searchable nor "stored only".
  if (a.indexing.extraction?.status === 'pending') return 'processing';
  if (a.indexing.mode === 'stored-only') return 'stored';
  const outcome = a.indexing.outcome;
  if (outcome?.status === 'indexed') return 'searchable';
  if (outcome?.status === 'failed') return 'index-failed';
  return 'not-indexed';
}

export const FILE_STATUS_LABEL: Record<FileStatus, string> = {
  processing: 'Processing…',
  searchable: 'Searchable ✓',
  stored: 'Stored',
  'not-indexed': 'Not indexed',
  'index-failed': 'Indexing failed',
};

/** The CSS chip class for a status (the three existing chip colours). */
export function fileStatusClass(s: FileStatus): string {
  if (s === 'searchable') return 's-searchable';
  if (s === 'processing' || s === 'index-failed') return 's-processing';
  return 's-stored';
}
