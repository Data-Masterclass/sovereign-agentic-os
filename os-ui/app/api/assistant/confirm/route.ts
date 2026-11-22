/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { decideConfirmation } from '@core/runtime/confirm-execute';

export const dynamic = 'force-dynamic';

/**
 * Confirm or decline a write the Home chat parked. The body names the confirmation and the
 * conversation; the arguments that run are the ones stored with the confirmation — never anything
 * from this request. The call runs through the governed MCP dispatch as the signed-in user.
 */
export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: 'Sign in to use the assistant.' }, { status: (e as { status?: number }).status ?? 401 });
  }
  let body: { confirmationId?: unknown; conversationId?: unknown; decision?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { confirmationId, conversationId, decision } = body;
  if (typeof confirmationId !== 'string' || typeof conversationId !== 'string' || (decision !== 'confirm' && decision !== 'decline')) {
    return NextResponse.json({ error: 'confirmationId, conversationId and decision (confirm | decline) are required' }, { status: 400 });
  }
  const result = await decideConfirmation({ user, confirmationId, conversationId, decision });
  // A refusal is the same 404 for "not yours", "not here" and "does not exist".
  const status = result.status === 'refused' ? (result.code === 'not_found' ? 404 : 409) : 200;
  return NextResponse.json(result, { status });
}
