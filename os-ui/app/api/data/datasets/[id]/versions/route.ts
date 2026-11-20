/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/data/lib/server';
import type { Layer } from '@tabs/data/lib/dataset-schema';
import { VersionTableError } from '@tabs/data/lib/dataset-versions';
import { VersionInputError } from '@tabs/data/lib/iceberg-sql';
import { authorize } from '@core/infra/governed';
import {
  datasetVersionsLive, diffDatasetDataLive, nameDatasetVersionLive, rollbackDatasetLive,
} from '@tabs/data/lib/dataset-versions-server';

export const dynamic = 'force-dynamic';

/**
 * A dataset's versions ARE its Iceberg table's snapshots (WP-37, design 06 §5.6). Nothing is
 * stored by the OS: every answer is read from the table's `$snapshots` / `$refs` as the caller.
 * The dataset's DEFINITION history is git (`get_history` / `get_version` / `diff_versions`).
 *
 *   GET ?layer=                          → snapshots (newest first) with the tags/branches on each
 *   POST { action: 'restore', snapshotId } → `rollback_to_snapshot` (edit-scoped)
 *   POST { action: 'tag'|'branch', snapshotId, name } → an Iceberg tag or branch (edit-scoped)
 *   POST { action: 'diff', from, to }    → rows added/removed between two versions (view-scoped)
 */
const LAYERS = new Set(['bronze', 'silver', 'gold']);
const layerOf = (v: unknown): Layer | undefined => (typeof v === 'string' && LAYERS.has(v) ? (v as Layer) : undefined);

function typed(e: unknown): NextResponse | null {
  if (e instanceof VersionTableError) return NextResponse.json({ error: e.message, code: e.code, ...e.detail }, { status: e.status });
  if (e instanceof VersionInputError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  return null;
}

export const GET = withRoute<{ id: string }>(async ({ user, params, req }) => {
  try {
    const layer = layerOf(new URL(req.url).searchParams.get('layer'));
    return NextResponse.json({ ...(await datasetVersionsLive(params.id, user, layer)), source: 'iceberg' });
  } catch (e) {
    const r = typed(e);
    if (r) return r;
    throw e;
  }
}, { gate: requirePrincipal as () => Promise<CurrentUser> });

type Body = { action?: string; snapshotId?: unknown; name?: unknown; from?: unknown; to?: unknown; layer?: unknown; limit?: unknown };

export const POST = withRoute<{ id: string }, Body>(async ({ user, params, body }) => {
  const layer = layerOf(body.layer);
  // OPA first (default-deny): the same governed data-tool grant `query_data` checks; the write
  // path then re-gates schema and role (query-tool guard / data-runner floor).
  const principal = user.domains[0] ?? user.id;
  const authz = await authorize(principal, 'query');
  if (!authz.allowed) return NextResponse.json({ error: `OPA denied ${principal} → query (${authz.policy})` }, { status: 403 });
  try {
    switch (body.action) {
      case 'restore':
        return NextResponse.json({ ...(await rollbackDatasetLive(params.id, user, { snapshotId: body.snapshotId, layer })), source: 'iceberg' });
      case 'tag':
      case 'branch':
        return NextResponse.json({ ...(await nameDatasetVersionLive(params.id, user, { snapshotId: body.snapshotId, name: body.name, kind: body.action, layer })), source: 'iceberg' });
      case 'diff':
        return NextResponse.json({ ...(await diffDatasetDataLive(params.id, user, { from: body.from, to: body.to, layer, limit: Number(body.limit) || undefined })), source: 'iceberg' });
      default:
        return NextResponse.json({ error: "action must be 'restore', 'tag', 'branch' or 'diff'" }, { status: 400 });
    }
  } catch (e) {
    const r = typed(e);
    if (r) return r;
    throw e;
  }
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
