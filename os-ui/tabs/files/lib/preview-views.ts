/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The view switch above the file viewer (Original / Extracted text / Details) and the
 * one-line "text extracted" status under the title. Pure so the wording and the
 * which-views-exist rule are unit-tested independently of React.
 *
 * WHY a file is not searchable is NOT decided here: the pane computes that sentence once
 * (`storedWhy`) and hands it in, so the header row and the text view can never disagree.
 */
export type PreviewViewId = 'original' | 'text' | 'details';
/** `labelKey` is the i18n key (`files.preview.views.<labelKey>`); `label` stays the English text. */
export type PreviewViewOption = { id: PreviewViewId; label: string; labelKey: 'original' | 'text' | 'transcript' | 'details' };

/** The inline viewers that show the ORIGINAL bytes (a CSV renders from its text instead). */
export type ByteViewerMode = 'image' | 'pdf' | 'video' | 'audio';

const VIEW_IDS: readonly PreviewViewId[] = ['original', 'text', 'details'];

export function isPreviewViewId(v: unknown): v is PreviewViewId {
  return typeof v === 'string' && (VIEW_IDS as readonly string[]).includes(v);
}

/**
 * Which views the switch offers. Only a file with an inline byte-viewer gets one — a text
 * file IS its text and a CSV is its table, so there is nothing to switch between. The text
 * option is always present (even with no text) so its absence is explained, not hidden.
 */
export function previewViews(mode: string | null | undefined): PreviewViewOption[] {
  if (mode !== 'image' && mode !== 'pdf' && mode !== 'video' && mode !== 'audio') return [];
  const transcript = mode === 'video' || mode === 'audio';
  return [
    { id: 'original', label: 'Original', labelKey: 'original' },
    { id: 'text', label: transcript ? 'Transcript' : 'Extracted text', labelKey: transcript ? 'transcript' : 'text' },
    { id: 'details', label: 'Details', labelKey: 'details' },
  ];
}

/** Where the remembered choice lives — per kind of viewer, in this browser only. */
export function previewViewStorageKey(mode: ByteViewerMode): string {
  return `files.preview.view.${mode}`;
}

/** Keyboard roving for the tab list: arrows wrap, Home/End jump. `null` = not a move key. */
export function nextPreviewView(ids: readonly PreviewViewId[], current: PreviewViewId, key: string): PreviewViewId | null {
  if (ids.length === 0) return null;
  const at = Math.max(0, ids.indexOf(current));
  if (key === 'ArrowRight' || key === 'ArrowDown') return ids[(at + 1) % ids.length];
  if (key === 'ArrowLeft' || key === 'ArrowUp') return ids[(at - 1 + ids.length) % ids.length];
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids[ids.length - 1];
  return null;
}

/**
 * The one-line status under the title once text HAS been extracted, e.g.
 * "Text extracted · 877 characters · 19/11/2026, 10:42:00". Empty for every other state:
 * extracting and not-searchable already have their own line in the header.
 */
export function extractedStatusLine(
  extraction: { status: string; at?: string; chars?: number } | undefined,
  textLength: number,
  formatDate: (iso: string) => string,
): string {
  if (extraction?.status !== 'extracted') return '';
  const chars = typeof extraction.chars === 'number' ? extraction.chars : textLength;
  const parts = ['Text extracted', `${chars.toLocaleString('en-US')} ${chars === 1 ? 'character' : 'characters'}`];
  if (extraction.at) parts.push(formatDate(extraction.at));
  return parts.join(' · ');
}

/**
 * The facts behind {@link extractedStatusLine}, for the UI to word in the user's language:
 * null for every state that is not "extracted".
 */
export function extractedStatus(
  extraction: { status: string; at?: string; chars?: number } | undefined,
  textLength: number,
): { chars: number; at?: string } | null {
  if (extraction?.status !== 'extracted') return null;
  const chars = typeof extraction.chars === 'number' ? extraction.chars : textLength;
  return extraction.at ? { chars, at: extraction.at } : { chars };
}

/**
 * What the text view says when there is no text to show. `storedWhy` is the pane's own
 * sentence (restricted / opted out / the parser's failure reason / nothing extracted yet).
 */
export function emptyTextMessage(s: { extracting: boolean; storedWhy: string; transcript: boolean }): string {
  if (s.extracting) return 'Extracting text… It appears here when the document parser finishes.';
  if (s.storedWhy) return s.storedWhy;
  return s.transcript ? 'No transcript is stored for this file.' : 'No extracted text is stored for this file.';
}

/** The i18n key (`files.preview.empty.<key>`) for {@link emptyTextMessage}; null = show `storedWhy` as it is. */
export function emptyTextKey(s: { extracting: boolean; storedWhy: string; transcript: boolean }): 'extracting' | 'noTranscript' | 'noText' | null {
  if (s.extracting) return 'extracting';
  if (s.storedWhy) return null;
  return s.transcript ? 'noTranscript' : 'noText';
}

// ---------------------------------------------------------------------------
//  Automatic description + tags: the marker and the one status line in Details
// ---------------------------------------------------------------------------

/** The plain word next to a description / tag nobody has edited since it was generated. */
export const SUGGESTED_WORD = 'suggested';
export const SUGGESTED_TOOLTIP = 'Written automatically from the file’s content. Edit to change.';
export const WRITING_DESCRIPTION = 'Writing a description…';

export type AutoDocsLine = {
  /** One sentence, or '' when there is only an action to offer. English — for non-UI readers. */
  text: string;
  /**
   * The i18n key (`files.preview.docs.<textKey>`) when `text` is the OS's own sentence. Absent when
   * `text` is the recorded reason (the server's words, shown as they are) or empty.
   */
  textKey?: 'restricted' | 'optedOut' | 'writing' | 'noText' | 'failed';
  /** The generator is running right now. */
  pending: boolean;
  /** `retry` after a failure, `regenerate` otherwise; null when the file may not be described. */
  action: 'retry' | 'regenerate' | null;
};

/**
 * What Details says about the automatic description, and which action it offers. Null = say
 * nothing. A restricted file and an owner's opt-out explain WHY nothing was written and offer no
 * action; a failure shows its recorded reason with "Try again"; otherwise whoever may edit the
 * file gets "Regenerate" (which never replaces their own description or a tag they removed).
 */
export function autoDocsLine(s: {
  restricted: boolean;
  optedOut: boolean;
  hasText: boolean;
  extracting: boolean;
  hasDescription: boolean;
  canManage: boolean;
  generation?: { status: string; reason?: string };
}): AutoDocsLine | null {
  if (s.restricted) {
    return s.hasDescription ? null
      : { text: 'Restricted files are never sent to a model, so no description or tags are written for them.', textKey: 'restricted', pending: false, action: null };
  }
  if (s.optedOut) {
    return s.hasDescription ? null
      : { text: 'This file is stored only by its owner’s choice, so no description is written for it.', textKey: 'optedOut', pending: false, action: null };
  }
  if (s.generation?.status === 'pending') return { text: WRITING_DESCRIPTION, textKey: 'writing', pending: true, action: null };
  if (s.extracting) return null; // the text is still being read; the description follows it
  if (!s.hasText) {
    return s.hasDescription ? null : { text: 'No description was written: there is no text to describe.', textKey: 'noText', pending: false, action: null };
  }
  if (s.generation?.status === 'failed') {
    const reason = s.generation.reason;
    return reason != null
      ? { text: reason, pending: false, action: s.canManage ? 'retry' : null }
      : { text: 'No description was written.', textKey: 'failed', pending: false, action: s.canManage ? 'retry' : null };
  }
  return s.canManage ? { text: '', pending: false, action: 'regenerate' } : null;
}
