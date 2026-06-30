/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/files/server';
import {
  getFile, moveFile, setDocs, setSensitivity, setIndexingMode, deleteFile,
} from '@/lib/files/store';
import { reindexById } from '@/lib/files/pipeline-server';
import { removeFromIndex } from '@/lib/files/index-store';
import type { IndexingMode, Sensitivity } from '@/lib/files/asset-schema';

export const dynamic = 'force-dynamic';

/** GET one file (envelope + preview text + version history). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    return NextResponse.json(getFile(id, user));
  } catch (e) {
    return errorResponse(e);
  }
}

type Patch = {
  folder?: string;
  tags?: string[];
  description?: string;
  sensitivity?: Sensitivity;
  indexing?: IndexingMode;
};

/** Edit the single source: move / retag / document / sensitivity / index opt-out.
 *  Each field maps to its own store mutator (the store re-clamps invariants). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Patch;
    let asset = getFile(id, user).asset;
    if (body.folder !== undefined) asset = moveFile(id, user, body.folder);
    if (body.sensitivity !== undefined) asset = setSensitivity(id, user, body.sensitivity);
    if (body.indexing !== undefined) asset = setIndexingMode(id, user, body.indexing);
    if (body.description !== undefined || body.tags !== undefined) {
      // setDocs writes the promotion-minimum docs (description + tags together).
      asset = setDocs(id, user, { description: body.description, tags: body.tags });
    }
    // Re-index: sensitivity/index-opt-out/tags/folder change the indexed metadata
    // (or remove the file from the index when it becomes stored-only).
    await reindexById(id);
    return NextResponse.json({ asset });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    deleteFile(id, user);
    removeFromIndex(id); // drop its chunks from the hybrid index
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
