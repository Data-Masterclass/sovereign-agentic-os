/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { roleAtLeast } from '@/lib/core/session';
import { runtimeTokenOk } from '@/lib/agents/build/runtime-auth';
import { listSnapshotableConnections } from '@/lib/connections/store';
import { refreshCatalogSnapshotService } from '@/lib/connections/warehouse/catalog-snapshot';

export const dynamic = 'force-dynamic';

/**
 * POST /api/connections/catalog-refresh — re-snapshot EVERY snapshotable connection's
 * catalog (the optional `connections.catalogRefresh` sweep; default OFF in the chart):
 * warehouse connections AND operational api-batch sources (Salesforce/Kajabi/OData/Workday),
 * whose entity catalog rides the same snapshot machinery via the operational registry (m5).
 * Mirrors the data-sync sweep: the shared agent-runtime bearer (service path) OR a
 * signed-in admin. Each refresh runs its discovery through the governed path AS the
 * connection's domain; an unreachable catalog/entity list records an honest snapshot
 * rather than failing the whole sweep.
 */
export async function POST(req: Request) {
  if (!runtimeTokenOk(req.headers.get('authorization'))) {
    try {
      const user = await requireUser();
      if (!roleAtLeast(user.role, 'admin')) {
        return NextResponse.json({ error: 'refreshing catalog snapshots requires an Administrator' }, { status: 403 });
      }
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
    }
  }

  const conns = await listSnapshotableConnections();
  const results: { connectionId: string; status: string; tables: number }[] = [];
  for (const c of conns) {
    try {
      const snap = await refreshCatalogSnapshotService(c);
      results.push({ connectionId: c.id, status: snap.status, tables: snap.tables.length });
    } catch (e) {
      results.push({ connectionId: c.id, status: `error: ${(e as Error).message}`, tables: 0 });
    }
  }
  return NextResponse.json({ ok: true, refreshed: results.length, results });
}
