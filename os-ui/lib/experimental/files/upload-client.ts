/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * Shared client-side upload transport for the Files tab — used by BOTH the main
 * uploader (FilesBrowser) and "Re-upload (new version)" (FilePreview) so they behave
 * identically: real progress via XMLHttpRequest, and one friendly, retryable error
 * vocabulary (too large / incomplete / network). fetch()+FormData gives no progress,
 * so we use XHR directly.
 */

/** Fallback max upload size shown when the server gives no explicit limit (ingress is
 *  200 MB; if a 413 carries a JSON `maxMb` we prefer that). Mirrors the UI default. */
const DEFAULT_MAX_MB = 200;

const TIMEOUT_MS = 10 * 60 * 1000; // 10 min — large files over a slow link.

/** Turn a non-2xx XHR into a friendly, human error string (never rejects upstream). */
function friendlyError(xhr: XMLHttpRequest, label: string): string {
  let parsed: { error?: string; maxMb?: number } | null = null;
  try { parsed = JSON.parse(xhr.responseText) as { error?: string; maxMb?: number }; } catch { parsed = null; }
  // A 413, or a non-JSON body (e.g. an nginx 413 HTML page), both mean "too large".
  if (xhr.status === 413 || !parsed) {
    return `${label} is too large (max ${parsed?.maxMb ?? DEFAULT_MAX_MB} MB)`;
  }
  // The server's own message (e.g. the truncation/integrity guard: "upload
  // incomplete — received X of Y bytes; please retry") — surfaced verbatim.
  return parsed.error ?? `${label} failed to upload`;
}

/** Core XHR runner. Streams progress (0–99 during send, 100 on success) and resolves
 *  with a friendly error string or null — it NEVER rejects, so one bad item can't abort
 *  a batch. `label` names the item for error copy (the file name). */
function runXhr(
  url: string,
  body: XMLHttpRequestBodyInit,
  contentType: string,
  label: string,
  onPct: (pct: number) => void,
): Promise<string | null> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.timeout = TIMEOUT_MS;

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onPct(Math.min(99, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { onPct(100); resolve(null); return; }
      resolve(friendlyError(xhr, label));
    };
    // Network error / timeout / aborted (status 0) → a connection-oriented message.
    xhr.onerror = () => resolve(`${label} failed to upload — check your connection and try again.`);
    xhr.ontimeout = () => resolve(`${label} failed to upload — check your connection and try again.`);

    xhr.send(body);
  });
}

/**
 * Upload ONE file's RAW bytes to /api/files?upload=raw (the File IS the request body).
 * The server reads via req.arrayBuffer() — reliable for large bodies where undici's
 * formData() parser chokes — and runs the integrity guard against Content-Length.
 */
export function uploadRawFile(file: File, folder: string, onPct: (pct: number) => void): Promise<string | null> {
  const qs = new URLSearchParams({ upload: 'raw', name: file.name, folder });
  return runXhr(`/api/files?${qs.toString()}`, file, file.type || 'application/octet-stream', file.name, onPct);
}

/**
 * Re-upload as a NEW VERSION of an existing file. Keeps the current endpoint/semantics
 * (POST /api/files/[id]/version with JSON `{ text?, bytes }`), only swapping fetch for
 * the shared XHR transport so it shares the SAME progress + error vocabulary. `text` is
 * sent for text-like files so search/indexing stays in step (mirrors the old handler).
 */
export function reuploadVersion(
  id: string,
  file: File,
  text: string | undefined,
  onPct: (pct: number) => void,
): Promise<string | null> {
  const body = JSON.stringify({ text, bytes: file.size });
  return runXhr(`/api/files/${id}/version`, body, 'application/json', file.name, onPct);
}

/**
 * Save an INLINE text/markdown edit as a NEW VERSION. Goes through the SAME
 * /version endpoint, but sets `rewriteBytes` so the server ALSO re-writes the stored
 * ORIGINAL bytes from the edited text — keeping /raw, /download, the extracted text
 * and search all in step (never a split brain where the reader shows new text while
 * the download serves the old bytes). Returns a friendly error string or null.
 */
export function saveTextVersion(id: string, text: string, label = 'file'): Promise<string | null> {
  const body = JSON.stringify({ text, bytes: new TextEncoder().encode(text).length, rewriteBytes: true });
  return runXhr(`/api/files/${id}/version`, body, 'application/json', label, () => {});
}

/**
 * Create a NEW markdown note. There is no separate "note" storage — a note is just a
 * text/markdown file, so it rides the EXACT raw-upload path an uploaded file uses
 * (POST /api/files?upload=raw): the bytes are stored, the extracted text is kept (a
 * .md name is text-like), and it is indexed like any other file. Resolves with either
 * the created asset id (on success) or a friendly error string.
 */
export async function createNoteFile(
  name: string,
  markdown: string,
  folder: string,
): Promise<{ id: string } | { error: string }> {
  const safeName = /\.(md|markdown)$/i.test(name) ? name : `${name}.md`;
  const file = new File([markdown], safeName, { type: 'text/markdown' });
  const qs = new URLSearchParams({ upload: 'raw', name: safeName, folder });
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/files?${qs.toString()}`);
    xhr.setRequestHeader('Content-Type', 'text/markdown');
    xhr.timeout = TIMEOUT_MS;
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText) as { asset?: { id?: string } };
          if (data.asset?.id) { resolve({ id: data.asset.id }); return; }
        } catch { /* fall through to the generic error */ }
        resolve({ error: 'Note saved, but the server returned an unexpected response.' });
        return;
      }
      resolve({ error: friendlyError(xhr, name) });
    };
    xhr.onerror = () => resolve({ error: `${name} failed to save — check your connection and try again.` });
    xhr.ontimeout = () => resolve({ error: `${name} failed to save — check your connection and try again.` });
    xhr.send(file);
  });
}
