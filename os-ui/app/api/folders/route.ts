/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import {
  ensureHydrated,
  listFolders,
  createFolder,
  type FolderTab,
  type FolderScope,
  type Principal,
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

async function principal(): Promise<Principal> {
  const u = await requireUser();
  await ensureHydrated();
  return { id: u.id, role: u.role, domains: u.domains };
}

function errorResponse(e: unknown): NextResponse {
  const status = (e as { status?: number }).status ?? 400;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

function readTab(v: string | null): FolderTab {
  return TABS.includes(v as FolderTab) ? (v as FolderTab) : 'files';
}
function readScope(v: string | null): FolderScope {
  return SCOPES.includes(v as FolderScope) ? (v as FolderScope) : 'personal';
}

export async function GET(req: Request) {
  try {
    const user = await principal();
    const url = new URL(req.url);
    const tab = readTab(url.searchParams.get('tab'));
    const scope = readScope(url.searchParams.get('scope'));
    const includeArchived = url.searchParams.get('archived') === '1';
    return NextResponse.json({ folders: listFolders(user, tab, scope, { includeArchived }) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const user = await principal();
    const body = (await req.json().catch(() => ({}))) as {
      tab?: string;
      scope?: string;
      path?: string;
      domain?: string;
    };
    if (!body.path || !String(body.path).trim()) {
      return NextResponse.json({ error: 'a folder needs a path' }, { status: 400 });
    }
    const folder = createFolder(user, {
      tab: readTab(body.tab ?? null),
      scope: readScope(body.scope ?? null),
      path: String(body.path),
      domain: body.domain,
    });
    return NextResponse.json({ folder }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
