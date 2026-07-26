/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { forkSystem } from '@/lib/agents/store';

export const dynamic = 'force-dynamic';

/**
 * POST → install a Marketplace system as a fork-to-own independent copy.
 * The **Builder+** gate lives in `forkSystem` (the store is the security
 * boundary); a User/Creator is rejected (403), consistent with having no
 * Marketplace publish surface.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const rec = forkSystem(id, user);
  return NextResponse.json({ id: rec.id });
}, { defaultStatus: 500 });
