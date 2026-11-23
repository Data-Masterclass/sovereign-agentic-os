/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/data/lib/server';
import { moveDataset } from '@tabs/data/lib/store';
import { folderRowWarning, type EnsureFolderResult } from '@core/folders/index';

export const dynamic = 'force-dynamic';

/**
 * Move a dataset into a folder. Runs AS the signed-in user; `moveDataset` is edit-scoped
 * in the store (owner, in-domain domain_admin, or admin), so a viewer is rejected 403 and
 * nothing is written. The move also upserts an explicit folder row in the governed
 * registry, so the destination folder persists even when empty. The Data grid's single-
 * and multi-select "Move to folder…" both hit this route.
 *
 *   POST /api/data/datasets/:id/folder  { folder }  → move the dataset
 */
export const POST = withRoute<{ id: string }, { folder?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  if (typeof body.folder !== 'string') {
    return NextResponse.json({ error: 'a folder path is required' }, { status: 400 });
  }
  let folderRow: EnsureFolderResult | undefined;
  const dataset = moveDataset(id, user, body.folder, (r) => { folderRow = r; }); // 403 → nothing written
  return NextResponse.json({ dataset, ...(folderRowWarning(folderRow) ? { folderWarning: folderRowWarning(folderRow) } : {}) });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
