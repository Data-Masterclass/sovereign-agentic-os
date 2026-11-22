/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { ensureHydrated, listConversations } from '@core/runtime/conversations';

export const dynamic = 'force-dynamic';

/** The signed-in user's own conversations, newest first. Nobody else's, whatever their role. */
export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: 'Sign in to use the assistant.' }, { status: (e as { status?: number }).status ?? 401 });
  }
  await ensureHydrated();
  return NextResponse.json({ conversations: listConversations(user.id) });
}
