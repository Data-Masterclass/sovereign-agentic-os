/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import {
  ensureHydrated,
  listFolders,
  createFolder,
  type FolderTab,
  type FolderScope,
} from '@/lib/folders';

/**
 * The folder registry API. Runs AS the signed-in user (`requireUser`); every
 * mutation is edit-scoped in the store via `canManageArtifact`, so a caller who
 * lacks authority gets a 403 and nothing is written.
 *
 *   GET  /api/folders?tab=files&scope=personal  → the caller's folders in a scope
 *   POST /api/folders  { tab, scope, path, domain? }  → create a folder row
 */
export const dynamic = 'force-dynamic';

const TABS: FolderTab[] = ['files', 'knowledge', 'data', 'metrics'];
const SCOPES: FolderScope[] = ['personal', 'domain'];

function readTab(v: string | null): FolderTab {
  return TABS.includes(v as FolderTab) ? (v as FolderTab) : 'files';
}
function readScope(v: string | null): FolderScope {
  return SCOPES.includes(v as FolderScope) ? (v as FolderScope) : 'personal';
}

export const GET = withRoute(async ({ user, req }) => {
  const url = new URL(req.url);
  const tab = readTab(url.searchParams.get('tab'));
  const scope = readScope(url.searchParams.get('scope'));
  const includeArchived = url.searchParams.get('archived') === '1';
  // Narrow the folder tree to the active domain so switching domain diverges the rail.
  const activeDomain = (user as { activeDomain?: string | null }).activeDomain ?? null;
  return NextResponse.json({ folders: listFolders(user, tab, scope, { includeArchived, activeDomain }) });
}, { hydrate: ensureHydrated });

export const POST = withRoute<Record<string, string>, {
  tab?: string;
  scope?: string;
  path?: string;
  domain?: string;
}>(async ({ user, body }) => {
  if (!body.path || !String(body.path).trim()) {
    return NextResponse.json({ error: 'a folder needs a path' }, { status: 400 });
  }
  // For personal-scope creation, stamp the active domain (not the arbitrary first domain)
  // so the new folder lands under the domain the user is operating in.
  const activeDomain = (user as { activeDomain?: string | null }).activeDomain ?? null;
  const scope = readScope(body.scope ?? null);
  const domain = body.domain ?? (scope === 'personal' && activeDomain ? activeDomain : undefined);
  const folder = createFolder(user, {
    tab: readTab(body.tab ?? null),
    scope,
    path: String(body.path),
    domain,
  });
  return NextResponse.json({ folder }, { status: 201 });
}, { parse: true, hydrate: ensureHydrated });
