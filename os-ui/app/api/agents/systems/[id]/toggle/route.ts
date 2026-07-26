/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { toggleAgent } from '@/lib/agents/store';

export const dynamic = 'force-dynamic';

/** POST → toggle one sub-agent on/off inside the system. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const POST = withRoute<{ id: string }, any>(async ({ user, params, body }) => {
  const { id } = params;
  if (typeof body.agentId !== 'string') {
    return NextResponse.json({ error: 'agentId is required.' }, { status: 400 });
  }
  const rec = toggleAgent(id, user, body.agentId, body.on !== false);
  return NextResponse.json({ disabledAgents: rec.disabledAgents });
}, { parse: true, defaultStatus: 500 });
