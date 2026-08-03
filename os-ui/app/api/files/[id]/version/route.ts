/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/files/server';
import { addVersion, attachObject, objectKeyForAsset, getFile } from '@/lib/files/store';
import { putBlob } from '@/lib/files/object-store';
import '@/lib/files/object-store-server'; // registers the durable MinIO backend
import { reindexById } from '@/lib/files/pipeline-server';

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
 */
export const POST = withRoute<{ id: string }, { text?: string; bytes?: number; rewriteBytes?: boolean }>(async ({ user, params, body }) => {
  const { id } = params;
  const asset = addVersion(id, user, { text: body.text, bytes: body.bytes });
  // Inline text edit of a file with stored original bytes → re-write those bytes from
  // the new text so /raw and /download never fall out of step with the reader.
  if (body.rewriteBytes && typeof body.text === 'string') {
    const view = getFile(id, user); // canView; object present iff bytes are stored
    const key = view.object ? objectKeyForAsset(asset) : null;
    if (key) {
      const contentType = view.object?.contentType || 'text/plain; charset=utf-8';
      const bytes = Buffer.from(body.text, 'utf8');
      await putBlob(key, bytes, contentType);
      attachObject(id, user, { contentType, bytes: bytes.length });
    }
  }
  await reindexById(id); // re-index only the changed chunks (content-hash cache)
  return NextResponse.json({ asset });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
