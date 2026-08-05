/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/files/server';
import {
  getFile, moveFile, setDocs, setSensitivity, setIndexingMode, deleteFile,
  archiveFile, unarchiveFile, renameFile,
} from '@/lib/files/store';
import { reindexById } from '@/lib/files/pipeline-server';
import { removeFromIndex } from '@/lib/files/index-store';
import { purgeFileObjects } from '@/lib/files/physical-delete';
import { deleteBlob } from '@/lib/files/object-store';
import '@/lib/files/object-store-server'; // registers the durable MinIO backend
import type { IndexingMode, Sensitivity } from '@/lib/files/asset-schema';
import { appSlugFromRequest, checkAppGrant } from '@/lib/software/app-origin';

export const dynamic = 'force-dynamic';

/** GET one file (envelope + preview text + version history). */
export const GET = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const { id } = params;
  // LEAST-PRIVILEGE for app origins: a deployed app may only read a file it was
  // granted. Non-app requests (the OS UI) skip this (appSlugFromRequest → null).
  const slug = appSlugFromRequest(req);
  if (slug) {
    const check = await checkAppGrant(slug, 'files', id);
    if (!check.allowed) return NextResponse.json({ error: check.reason }, { status: 403 });
  }
  return NextResponse.json(getFile(id, user));
}, { gate: requirePrincipal as () => Promise<CurrentUser> });

type Patch = {
  name?: string;
  folder?: string;
  tags?: string[];
  description?: string;
  sensitivity?: Sensitivity;
  indexing?: IndexingMode;
};

/** Edit the single source: move / retag / document / sensitivity / index opt-out.
 *  Each field maps to its own store mutator (the store re-clamps invariants). */
export const PATCH = withRoute<{ id: string }, Patch>(async ({ user, params, body }) => {
  const { id } = params;
  let asset = getFile(id, user).asset;
  if (body.name !== undefined) asset = renameFile(id, user, body.name);
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
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });

/**
 * POST → file lifecycle: `archive` (reversible soft-hide) or `unarchive`.
 * Edit-scoped in the store (owner or in-domain Admin), so a viewer is rejected 403.
 */
export const POST = withRoute<{ id: string }, { action?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  switch (body.action) {
    case 'archive':
      return NextResponse.json({ file: archiveFile(id, user) });
    case 'unarchive':
      return NextResponse.json({ file: unarchiveFile(id, user) });
    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });

/**
 * DELETE → permanently remove a file (edit-scoped; confirmed in the UI) — the
 * registry record, its index chunks AND its object-store bytes. The record delete
 * runs first (403 → nothing is purged); then the PHYSICAL bytes are purged through
 * the same governed blob backend the upload/download path uses. An unreachable store
 * surfaces in `physical[].ok:false` — the delete stands, the leftover is never silent.
 */
export const DELETE = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const rec = deleteFile(id, user); // throws 403 → nothing is purged
  removeFromIndex(id); // drop its chunks from the hybrid index
  const physical = await purgeFileObjects(rec, deleteBlob);
  return NextResponse.json({ ok: true, physical });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
