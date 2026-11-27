/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/files/lib/server';
import { addVersion, attachObject, getFile } from '@tabs/files/lib/store';
import { replaceFileBytes } from '@tabs/files/lib/blob-writes';
import '@tabs/files/lib/object-store-server'; // registers the durable MinIO backend
import { reindexById } from '@tabs/files/lib/pipeline-server';

export const dynamic = 'force-dynamic';

/**
 * Re-upload a file → bump its content version (drag-drop versioning), OR save an
 * INLINE text edit as a new version.
 *
 * `rewriteBytes` is the honesty flag for the inline text/markdown editor: a text-only
 * `addVersion` updates the extracted text (search + the Extracted-text render) but
 * leaves the stored ORIGINAL bytes untouched — which would leave /raw and /download
 * serving the OLD content while the reader sees the NEW text (a split brain). When the
 * caller edited the text of a file that HAS stored bytes, it sets `rewriteBytes: true`
 * so we ALSO re-write the object-store bytes from the same text, keeping /raw,
 * /download, the extracted text and the index all consistent.
 *
 * The bytes are written FIRST (edit-gated), the version recorded only after object storage
 * confirmed them: a failed write answers 503 `files.storageWriteFailed` and leaves the file —
 * its version, text and stored bytes — exactly as it was.
 */
export const POST = withRoute<{ id: string }, { text?: string; bytes?: number; rewriteBytes?: boolean }>(async ({ user, params, body }) => {
  const { id } = params;
  // Inline text edit of a file with stored original bytes → re-write those bytes from
  // the new text so /raw and /download never fall out of step with the reader.
  let rewritten: { contentType: string; bytes: number } | null = null;
  if (body.rewriteBytes && typeof body.text === 'string') {
    const view = getFile(id, user); // canView; object present iff bytes are stored
    if (view.object) {
      const contentType = view.object.contentType || 'text/plain; charset=utf-8';
      const bytes = Buffer.from(body.text, 'utf8');
      if (await replaceFileBytes(id, user, bytes, contentType)) rewritten = { contentType, bytes: bytes.length };
    }
  }
  const asset = addVersion(id, user, { text: body.text, bytes: body.bytes });
  if (rewritten) attachObject(id, user, rewritten);
  await reindexById(id, user.id); // A27 + re-index only the changed chunks (content-hash cache)
  return NextResponse.json({ asset });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
