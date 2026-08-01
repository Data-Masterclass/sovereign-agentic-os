/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/data/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { cubeMeta } from '@/lib/infra/governed';
import { listMetrics } from '@/lib/metrics/store';
import { narrowCubeMeta, type RegistryViewDims } from '@/lib/dashboards/cube-meta';
import { listDatasets, getDataset } from '@/lib/data/store';
import { cubeViewName, registryDimensionMembers } from '@/lib/data/metrics';
import type { Principal } from '@/lib/data/store';

/** Registry dims for EVERY dataset the caller can see — personal datasets carry
 *  metrics too (Phase 1), so the palette must include their dimensions; the old
 *  governed-only enumeration left a personal view with an empty group-by. The
 *  caller-scoped list keeps entitlement airtight (canView + active domain), and
 *  narrowCubeMeta additionally narrows to metric-backed views. */
function callerRegistryDims(user: Principal): RegistryViewDims {
  const groups = listDatasets(user);
  const dims: RegistryViewDims = new Map();
  for (const s of [...groups.mine, ...groups.domain, ...groups.marketplace]) {
    try {
      const d = getDataset(s.id, user);
      dims.set(cubeViewName(d), registryDimensionMembers(d));
    } catch { /* vanished between list and get → skip */ }
  }
  return dims;
}

export const dynamic = 'force-dynamic';

/**
 * The measures/dimensions/time-dimensions of the caller's GOVERNED views — the palette the
 * native dashboard panel builder offers. Narrowed to what the caller may see: we intersect
 * Cube's /meta with the views behind the caller's visible metrics (`listMetrics`), so a
 * user never sees a view they aren't entitled to. When Cube is unreachable (offline
 * teaching flow), the narrowing falls back to a members-from-registry view so the builder
 * still works.
 */
export const GET = withRoute(async ({ user }) => {
  const groups = listMetrics(user);
  const members = [...groups.mine, ...groups.domain, ...groups.marketplace].map((m) => m.member);
  const meta = [] as Awaited<ReturnType<typeof cubeMeta>>; // registry-only palette since Phase 2 — no Cube dependency
  return NextResponse.json({ views: narrowCubeMeta(members, meta, callerRegistryDims(user)) });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
