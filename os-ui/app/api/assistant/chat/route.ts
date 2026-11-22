/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { roleModel } from '@core/models/roles';
import { requireUser } from '@core/kernel/auth';
import { mcpTabForPath, runOsAssistant } from '@core/runtime/agent-loop';
import { askStepEvent, askTurnResponse } from '@core/runtime/ask-response';
import { sanitizePageContext } from '@core/runtime/page-context';
import { AssistantNotConfiguredError } from '@core/runtime/complete';

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
 * invoked (and whether each was blocked) + the typed ARTIFACTS those tools
 * produced (C9), so the surface never hides what it did and a number always
 * arrives with the rows, the SQL or the metric member that produced it.
 *
 * A route may export only its handlers, so the payload shaping lives in
 * `core/runtime/ask-response.ts` where a test can reach it.
 */

const CHAT_TIMEOUT_MS = Number(process.env.LLM_CHAT_TIMEOUT_MS ?? '') || 90_000;

type Msg = { role: 'user' | 'assistant' | 'system'; content: string };

export async function POST(req: Request) {
  let path = '';
  let messages: Msg[] = [];
  let pageContextRaw: unknown = null;
  let conversationId: string | null = null;
  let wantStream = false;
  try {
    const body = await req.json();
    path = (body?.path ?? '').toString();
    messages = Array.isArray(body?.messages) ? body.messages : [];
    // The current-screen snapshot the client publishes (open artifact + stage). It
    // only ENRICHES; a missing/malformed value degrades to "no page context".
    pageContextRaw = body?.pageContext ?? null;
    // The Home chat names its conversation: that turns on the confirm-before-write gate. The
    // drawer sends neither field and behaves exactly as before.
    if (typeof body?.conversationId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.conversationId)) {
      conversationId = body.conversationId;
    }
    wantStream = body?.stream === true;
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
  const page = sanitizePageContext(pageContextRaw);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
  const confirm = conversationId ? { conversationId } : undefined;
  const failure = (e: unknown): { error: string; status: number } => {
    if (e instanceof AssistantNotConfiguredError) return { error: e.message, status: e.status };
    if ((e as Error).name === 'AbortError') {
      return { error: 'The model did not respond in time — it may still be warming up. Try again in a few seconds.', status: 504 };
    }
    return { error: `The assistant could not complete the request: ${(e as Error).message}`, status: 502 };
  };
  const shape = (result: Awaited<ReturnType<typeof runOsAssistant>>) =>
    askTurnResponse({
      finalText: result.finalText,
      plan: result.plan,
      steps: result.steps,
      artifacts: result.artifacts,
      tab,
      traceId: result.traceId,
      model: roleModel('standard'),
      pending: result.pending,
    });

  // Live steps: newline-delimited JSON, one event per finished tool step, then one `done` event
  // carrying the same payload the JSON response has. The steps are real (the harness's own
  // `onStep`); the final answer arrives whole — the gateway call is not token-streamed.
  if (wantStream) {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (o: unknown) => controller.enqueue(enc.encode(`${JSON.stringify(o)}\n`));
        try {
          const result = await runOsAssistant({
            user, tab, page, messages: clean, confirm,
            onStep: (st) => send(askStepEvent({ tool: st.tool, isError: st.isError, result: st.result, parked: !!st.parked })),
          });
          send({ type: 'done', ...shape(result) });
        } catch (e) {
          send({ type: 'error', error: failure(e).error });
        } finally {
          clearTimeout(timer);
          controller.close();
        }
      },
      cancel() { ctrl.abort(); },
    });
    return new Response(body, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } });
  }

  try {
    const result = await runOsAssistant({ user, tab, page, messages: clean, confirm });
    return NextResponse.json(shape(result));
  } catch (e) {
    const f = failure(e);
    return NextResponse.json({ error: f.error }, { status: f.status });
  } finally {
    clearTimeout(timer);
  }
}
