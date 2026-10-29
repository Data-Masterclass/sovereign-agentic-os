/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/files/lib/server';
import { transition } from '@tabs/files/lib/store';
import { reindexById } from '@tabs/files/lib/pipeline-server';
import type { DataVisibility, Grant, Transition } from '@tabs/data/lib/index';

export const dynamic = 'force-dynamic';

const DIRECT: Transition[] = ['certify', 'unshare', 'decertify'];

/**
 * Direct lifecycle moves that are NOT the request/approve promotion path:
 *   • certify   (asset → product) — Admin
 *   • unshare   (asset → dataset) — Builder/Admin
 *   • decertify (product → asset) — Admin
 * The role gate is enforced in the store (REUSED canTransition). Promotion
 * (dataset→asset) goes through /promote (separation of duties).
 */
export const POST = withRoute<{ id: string }, { transition?: Transition; visibility?: DataVisibility; grants?: Grant[] }>(async ({ user, params, body }) => {
  const { id } = params;
  const t = body.transition;
  if (!t || !DIRECT.includes(t)) {
    return NextResponse.json({ error: `transition must be one of ${DIRECT.join('|')} (promote goes through /promote)` }, { status: 400 });
  }
  const asset = transition(id, user, t, { visibility: body.visibility, grants: body.grants });
  // The tier/grants changed → re-index so the indexed DLS metadata follows.
  await reindexById(id);
  return NextResponse.json({ asset });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
