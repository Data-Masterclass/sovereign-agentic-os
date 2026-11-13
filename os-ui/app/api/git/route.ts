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
  isGitObjectKind,
  GIT_OBJECT_KINDS,
  GIT_OBJECT_LAYOUT,
  type GitObjectKind,
} from '@core/infra/git-objects';
import { repoSummaries } from '@core/infra/git-store';
import { mirrorSignals } from '@core/infra/git-mirror';

export const dynamic = 'force-dynamic';

/**
 * The generic git surface the shared badge, history drawer and Governance → Repositories read.
 * Thin: every answer comes from `core/infra/git-objects.ts` (owner/scope-gated, one `not_found`
 * for an object the caller cannot see) or, for the operator view, from the git store's own
 * summaries plus the existing mirror health record. No logic lives here — a route is a shell.
 *
 * GET ?action=history|version|diff|releases&kind=&id=[&sha=|&shaA=&shaB=] → one object's versioning
 * GET ?action=repos                                              → every domain repo (builder+)
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
    // The operator view: which repositories exist, where their head is, and whether the mirror
    // is healthy. Builder+ because it spans the tenant's domains, and it carries no file content.
    if (!roleAtLeast(user.role, 'builder')) {
      return NextResponse.json({ error: 'Repositories needs the builder role or higher' }, { status: 403 });
    }
    const mirrors = new Map(mirrorSignals().map((m) => [m.domain, m]));
    const repos = (await repoSummaries()).map((r) => ({ ...r, mirror: mirrors.get(r.domain) ?? null }));
    return NextResponse.json({
      repos,
      layout: GIT_OBJECT_KINDS.map((k) => ({
        kind: k,
        label: GIT_OBJECT_LAYOUT[k].label,
        paths: GIT_OBJECT_LAYOUT[k].paths,
        personalLane: GIT_OBJECT_LAYOUT[k].personalLane,
        writer: GIT_OBJECT_LAYOUT[k].writer,
      })),
    });
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
