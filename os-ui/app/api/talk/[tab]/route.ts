/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { talkTo, talkTabIds, type TalkTabId, type TalkTurn } from '@/lib/talk';

export const dynamic = 'force-dynamic';

/**
 * "Talk to <tab>" — POST { question, history? } → a governed, read-only copilot turn.
 *
 * The principal is ALWAYS the session user (`requireUser` → 401 for anon); the body
 * carries only the question + prior turns. `talkTo` runs the tab's entitled-scope
 * metadata + governed retrieval AS the caller, reasons within the model's input budget,
 * and returns the answer + the model's reasoning SEPARATELY + real citations. An unknown
 * tab is a 404; a model/retrieval failure is a calm 200 with an honest answer (talkTo
 * degrades rather than 502-ing the turn).
 */
export async function POST(req: Request, ctx: { params: Promise<{ tab: string }> }) {
  let user;
  try {
    user = await requireUser(); // 401 for anon
  } catch (e) {
    const status = (e as { status?: number }).status ?? 401;
    return NextResponse.json({ error: 'Not authenticated' }, { status });
  }

  const { tab } = await ctx.params;
  if (!talkTabIds().includes(tab as TalkTabId)) {
    return NextResponse.json({ error: `No copilot for tab "${tab}"` }, { status: 404 });
  }

  let question = '';
  let history: TalkTurn[] = [];
  try {
    const body = await req.json();
    question = (body?.question ?? '').toString().trim();
    if (Array.isArray(body?.history)) {
      history = body.history
        .filter((t: unknown): t is TalkTurn => {
          const r = (t as TalkTurn)?.role;
          return (r === 'user' || r === 'assistant') && typeof (t as TalkTurn)?.content === 'string';
        })
        .slice(-6);
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!question) return NextResponse.json({ error: 'Missing question' }, { status: 400 });

  try {
    const result = await talkTo(tab as TalkTabId, question, user, history);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: `talk failed: ${(e as Error).message}` }, { status: 502 });
  }
}
