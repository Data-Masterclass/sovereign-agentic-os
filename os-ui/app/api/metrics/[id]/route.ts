/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/data/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { getMetric } from '@/lib/metrics/store';
import {
  ensureHydrated,
  isMetricArchived,
  archiveMetric,
  unarchiveMetric,
  deleteMetric,
  renameMetric,
} from '@/lib/metrics/lifecycle';

export const dynamic = 'force-dynamic';

/**
 * One metric's lifecycle — the SAME `POST {action}` / `DELETE` shape every other
 * artifact tab exposes, wiring the already-built `lib/metrics/lifecycle` overlay so
 * the shared <LifecycleActions> can drive Metrics identically. Edit authority is the
 * metric's dataset gate (owner or domain admin), enforced in the lib.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const metric = getMetric(id, user);
  return NextResponse.json({ metric: { ...metric, archived: isMetricArchived(id) } });
}, { gate: requirePrincipal as () => Promise<CurrentUser>, hydrate: ensureHydrated });

/** POST → metric lifecycle: `archive` (reversible soft-hide), `unarchive`, or `rename`
 *  (display-name only — the Cube member is frozen; mirrors the Data tab's rename shape). */
export const POST = withRoute<{ id: string }, { action?: string; name?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  switch (body.action) {
    case 'rename':
      return NextResponse.json({ metric: renameMetric(id, user, body.name ?? '') });
    case 'archive':
      return NextResponse.json({ metric: archiveMetric(id, user) });
    case 'unarchive':
      return NextResponse.json({ metric: unarchiveMetric(id, user) });
    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
}, { gate: requirePrincipal as () => Promise<CurrentUser>, hydrate: ensureHydrated, parse: true });

/**
 * DELETE → permanently remove a metric (edit-scoped; confirmed in the UI). Snapshots
 * the measure for restore, then de-registers it from its Cube model so it stops being
 * queryable. Honest `{ recordDeleted, physical[] }` report.
 */
export const DELETE = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const report = deleteMetric(id, user);
  return NextResponse.json({ ok: true, ...report });
}, { gate: requirePrincipal as () => Promise<CurrentUser>, hydrate: ensureHydrated });
