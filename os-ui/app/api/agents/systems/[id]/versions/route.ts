/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import {
  ensureHydrated,
  listSystemVersions,
  restoreSystemVersion,
  getSystemForEdit,
  applyRestoredYaml,
} from '@/lib/agents/store';
import { realForgejo } from '@/lib/agents/build/live-clients';
import { buildSystem } from '@/lib/agents/build/server';
import {
  listGitVersions,
  restoreGitVersion,
  shaForVersion,
  systemRepo,
} from '@/lib/git-versioning';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * Version history for one agent system — GIT-backed (Forgejo commit log) when the
 * system has a repo Forgejo can reach, else the snapshot versionLog fallback.
 *
 *   GET          → the versions (newest first; view-scoped). `source` says which
 *                  backing answered ('git' or 'snapshot') — honest, never faked.
 *   POST {version} → restore a prior build. Git restore RE-COMMITS the prior
 *                    commit's files onto HEAD (a new, auditable "restore of <sha>"
 *                    commit — never a destructive reset), then reloads the runtime
 *                    like the Build path; else the snapshot restore.
 *
 * The `{ version, at, author, summary }` shape + numeric `{ version }` restore
 * contract is IDENTICAL to the snapshot route, so the VersionHistory UI is unchanged.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const { id } = await ctx.params;

    // Git primary: only for a caller who can edit (the repo + its history is the
    // system's source of truth). A viewer still gets the snapshot list below.
    let git: Awaited<ReturnType<typeof listGitVersions>> = null;
    try {
      const view = getSystemForEdit(id, user);
      void view; // edit-scope check; a viewer throws 403 → snapshot fallback path
      git = await listGitVersions(realForgejo(), systemRepo(id));
    } catch (e) {
      // A 403 (viewer) is a real permission answer — re-throw it. Any other error
      // (Forgejo unreachable) falls through to the snapshot log honestly.
      if ((e as { status?: number })?.status === 403) return fail(e);
    }
    if (git) {
      return NextResponse.json({ versions: git, source: 'git' });
    }

    const list = listSystemVersions(id, user).map((v) => ({
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

    // Git primary: resolve the version index → commit sha against the CURRENT
    // history, re-commit that build's files onto HEAD, apply the restored yaml to
    // the live record, then reload the runtime via the Build path.
    const forgejo = realForgejo();
    let sha: string | null = null;
    try {
      getSystemForEdit(id, user); // edit-scope before any side effect
      sha = await shaForVersion(forgejo, systemRepo(id), body.version);
    } catch (e) {
      if ((e as { status?: number })?.status === 403) return fail(e);
    }
    if (sha) {
      const { yaml } = await restoreGitVersion(forgejo, systemRepo(id), sha, user.id);
      const rec = applyRestoredYaml(id, user, yaml, `restore of ${sha.slice(0, 8)}`);
      // Reload the runtime from the restored source (best-effort — falls back to the
      // offline mock when no cluster; never blocks the restore).
      try {
        await buildSystem(id, yaml);
      } catch {
        /* reload is best-effort; the restore itself already succeeded */
      }
      return NextResponse.json({ id: rec.id, updatedAt: rec.updatedAt, source: 'git', sha });
    }

    // Snapshot fallback: no git history / Forgejo unreachable.
    const rec = restoreSystemVersion(id, user, body.version);
    return NextResponse.json({ id: rec.id, updatedAt: rec.updatedAt, source: 'snapshot' });
  } catch (e) {
    return fail(e);
  }
}
