/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/files/server';
import { getFile } from '@/lib/files/store';
import { getBlob } from '@/lib/files/object-store';
import '@/lib/files/object-store-server'; // registers the durable MinIO backend
import { safeDispositionName } from '@/lib/files/download';

export const dynamic = 'force-dynamic';

/**
 * GET /api/files/[id]/raw
 *
 * Streams the ORIGINAL bytes for INLINE rendering (Quick Look) — the enabler for the
 * file-preview viewer (<img> / <iframe pdf> / <video> / <audio>). It reuses the EXACT
 * governance gate as /download (`getFile(id, user)` canView / DLS): only a principal
 * who may SEE the file gets bytes; a non-viewer gets a 403 and the route never reveals
 * whether the file exists.
 *
 * The one difference from /download is `Content-Disposition: inline` (so the browser
 * renders in-page instead of downloading) with the real Content-Type. If there are no
 * original bytes (text-only MCP records), there is nothing to render inline → 404; the
 * viewer falls back to the extracted-text block, and Download still works.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    // canView gate: 403 if the caller may not read this file.
    const view = getFile(id, user);
    const name = view.asset.name;

    if (view.object) {
      const blob = await getBlob(view.object.key);
      if (blob) {
        return new NextResponse(blob.body as unknown as BodyInit, {
          status: 200,
          headers: {
            'Content-Type': view.object.contentType || blob.contentType || 'application/octet-stream',
            'Content-Disposition': `inline; filename="${safeDispositionName(name)}"`,
            'Content-Length': String(blob.body.byteLength),
            'Cache-Control': 'no-store',
          },
        });
      }
    }

    // No original bytes to render inline → the viewer uses the extracted-text fallback.
    return NextResponse.json({ error: 'No inline preview available' }, { status: 404 });
  } catch (e) {
    return errorResponse(e);
  }
}
