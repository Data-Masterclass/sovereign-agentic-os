/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getCatalogSnapshot, refreshCatalogSnapshot } from '@/lib/connections/warehouse/catalog-snapshot';
import { markDatasetsDrifted } from '@/lib/data/store';
import { addNotification } from '@/lib/notifications/store';

export const dynamic = 'force-dynamic';

/**
 * GET the cached catalog snapshot (no discovery) — null when none exists yet, so the UI
 * offers a Refresh. The snapshot always carries its own `takenAt`/`status`, shown as
 * "snapshot from <takenAt>" — never fabricated freshness.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  return NextResponse.json({ snapshot: await getCatalogSnapshot(params.id, user) });
}, { defaultStatus: 500 });

/** POST refreshes the snapshot: `SHOW SCHEMAS` + per-schema `SHOW TABLES` through the
 *  governed path AS the connection's domain, diffed against the previous snapshot. When the
 *  diff REMOVED a table an adopted live dataset is bound to, that dataset is flagged
 *  `drifted` (still readable, warned) and its owner notified — drift surfaced honestly. */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const snapshot = await refreshCatalogSnapshot(params.id, user);
  if (snapshot.prevDiff.removed.length > 0) {
    const drifted = markDatasetsDrifted(params.id, snapshot.prevDiff.removed);
    for (const ds of drifted) {
      addNotification({
        userId: ds.owner,
        kind: 'alert',
        title: 'A connected dataset’s source table changed',
        body: `The source table behind “${ds.name}” was removed or renamed in the latest catalog snapshot. It is flagged as drifted — check the Source stage and re-adopt if the table moved.`,
      });
    }
  }
  return NextResponse.json({ snapshot });
}, { defaultStatus: 500 });
