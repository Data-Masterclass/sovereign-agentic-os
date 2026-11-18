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
 *   - Committing still goes `addOutput(system, …)` → `onCommit` → the governed `system.yaml`
 *     write, unchanged. What IS persisted here is the DRAFT, per system id, in the browser's
 *     session storage: the stage guard only covers exits it can see, and leaving the system
 *     altogether (sidebar, another tab, a reload) unmounts the section with no transition to
 *     intercept — which is the "it reset" the owner originally reported. The draft is parked on
 *     every keystroke and restored on remount; saving it clears the parking slot.
 *   - The storage helpers are PURE (key, serialize, parse); the component owns the `try/catch`
 *     around `sessionStorage`, which throws in a private window and is absent on the server.
 *     `parseOutputDraft` never throws and returns `null` for anything it cannot trust —
 *     foreign JSON, a bad enum, or a draft that holds nothing worth restoring.
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

/**
 * True when the draft is complete enough to commit: it needs a NAME.
 *
 * It deliberately does not demand folder text. Blank folder text means the ROOT — that is how
 * `folderOf` reads it here and how `addOutput`'s `normaliseFolderPath` reads it on the way in —
 * and root is a real destination. Requiring non-blank text made a perfectly saveable draft
 * un-saveable and, worse, un-promptable: the guard would ask a question whose "Save" button
 * could never be pressed.
 */
export function outputDraftValid(draft: OutputDraft): boolean {
  return draft.name.trim() !== '';
}

/** The draft as `addOutput` will receive it: the folder normalised the way the commit does. */
export function outputDraftFolder(draft: OutputDraft): string {
  return folderOf(draft);
}

// ------------------------------------------------------------ parking a draft --

/** Session-storage key for one system's parked draft. Per system: two teams, two drafts. */
export function outputDraftStorageKey(systemId: string): string {
  return `os.agents.output-draft.${systemId}`;
}

/** The draft as a string to park. */
export function serializeOutputDraft(draft: OutputDraft): string {
  return JSON.stringify({
    kind: draft.kind,
    name: draft.name,
    scope: draft.scope,
    folder: draft.folder,
  });
}

const KINDS: OutputDraftKind[] = ['files', 'data', 'knowledge'];
const SCOPES: OutputDraft['scope'][] = ['personal', 'domain'];

/**
 * A parked draft, or `null` when there is nothing to restore. Never throws: storage holds
 * whatever a previous version (or another tab) left there, so every field is checked and
 * anything unrecognised falls back to the empty draft's value. A draft that is not dirty is
 * `null` too — restoring an empty row is not a restore.
 */
export function parseOutputDraft(raw: string | null | undefined): OutputDraft | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  const kind = KINDS.includes(rec.kind as OutputDraftKind)
    ? (rec.kind as OutputDraftKind)
    : EMPTY_OUTPUT_DRAFT.kind;
  const scope = SCOPES.includes(rec.scope as OutputDraft['scope'])
    ? (rec.scope as OutputDraft['scope'])
    : EMPTY_OUTPUT_DRAFT.scope;
  const draft: OutputDraft = {
    kind,
    name: typeof rec.name === 'string' ? rec.name : '',
    scope,
    folder: typeof rec.folder === 'string' && rec.folder.trim() !== '' ? rec.folder : '/',
  };
  return outputDraftDirty(draft) ? draft : null;
}
