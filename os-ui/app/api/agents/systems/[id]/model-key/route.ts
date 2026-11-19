/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { systemKeyStatus } from '@core/infra/agent-system-keys';
import { ensureHydrated, getSystem } from '@tabs/agents/lib/store';

export const dynamic = 'force-dynamic';

/**
 * GET → does this system have a usable model key of its own? `{ state, message? }` only — the
 * Build & Run panel uses it to say "Build needed" BEFORE a run fails. Scoped by `getSystem`
 * (whoever may see the system). It never carries the key, its hash, or its caps.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  getSystem(params.id, user); // 403/404 before anything is read
  const status = await systemKeyStatus(params.id);
  return NextResponse.json({ state: status.state, message: status.message ?? null, rotatedAt: status.rotatedAt ?? null });
}, { hydrate: ensureHydrated, defaultStatus: 500 });
