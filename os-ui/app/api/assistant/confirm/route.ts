/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { decideAskConfirmation } from '@core/runtime/ask-decide';

export const dynamic = 'force-dynamic';

/**
 * ASK THE OS — the Confirm card's endpoint.
 *
 *   POST { confirmationId, decision: 'confirm' | 'decline' | 'allow_for_conversation' }
 *
 * The body names a confirmation the server issued and one of exactly three decisions. The tool
 * and its arguments are the server's stored copy — nothing else the client sends is read. An id
 * that does not exist, or belongs to someone else, is a 404; any other decision word is a 400;
 * a cross-site request is a 403. On Confirm the stored call runs once, as the signed-in user,
 * through the same governed executor the chat uses. Everything testable lives in
 * `core/runtime/ask-decide.ts`.
 */
export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: 'Sign in to confirm an action.' }, { status: (e as { status?: number }).status ?? 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const result = await decideAskConfirmation({ user, headers: req.headers, body });
  return NextResponse.json(result.body, { status: result.status });
}
