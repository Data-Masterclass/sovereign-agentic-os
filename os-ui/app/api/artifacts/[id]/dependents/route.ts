/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { dependentsOf } from '@/lib/core/dependents';

export const dynamic = 'force-dynamic';

/**
 * The warn-before-break preflight for the shared lifecycle controls (0.6.98). Returns
 * every artifact that depends on `id` so the ONE confirm dialog can show a direction-aware
 * "used by N metrics, M dashboards, K apps — this will break their access" line before a
 * promote/demote/archive/delete. Read-only; gated to signed-in users (the default
 * withRoute gate). The dependency walk is unscoped by design (the warn must count every
 * dependent), but the payload is only {kind,name,tab} — no cross-domain artifact detail. */
export const GET = withRoute<{ id: string }>(async ({ params }) => {
  const { id } = params;
  const dependents = await dependentsOf(id);
  return NextResponse.json({ dependents });
});
