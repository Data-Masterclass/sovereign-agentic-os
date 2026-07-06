/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/files/server';
import { getFile } from '@/lib/files/store';
import { getBlob } from '@/lib/files/object-store';
import '@/lib/files/object-store-server'; // registers the durable MinIO backend
import { textDownloadName, safeDispositionName, absentOriginalNote } from '@/lib/files/download';

export const dynamic = 'force-dynamic';

/**
 * GET /api/files/[id]/download
 *
 * Streams the file for download. Governance: the `getFile(id, user)` canView / DLS
 * check is enforced first — only a principal who may SEE the file may download it; a
 * non-viewer gets a 403 and the route never reveals whether the file exists.
 *
 * Body source, in order:
 *   1. The ORIGINAL object from the blob store (UI uploads) — byte-for-byte, with its
 *      real content-type and `filename="<name>"`.
 *   2. Otherwise the extracted TEXT (MCP text-only records) — served as a `.txt`
 *      attachment with a clear name, never an empty body.
 *   3. Otherwise a short honest note (genuinely-absent original) — still non-empty.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    // canView gate: 403 if the caller may not read this file.
    const view = getFile(id, user);
    const name = view.asset.name;

    // 1) Original bytes stored (UI upload) → stream them byte-for-byte.
    if (view.object) {
      const blob = await getBlob(view.object.key);
      if (blob) {
        return new NextResponse(blob.body as unknown as BodyInit, {
          status: 200,
          headers: {
            'Content-Type': view.object.contentType || blob.contentType || 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${safeDispositionName(name)}"`,
            'Content-Length': String(blob.body.byteLength),
            'Cache-Control': 'no-store',
          },
        });
      }
      // Object recorded but bytes missing (e.g. a wiped store): fall through to text.
    }

    // 2) Text-only record → serve the extracted text as a .txt attachment.
    if (view.text && view.text.length > 0) {
      const dlName = textDownloadName(name);
      return new NextResponse(view.text, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${safeDispositionName(dlName)}"`,
          'Content-Length': String(Buffer.byteLength(view.text, 'utf8')),
          'Cache-Control': 'no-store',
        },
      });
    }

    // 3) Genuinely absent — never a 0-byte file; return an honest note.
    const note = absentOriginalNote(name);
    return new NextResponse(note, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeDispositionName(textDownloadName(name))}"`,
        'Content-Length': String(Buffer.byteLength(note, 'utf8')),
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
