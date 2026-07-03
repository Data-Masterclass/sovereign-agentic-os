/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { runAgenticTeam } from '@/lib/agents/build/agentic-graph-server';
import { SOFTWARE_TEAM_YAML } from '@/lib/agents/software-team';

export const dynamic = 'force-dynamic';

type Msg = { role: 'user' | 'assistant'; content: string };

/**
 * THE SOFTWARE DELIVERY TEAM run endpoint (Software tab entry). One turn: the
 * running conversation in → the 6-agent team runs LIVE as the signed-in user
 * (plan → build → test → deploy-request → narrate), every tool call governed via
 * handleRpc(user, …). The communication agent's narration is the reply; deploy
 * stays a human Builder decision in /software/reviews.
 *
 * This runs the canonical team yaml directly, so the Software tab is operational
 * regardless of whether the instructor has seeded the Agents-tab record.
 */
export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }

  let messages: Msg[] = [];
  try {
    const body = await req.json();
    messages = Array.isArray(body?.messages) ? body.messages : [];
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const clean = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.trim() }));
  if (clean.length === 0) return NextResponse.json({ error: 'No message to send' }, { status: 400 });

  try {
    const team = await runAgenticTeam({ user, yaml: SOFTWARE_TEAM_YAML, messages: clean });
    return NextResponse.json({
      role: 'assistant',
      content: team.finalText || '(the team produced no narration)',
      path: team.path,
      nodes: team.runs.map((r) => ({
        node: r.node,
        model: r.model,
        steps: r.result.steps.map((s) => ({ tool: s.tool, isError: s.isError })),
      })),
    });
  } catch (e) {
    const content =
      (e as Error).name === 'AbortError'
        ? '(the team is still warming up — a model did not respond in time. Send your message again in a few seconds.)'
        : '(the Software Delivery Team is offline — LiteLLM unreachable. Try again once the cluster models are up.)';
    return NextResponse.json({ role: 'assistant', content, offline: true });
  }
}
