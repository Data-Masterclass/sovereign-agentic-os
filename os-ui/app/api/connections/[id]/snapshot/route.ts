/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { getCatalogSnapshot, refreshCatalogSnapshot } from '@tabs/connections/lib/warehouse/catalog-snapshot';
import { markDatasetsDrifted } from '@tabs/data/lib/store';
import { addNotification } from '@core/notifications/store';
import { getUserLocale } from '@core/prefs/locale';
import { serverTextFor } from '@core/i18n/server-text';

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
      // Written in the OWNER's saved language (i18n wave 4); English is unchanged.
      const text = serverTextFor(await getUserLocale(ds.owner));
      addNotification({
        userId: ds.owner,
        kind: 'alert',
        title: text('notify.sourceDrift.title', undefined, 'A connected dataset’s source table changed'),
        body: text('notify.sourceDrift.body', { name: ds.name }, `The source table behind “${ds.name}” was removed or renamed in the latest catalog snapshot. It is flagged as drifted — check the Source stage and re-adopt if the table moved.`),
      });
    }
  }
  return NextResponse.json({ snapshot });
}, { defaultStatus: 500 });
