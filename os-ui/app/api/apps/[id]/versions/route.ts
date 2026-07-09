/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import {
  ensureHydrated,
  listAppVersions,
  restoreAppVersion,
  listAppGitVersions,
  restoreAppGitVersion,
} from '@/lib/apps';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * Version history for one app — GIT-backed (the app's Forgejo commit log) when the
 * repo has history Forgejo can reach, else the snapshot versionLog fallback.
 *
 *   GET          → the versions (newest first; view-scoped). `source` says which
 *                  backing answered ('git' or 'snapshot') — honest, never faked.
 *   POST {version} → restore a prior build. Git restore RE-COMMITS the prior
 *                    commit's files onto HEAD (a new, auditable "restore of <sha>"
 *                    commit — never a destructive reset); else the snapshot restore.
 *
 * The `{ version, at, author, summary }` shape + numeric `{ version }` restore
 * contract is IDENTICAL to the snapshot route, so the VersionHistory UI is unchanged.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const { id } = await ctx.params;

    // Git primary: the repo + its commit log is the app's source of truth. A null
    // (no history / Forgejo unreachable) falls through to the snapshot log honestly.
    const git = await listAppGitVersions(id, user);
    if (git) {
      return NextResponse.json({ versions: git, source: 'git' });
    }

    const list = (await listAppVersions(id, user)).map((v) => ({
      version: v.version,
      at: v.at,
      author: v.author,
      summary: v.summary,
    }));
    return NextResponse.json({ versions: list, source: 'snapshot' });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { version?: number };
    if (typeof body.version !== 'number') {
      return NextResponse.json({ error: 'A version number is required.' }, { status: 400 });
    }

    // Git primary: resolve the index → commit sha against the CURRENT history and
    // re-commit that build's files onto HEAD. A null (no git history) → snapshot.
    const restored = await restoreAppGitVersion(id, user, body.version);
    if (restored) {
      return NextResponse.json({ id: restored.app.id, updatedAt: restored.app.updatedAt, source: 'git', sha: restored.sha });
    }

    const app = await restoreAppVersion(id, user, body.version);
    return NextResponse.json({ id: app.id, updatedAt: app.updatedAt, source: 'snapshot' });
  } catch (e) {
    return fail(e);
  }
}
