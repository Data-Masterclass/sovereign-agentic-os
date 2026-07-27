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
import { listGovernedDatasets } from '@/lib/data/store';
import { cubeViewName, registryDimensionMembers } from '@/lib/data/metrics';

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
  const meta = await cubeMeta();
  // Registry fallback (Northpeak fix): the governed datasets' REAL dimension members, so a
  // view Cube doesn't serve still offers its group-bys (flagged `served:false`, warned in the
  // builder) instead of silently emptying the palette. Entitlement unchanged: narrowCubeMeta
  // only emits views behind the caller's visible metrics; this map merely enriches those.
  const registryDims: RegistryViewDims = new Map(
    listGovernedDatasets().map((d) => [cubeViewName(d), registryDimensionMembers(d)]),
  );
  return NextResponse.json({ views: narrowCubeMeta(members, meta, registryDims) });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
