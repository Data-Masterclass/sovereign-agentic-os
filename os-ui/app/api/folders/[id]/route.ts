/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { ensureHydrated, getFolder } from '@/lib/folders';
import { moveFolder, archiveFolder, restoreFolder, deleteFolder } from '@/lib/folders/folder-lifecycle';
// Registering the adapters is a prerequisite for the member-item cascade.
import '@/lib/folders/adapters';

/**
 * One folder row's LIFECYCLE — move / archive / restore / (physical) delete, each a
 * CASCADE that reparents/archives/deletes the folder rows AND their member items via
 * the shared `ArtifactAdapter` (one primitive, every tab identical). The tab is read
 * from the folder ROW itself (`getFolder(id).tab`) so this one route serves Files,
 * Data, Knowledge and Metrics without a per-tab handler.
 *
 *   PATCH  /api/folders/:id  { path }                        → move (rows + items)
 *   POST   /api/folders/:id  { action: 'archive'|'restore' } → archive/restore cascade
 *   DELETE /api/folders/:id                                  → physical delete (archived-only)
 *
 * Runs AS the signed-in user; every op is edit-scoped + the item cascade is fail-closed,
 * so a non-owner without domain authority gets a 403 and nothing is written.
 */
export const dynamic = 'force-dynamic';

/** Resolve the tab a folder row belongs to (the adapter key for its cascade). */
function tabOf(id: string): string {
  const node = getFolder(id);
  if (!node) {
    const e = new Error('Folder not found') as Error & { status: number };
    e.status = 404;
    throw e;
  }
  return node.tab;
}

export const PATCH = withRoute<{ id: string }, { path?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  if (!body.path || !String(body.path).trim()) {
    return NextResponse.json({ error: 'a new path is required' }, { status: 400 });
  }
  const folder = moveFolder(user, tabOf(id), id, String(body.path));
  return NextResponse.json({ folder });
}, { parse: true, hydrate: ensureHydrated });

export const POST = withRoute<{ id: string }, { action?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  const tab = tabOf(id);
  if (body.action === 'archive') {
    const rows = archiveFolder(user, tab, id);
    return NextResponse.json({ ok: true, archived: rows.map((r) => r.id) });
  }
  if (body.action === 'restore') {
    const rows = restoreFolder(user, tab, id);
    return NextResponse.json({ ok: true, restored: rows.map((r) => r.id) });
  }
  return NextResponse.json({ error: "action must be 'archive' or 'restore'" }, { status: 400 });
}, { parse: true, hydrate: ensureHydrated });

export const DELETE = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const result = deleteFolder(user, tabOf(id), id);
  return NextResponse.json({ ok: true, ...result });
}, { hydrate: ensureHydrated });
