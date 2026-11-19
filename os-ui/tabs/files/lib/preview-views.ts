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
export type PreviewViewOption = { id: PreviewViewId; label: string };

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
  return [
    { id: 'original', label: 'Original' },
    { id: 'text', label: mode === 'video' || mode === 'audio' ? 'Transcript' : 'Extracted text' },
    { id: 'details', label: 'Details' },
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
 * What the text view says when there is no text to show. `storedWhy` is the pane's own
 * sentence (restricted / opted out / the parser's failure reason / nothing extracted yet).
 */
export function emptyTextMessage(s: { extracting: boolean; storedWhy: string; transcript: boolean }): string {
  if (s.extracting) return 'Extracting text… It appears here when the document parser finishes.';
  if (s.storedWhy) return s.storedWhy;
  return s.transcript ? 'No transcript is stored for this file.' : 'No extracted text is stored for this file.';
}
