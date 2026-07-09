/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { runPhaseTurn } from '@/lib/agents/build/agentic-graph-server';
import { SOFTWARE_TEAM_YAML } from '@/lib/agents/software-team';
import {
  classifyTeamError,
  getSession,
  resetSession,
  preRoute,
  lastUserText,
} from '@/lib/agents/build/phase-router';

export const dynamic = 'force-dynamic';
// The phase router runs ONE role-agent per turn; a 235B PLAN call can still take
// a while, so give the turn room before the platform kills it.
export const maxDuration = 300;

type Msg = { role: 'user' | 'assistant'; content: string };

/**
 * THE SOFTWARE DELIVERY TEAM run endpoint (Software tab entry) — the interactive,
 * phase-driven builder. One turn = ONE role-agent (the phase router picks it from
 * the persisted per-user session), run LIVE as the signed-in user, every tool
 * governed via handleRpc. It STREAMS (SSE) each phase + tool step so the user sees
 * progress, never a silent spinner, and surfaces the REAL, typed failure cause
 * (timeout · weekly budget reached · model error · gateway offline) instead of the
 * old catch-all "offline". Deploy stays a human Builder decision in /software/reviews.
 */
export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }

  let messages: Msg[] = [];
  let reset = false;
  try {
    const body = await req.json();
    messages = Array.isArray(body?.messages) ? body.messages : [];
    reset = body?.reset === true;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const clean = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.trim() }));
  if (!reset && clean.length === 0) return NextResponse.json({ error: 'No message to send' }, { status: 400 });

  if (reset) resetSession(user.id);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        // Announce which role is about to run this turn (from the persisted session).
        const session = getSession(user.id);
        const pre = preRoute(session, lastUserText(clean));
        send('phase', { phase: pre.phase, role: pre.role });

        const turn = await runPhaseTurn({
          user,
          yaml: SOFTWARE_TEAM_YAML,
          messages: clean,
          onStep: (s) => send('step', { tool: s.tool, isError: s.isError }),
        });

        send('message', {
          role: 'assistant',
          content: turn.reply,
          phase: turn.phase,
          agent: turn.role,
          appId: turn.appId,
          path: [turn.role],
          built: turn.steps.some((s) => s.tool === 'create_software' || s.tool === 'commit'),
        });
      } catch (e) {
        // HONEST, typed failure — never a blanket "offline".
        send('error', classifyTeamError(e));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
    },
  });
}
