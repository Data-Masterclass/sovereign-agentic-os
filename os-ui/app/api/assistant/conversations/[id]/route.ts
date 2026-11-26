/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { conversationView, ensureHydrated, getConversation } from '@core/runtime/conversations';

export const dynamic = 'force-dynamic';

async function who() {
  try {
    return await requireUser();
  } catch (e) {
    return NextResponse.json({ error: 'Sign in to use the assistant.' }, { status: (e as { status?: number }).status ?? 401 });
  }
}

/**
 * One of the caller's conversations. Someone else's is a 404, like one that does not exist. The
 * short-term memory stays server-side: the answer carries `hasSummary` and `workingSetEntries` only.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await who();
  if (user instanceof NextResponse) return user;
  await ensureHydrated();
  const c = getConversation(user.id, (await ctx.params).id);
  return c ? NextResponse.json(conversationView(c)) : NextResponse.json({ error: 'No such conversation.' }, { status: 404 });
}
