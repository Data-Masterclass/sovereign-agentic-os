/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/files/server';
import { listFiles, createFile, type UploadInput } from '@/lib/files/store';
import { reindexFile } from '@/lib/files/pipeline-server';
import type { Sensitivity, Storage } from '@/lib/files/asset-schema';

export const dynamic = 'force-dynamic';

/** The file browser: GET lists the user's drive (mine/domain/marketplace + facets);
 *  POST uploads a new file into the governed object store (a private file at v1). */
export async function GET() {
  try {
    const user = await requirePrincipal();
    return NextResponse.json(listFiles(user));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requirePrincipal();
    const body = (await req.json().catch(() => ({}))) as Partial<UploadInput> & {
      name?: string; sensitivity?: Sensitivity; storage?: Storage;
    };
    if (!body.name || !body.name.trim()) {
      return NextResponse.json({ error: 'a file needs a name' }, { status: 400 });
    }
    const asset = createFile(user, {
      name: body.name,
      folder: body.folder,
      tags: body.tags,
      sensitivity: body.sensitivity,
      storage: body.storage,
      text: body.text,
      bytes: body.bytes,
      provenanceSource: body.provenanceSource,
      sourceUri: body.sourceUri,
    });
    // Auto-index: ingest-by-type → chunk+hash → embed → hybrid index (Processing →
    // Searchable ✓). Best-effort; the adapters self-fall-back to their mocks offline.
    await reindexFile(asset, body.text ?? '');
    return NextResponse.json({ asset }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
