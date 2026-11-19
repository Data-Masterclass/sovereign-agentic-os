/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { resolvePhaseConfirmation } from '@tabs/agents/lib/build/agentic-graph-server';

export const dynamic = 'force-dynamic';

/**
 * THE SOFTWARE DELIVERY TEAM's confirm endpoint — the Confirm / Cancel buttons under a waiting
 * deploy request. The body carries only the id the server issued and the decision; the tool and
 * its arguments are read from the signed-in user's own server-side session, never from the
 * client. `confirm` files the request as that user; `cancel` files nothing and returns the typed
 * `not_filed` / `user_declined` outcome. An id nothing is waiting under is a 404.
 */
export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }

  let confirmationId = '';
  let decision = '';
  try {
    const body = await req.json();
    confirmationId = typeof body?.confirmationId === 'string' ? body.confirmationId : '';
    decision = typeof body?.decision === 'string' ? body.decision : '';
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!confirmationId) return NextResponse.json({ error: 'confirmationId is required' }, { status: 400 });
  if (decision !== 'confirm' && decision !== 'cancel') {
    return NextResponse.json({ error: "decision must be 'confirm' or 'cancel'" }, { status: 400 });
  }

  const result = await resolvePhaseConfirmation({ user, confirmationId, decision });
  if (!result.ok) return NextResponse.json({ error: result.reason, code: result.code }, { status: 404 });
  return NextResponse.json(result);
}
