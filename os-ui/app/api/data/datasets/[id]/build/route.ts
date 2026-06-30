/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { getDataset } from '@/lib/data/store';
import { buildStage } from '@/lib/data/build/server';
import type { DataStage } from '@/lib/data/build/adapter';

export const dynamic = 'force-dynamic';

const STAGES: DataStage[] = ['bronze', 'silver', 'gold', 'metric', 'dashboard', 'promote', 'certify'];

/**
 * Run a stage's Build (execute → verify) for a dataset. For `promote`/`certify` this
 * includes the **policy** adapter — compile one source → OPA + Cube, then the
 * conformance gate (OPA path == Cube path, else ✗). Live when the stack is reachable,
 * else the honest offline-mock.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { stage?: DataStage };
    if (!body.stage || !STAGES.includes(body.stage)) {
      return NextResponse.json({ error: `stage must be one of ${STAGES.join('|')}` }, { status: 400 });
    }
    const dataset = getDataset(id, user); // view-scope guard
    const build = await buildStage(dataset, body.stage, user.id);
    return NextResponse.json({ build });
  } catch (e) {
    return errorResponse(e);
  }
}
