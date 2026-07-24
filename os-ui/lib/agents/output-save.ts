/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { DeclaredOutput } from './system-schema.ts';

/**
 * Pure helpers for the "Save result → <output>" action (Run/Evaluate). Kept PURE (no
 * server imports) so the client can decide what to offer per output kind and the server
 * route can reuse the exact same predicates. The persistence itself runs through the
 * SAME governed create the tabs use (Files / Knowledge / Data) — see the outputs/save
 * route — never a parallel store.
 */

/**
 * A heuristic "does this run output look like CSV/tabular text?" test. We only offer a
 * save-from-result for a DATA output when the result IS tabular — otherwise the agent's
 * own governed write tools (enabled by the declared Write grant) are the right path, and
 * the UI says so. Conservative: at least two non-empty lines, a consistent delimiter
 * (comma / tab / semicolon) with ≥2 columns, and no markdown fence noise on the header.
 */
export function looksTabular(text: string): boolean {
  const lines = text.trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) return false;
  const header = lines[0].replace(/^`+|`+$/g, '');
  const delim = header.includes('\t') ? '\t' : header.includes(';') && !header.includes(',') ? ';' : ',';
  const cols = header.split(delim).length;
  if (cols < 2) return false;
  // Every data row must split into the same column count (allow one trailing empty line).
  return lines.slice(1).every((l) => l.replace(/^`+|`+$/g, '').split(delim).length === cols);
}

/** Whether a save-from-result button should be offered for this output + run text. */
export function canSaveFromResult(output: Pick<DeclaredOutput, 'kind'>, text: string): boolean {
  if (!text.trim()) return false;
  if (output.kind === 'files' || output.kind === 'knowledge') return true;
  // Data: only when the result is CSV/tabular; otherwise rely on the agent's write tools.
  return looksTabular(text);
}

/** A plain-language reason a DATA output can't be saved from the result (shown in the UI). */
export const DATA_NON_TABULAR_NOTE =
  'This result is not tabular, so it cannot be saved as a dataset here. During a run the team writes datasets itself using the Write access this output grants.';
