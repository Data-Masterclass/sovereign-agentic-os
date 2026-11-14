/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { roleAtLeast } from '@core/kernel/session';
import {
  objectGitInfo,
  objectReleases,
  getVersion,
  diffVersions,
  restoreVersion,
  restorableGitObjectKinds,
  repositoriesOverview,
  repositoryCommitLog,
  isGitObjectKind,
  GIT_OBJECT_KINDS,
  type GitObjectKind,
} from '@core/infra/git-objects';

export const dynamic = 'force-dynamic';

/**
 * The generic git surface the shared badge, history drawer and Governance → Repositories read.
 * Thin: every answer comes from `core/infra/git-objects.ts` (owner/scope-gated, one `not_found`
 * for an object the caller cannot see) or, for the operator view, from the git store's own
 * summaries plus the existing mirror health record. No logic lives here — a route is a shell.
 *
 * GET ?action=history|version|diff|releases&kind=&id=[&sha=|&shaA=&shaB=] → one object's versioning
 * GET ?action=repos                                              → every domain repo (ADMIN)
 * GET ?action=repolog&domain=                                    → one repo's commit log (ADMIN)
 * POST {kind, id, sha}                                           → restore, through the writer
 */
function kindOf(value: string | null): GitObjectKind {
  if (!value || !isGitObjectKind(value)) {
    const e = new Error(`kind must be one of ${GIT_OBJECT_KINDS.join(', ')}`) as Error & { status?: number };
    e.status = 400;
    throw e;
  }
  return value;
}

export const GET = withRoute(async ({ user, req }) => {
  const url = new URL(req.url);
  const action = url.searchParams.get('action') ?? 'history';

  if (action === 'repos') {
    // THE OPERATOR-SURFACE RULE (review H-2): this listing is TENANT-WIDE and unscoped by domain,
    // and it carries mirror URLs and push errors — the same material Platform → Components shows
    // only to an admin. So it is ADMIN, exactly like that route, rather than builder+.
    if (!roleAtLeast(user.role, 'admin')) {
      return NextResponse.json({ error: 'Repositories is admin-only: it spans every domain and carries mirror URLs and push errors' }, { status: 403 });
    }
    return NextResponse.json(await repositoriesOverview());
  }

  if (action === 'repolog') {
    // ADMIN for the same reason, and the module applies the SECOND gate: a row appears only when
    // its `OS-Object` resolves to an object this caller may see.
    if (!roleAtLeast(user.role, 'admin')) {
      return NextResponse.json({ error: "The repository commit log is admin-only: it spans every domain and names each commit's object" }, { status: 403 });
    }
    const domain = (url.searchParams.get('domain') ?? '').trim();
    if (!domain) return NextResponse.json({ error: 'domain is required' }, { status: 400 });
    const limit = Number(url.searchParams.get('limit') ?? '');
    return NextResponse.json(await repositoryCommitLog(user, domain, Number.isFinite(limit) && limit > 0 ? { limit } : {}));
  }

  const kind = kindOf(url.searchParams.get('kind'));
  const id = (url.searchParams.get('id') ?? '').trim();
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  if (action === 'releases') {
    return NextResponse.json(await objectReleases(user, kind, id));
  }
  if (action === 'version') {
    const sha = (url.searchParams.get('sha') ?? '').trim();
    return NextResponse.json(await getVersion(user, kind, id, sha));
  }
  if (action === 'diff') {
    const shaA = (url.searchParams.get('shaA') ?? '').trim();
    const shaB = (url.searchParams.get('shaB') ?? '').trim();
    return NextResponse.json(await diffVersions(user, kind, id, shaA, shaB));
  }
  const limit = Number(url.searchParams.get('limit') ?? '');
  const info = await objectGitInfo(user, kind, id, Number.isFinite(limit) && limit > 0 ? { limit } : {});
  // `restorable` is a server fact (has this kind's tab registered its writer?), so the drawer
  // shows a refusal rather than a button that cannot work.
  return NextResponse.json({ ...info, restorable: restorableGitObjectKinds().includes(kind) });
});

export const POST = withRoute<Record<string, string>, { kind?: string; id?: string; sha?: string }>(
  async ({ user, body }) => {
    const kind = kindOf(body.kind ?? null);
    const id = (body.id ?? '').trim();
    const sha = (body.sha ?? '').trim();
    if (!id || !sha) return NextResponse.json({ error: 'kind, id and sha are required' }, { status: 400 });
    return NextResponse.json(await restoreVersion(user, kind, id, sha));
  },
  { parse: true },
);
