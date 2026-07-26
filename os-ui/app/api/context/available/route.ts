/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { availableContext, availableContextWithFolders } from '@/lib/software/available-context';
import type { ContextKind } from '@/lib/core/context-grants';

export const dynamic = 'force-dynamic';

/**
 * TAB-AGNOSTIC available-artifacts feed for the core ContextGrants picker
 * (components/core/ContextGrants.tsx). Returns the artifacts of a given CONTEXT
 * KIND — connections · data · knowledge · files · metrics — the caller can
 * actually see, so ANY tab (Software today, Wave-2 tabs after) can browse + grant
 * rather than paste a raw id. Every item comes from the SAME canView/RLS-scoped
 * list the owning tab uses (personal + own-domain shared + marketplace), so it
 * never leaks another user's drafts or another domain's artifacts.
 *
 * The per-kind scoping now lives in `lib/software/available-context.ts` (one source
 * of truth shared with the governed Software assistant route, which grounds its grant
 * suggestions in the SAME list). This route is a thin, single-kind projection of it.
 *
 * Response: `{ items: [{ id, name, scope, folder? }] }`. Add `&folders=1` to also
 * receive `{ folders: [{ path, scope }] }` for foldered kinds (data · knowledge ·
 * files), so the caller can offer folder-OR-item grant selection via FolderTree.
 */
const KINDS: ContextKind[] = ['connections', 'data', 'knowledge', 'files', 'metrics'];

export const GET = withRoute(async ({ user, req }) => {
  const url = new URL(req.url);
  const kind = url.searchParams.get('kind') as ContextKind | null;
  if (!kind || !KINDS.includes(kind)) {
    return NextResponse.json({ error: `kind must be one of: ${KINDS.join(', ')}` }, { status: 400 });
  }
  if (url.searchParams.get('folders') === '1') {
    const { items, folders } = await availableContextWithFolders(user, [kind]);
    return NextResponse.json({ items: items[kind] ?? [], folders: folders[kind] ?? [] });
  }
  const map = await availableContext(user, [kind]);
  return NextResponse.json({ items: map[kind] ?? [] });
}, { defaultStatus: 500 });
