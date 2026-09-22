/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { myImports, type Viewer } from '@/lib/experimental/marketplace';
import { ensureHydrated } from '@/lib/experimental/marketplace/store';

export const dynamic = 'force-dynamic';

/** The caller's imports (their grants) for the "My imports" view. */
export const GET = withRoute(async ({ user }) => {
  const viewer: Viewer = { id: user.id, domains: user.domains, role: user.role };
  return NextResponse.json({ grants: myImports(viewer) });
}, { hydrate: ensureHydrated, defaultStatus: 500 });
