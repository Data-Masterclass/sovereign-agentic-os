/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/data/server';
import { transition } from '@/lib/data/store';
import { stepperStages } from '@/lib/data/panels';

export const dynamic = 'force-dynamic';

/**
 * Reverse lifecycle moves (data-architecture-model.md §Reverse), role-gated +
 * lineage-aware in the store: `decertify` (product→asset) is blocked while domains
 * import it; `unshare` (asset→dataset) is blocked while named individuals are granted.
 */
const REVERSE = new Set(['decertify', 'unshare']);

export const POST = withRoute<{ id: string }, { action?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  if (!body.action || !REVERSE.has(body.action)) {
    return NextResponse.json({ error: 'action must be decertify or unshare' }, { status: 400 });
  }
  const dataset = transition(id, user, body.action as 'decertify' | 'unshare');
  return NextResponse.json({ dataset, stages: stepperStages(dataset) });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
