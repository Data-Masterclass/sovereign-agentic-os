/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Download helpers for the Files tab.
 *
 * Two record shapes reach the download route:
 *   1. A record WITH a stored object (UI upload) — the original bytes are streamed
 *      from the blob store byte-for-byte with their real content-type.
 *   2. A text-only record (MCP `upload_file`, which sends extracted text and no
 *      original) — we serve that text as a `.txt` attachment with a clear filename,
 *      so the download is never empty and never masquerades as a binary original.
 */

/** True when the name already carries a plain-text extension. */
function isTextName(name: string): boolean {
  return /\.(txt|md|csv|tsv|json|log)$/i.test(name);
}

/**
 * The filename for a TEXT-ONLY download. Keeps the original name when it is already
 * textual; otherwise appends `.txt` (e.g. `report.pdf` → `report.pdf.txt`) so the
 * user sees plainly that this is the extracted text, not the original binary.
 */
export function textDownloadName(name: string): string {
  const base = (name || 'file').trim() || 'file';
  return isTextName(base) ? base : `${base}.txt`;
}

/** Strip characters that would break a `Content-Disposition` filename value. */
export function safeDispositionName(name: string): string {
  return (name || 'file').replace(/"/g, "'").replace(/[\r\n]/g, '');
}

/**
 * The body served for a genuinely-empty record (no stored object AND no extracted
 * text). We still return a non-empty, honest note rather than a 0-byte file.
 */
export function absentOriginalNote(name: string): string {
  return (
    `No downloadable content is stored for "${name}".\n\n` +
    `This file record has neither an original object nor extracted text. ` +
    `Re-upload the file from the Files tab to store its original bytes.\n`
  );
}
