/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { apiError, withRoute } from '@core/kernel/route-server';
import { moveAgentSystem, ensureHydrated } from '@tabs/agents/lib/store';
import { folderRowWarning, type EnsureFolderResult } from '@core/folders/index';

export const dynamic = 'force-dynamic';

/**
 * Move an agent system into a folder. Runs AS the signed-in user; `moveAgentSystem` is
 * edit-scoped in the store (owner, in-domain domain_admin, or admin), so a viewer is
 * rejected 403 and nothing is written. The move also upserts an explicit folder row in
 * the governed registry, so the destination folder persists even when empty. The Agents
 * list's single- and multi-select "Move to folder…" both hit this route.
 *
 *   POST /api/agents/systems/:id/folder  { folder }  → move the system
 */
export const POST = withRoute<{ id: string }, { folder?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  if (typeof body.folder !== 'string') {
    return apiError(400, 'a folder path is required', 'agents.folderPathRequired');
  }
  let folderRow: EnsureFolderResult | undefined;
  const system = moveAgentSystem(id, user, body.folder, (r) => { folderRow = r; }); // 403 → nothing written
  // The move stands; a folder that could not be added to the list is said, not hidden.
  return NextResponse.json({ system, ...(folderRowWarning(folderRow) ? { folderWarning: folderRowWarning(folderRow) } : {}) });
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });
