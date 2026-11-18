/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    The "Where the results go" draft — is there unsaved work, and may it be saved?
 * USER STORY: As a team author I fill the output fields and move on; my typing must either be
 *             saved or be the subject of a question, never silently dropped on unmount.
 * ARCHITECTURE:
 *   - Two pure predicates, no state. `SimpleBuilder`'s `OutputsSection` holds the draft and
 *     reports `{ dirty, valid, save }` upward; the builder — which owns every exit from the
 *     Define stage — commits a valid draft or renders ONE prompt. The same division of labour
 *     the knowledge editor's `editor-guard.ts` uses, re-implemented rather than imported: a tab
 *     imports only `@core/*` and itself.
 *   - DIRTY is "differs from the empty draft in ANY field", so the marker cannot under-report
 *     (a lone Type or Scope flip is unsaved work too). VALID is the subset `addOutput` can
 *     accept: a real name and a folder path. Keeping them separate is the point — a dirty but
 *     invalid draft is exactly the case that must ask rather than guess.
 *   - Nothing here persists anything: committing still goes `addOutput(system, …)` → `onCommit`
 *     → the governed `system.yaml` write, unchanged.
 */

/** The destination kinds a declared output can target (mirrors `OutputKind`). */
export type OutputDraftKind = 'files' | 'data' | 'knowledge';

/** The four fields of the draft row under "Where the results go". */
export type OutputDraft = {
  kind: OutputDraftKind;
  name: string;
  scope: 'personal' | 'domain';
  /** Folder path; `'/'` = root, which IS a destination. */
  folder: string;
};

/** The pristine draft a freshly mounted (or just-saved) section shows. */
export const EMPTY_OUTPUT_DRAFT: OutputDraft = {
  kind: 'files',
  name: '',
  scope: 'personal',
  folder: '/',
};

/** The folder as the user effectively chose it — blank text is the root, not a value. */
function folderOf(draft: OutputDraft): string {
  const f = draft.folder.trim();
  return f === '' ? '/' : f;
}

/** True when the draft holds work that is not on the system yet. */
export function outputDraftDirty(draft: OutputDraft): boolean {
  return (
    draft.name.trim() !== EMPTY_OUTPUT_DRAFT.name
    || draft.kind !== EMPTY_OUTPUT_DRAFT.kind
    || draft.scope !== EMPTY_OUTPUT_DRAFT.scope
    || folderOf(draft) !== EMPTY_OUTPUT_DRAFT.folder
  );
}

/** True when the draft is complete enough to commit: a name and a folder. */
export function outputDraftValid(draft: OutputDraft): boolean {
  return draft.name.trim() !== '' && draft.folder.trim() !== '';
}
