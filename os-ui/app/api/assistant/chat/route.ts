/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { roleModel } from '@/lib/models/roles';
import { requireUser } from '@/lib/auth';
import { mcpTabForPath, runOsAssistant } from '@/lib/assistant/agent-loop';
import { AssistantNotConfiguredError } from '@/lib/assistant/complete';

export const dynamic = 'force-dynamic';

/**
 * THE OVERARCHING SOVEREIGN OS ASSISTANT endpoint.
 *
 * One assistant, present on every tab. The client POSTs the running conversation
 * plus the current `path` (the tab the user is on); we resolve the signed-in
 * user, map the path → MCP tab, and run the PLAN→ACT harness. Every action it
 * takes is dispatched through the OS's own governed MCP `handleRpc` under the
 * user's delegated identity — same guardrails as an external MCP client.
 *
 * Response: the final answer + a transparent trace of which governed tools it
 * invoked (and whether each was blocked), so the surface never hides what it did.
 */

const CHAT_TIMEOUT_MS = Number(process.env.LLM_CHAT_TIMEOUT_MS ?? '') || 90_000;

type Msg = { role: 'user' | 'assistant' | 'system'; content: string };

export async function POST(req: Request) {
  let path = '';
  let messages: Msg[] = [];
  try {
    const body = await req.json();
    path = (body?.path ?? '').toString();
    messages = Array.isArray(body?.messages) ? body.messages : [];
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const clean = messages
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0,
    )
    .slice(-20)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content.trim() }));

  if (clean.length === 0) {
    return NextResponse.json({ error: 'No message to send' }, { status: 400 });
  }

  let user;
  try {
    user = await requireUser();
  } catch (e) {
    const status = (e as { status?: number }).status ?? 401;
    return NextResponse.json({ error: 'Sign in to use the assistant.' }, { status });
  }

  const tab = mcpTabForPath(path);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
  try {
    const result = await runOsAssistant({ user, tab, messages: clean });
    return NextResponse.json({
      role: 'assistant',
      content: result.finalText,
      plan: result.plan,
      // Transparent, honest trace of the governed tools it invoked this turn.
      tools: result.steps.map((s) => ({ name: s.tool, isError: s.isError })),
      tab,
      model: roleModel('standard'),
    });
  } catch (e) {
    if (e instanceof AssistantNotConfiguredError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    if ((e as Error).name === 'AbortError') {
      return NextResponse.json(
        { error: 'The model did not respond in time — it may still be warming up. Try again in a few seconds.' },
        { status: 504 },
      );
    }
    return NextResponse.json(
      { error: `The assistant could not complete the request: ${(e as Error).message}` },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
