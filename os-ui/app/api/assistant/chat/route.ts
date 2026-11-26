/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { getAssistantModelId } from '@tabs/admin/lib/models';
import { pricedTrace } from '@tabs/admin/lib/turn-prices';
import { requireUser } from '@core/kernel/auth';
import { mcpTabForPath, osToolExecutor, osToolSpecs, runOsAssistant } from '@core/runtime/agent-loop';
import { decideConfirmation } from '@core/runtime/confirm-execute';
import { SAVE_AS, isSaveAsKind, saveAsPlan, type SaveAsKind } from '@core/runtime/save-as';
import { canContinue, deleteConversation, ensureHydrated, getConversationMemory, saveTurn } from '@core/runtime/conversations';
import { scheduleMemoryUpdate, withConversationMemory, type MemoryWorkerCall } from '@core/runtime/conversation-memory';
import { cleanTurns } from '@core/runtime/turns';
import { askFailure, askRetryStatusEvent, askStepEvent, askTurnResponse } from '@core/runtime/ask-response';
import { sanitizePageContext } from '@core/runtime/page-context';
import { AssistantNotConfiguredError, assistantComplete } from '@core/runtime/complete';
import { withExternalTools } from '@core/runtime/external-mcp';
import { getUserLocale } from '@core/prefs/locale';
// Registers the user's Notion MCP connections as the chat's external tool source.
import '@tabs/connections/lib/external-mcp-source';

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
  let confirmation: { id: string; conversationId: string; decision: 'confirm' | 'decline' } | null = null;
  let messages: Msg[] = [];
  let pageContextRaw: unknown = null;
  let conversationId: string | null = null;
  let wantStream = false;
  let saveAsRaw: unknown = null;
  let deleteId: string | null = null;
  try {
    const body = await req.json();
    path = (body?.path ?? '').toString();
    // Confirm or decline a write the Home chat parked: same route, same session gate. The
    // arguments that run are the ones stored with the confirmation, never anything from here.
    const c = body?.confirmation;
    if (c && typeof c.id === 'string' && typeof c.conversationId === 'string' && (c.decision === 'confirm' || c.decision === 'decline')) {
      confirmation = { id: c.id, conversationId: c.conversationId, decision: c.decision };
    }
    messages = Array.isArray(body?.messages) ? body.messages : [];
    // The current-screen snapshot the client publishes (open artifact + stage). It
    // only ENRICHES; a missing/malformed value degrades to "no page context".
    pageContextRaw = body?.pageContext ?? null;
    // A client may name its conversation (Home and the drawer do). Absent or malformed, the turn
    // mints one — the confirm-before-write gate is on for every turn either way.
    if (typeof body?.conversationId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.conversationId)) {
      conversationId = body.conversationId;
    }
    wantStream = body?.stream === true;
    saveAsRaw = body?.saveAs ?? null;
    if (typeof body?.deleteConversation === 'string') deleteId = body.deleteConversation;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // The last TURN_WINDOW well-formed turns; older ones are named as omitted, and the conversation's
  // memory (rolling summary + working set, `conversation-memory.ts`) stands in for them below.
  const clean = cleanTurns(messages);

  if (clean.length === 0 && !confirmation && !deleteId) {
    return NextResponse.json({ error: 'No message to send' }, { status: 400 });
  }

  let user;
  try {
    user = await requireUser();
  } catch (e) {
    const status = (e as { status?: number }).status ?? 401;
    return NextResponse.json({ error: 'Sign in to use the assistant.' }, { status });
  }

  if (deleteId) {
    await ensureHydrated();
    return deleteConversation(user.id, deleteId)
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: 'No such conversation.' }, { status: 404 });
  }

  if (confirmation) {
    const result = await decideConfirmation({
      user,
      confirmationId: confirmation.id,
      conversationId: confirmation.conversationId,
      surface: 'ask',
      decision: confirmation.decision,
      execute: (tool, args, sink) => withExternalTools(user, osToolExecutor(user, sink), { confirmed: true })(tool, args),
    });
    // A refusal is the same 404 for "not yours", "not here" and "does not exist".
    const status = result.status === 'refused' ? (result.code === 'not_found' ? 404 : 409) : 200;
    return NextResponse.json(result, { status });
  }

  const tab = mcpTabForPath(path);
  const page = sanitizePageContext(pageContextRaw);
  const confirm = conversationId ? { conversationId } : undefined;

  // History is per user: a conversation id that exists and is not the caller's is "not found" —
  // the same answer as an id that does not exist.
  if (conversationId) {
    await ensureHydrated();
    if (!canContinue(user.id, conversationId)) return NextResponse.json({ error: 'No such conversation.' }, { status: 404 });
  }
  // The caller's own conversation memory only (getConversation answers per user): context, never a permission.
  const memory = conversationId ? getConversationMemory(user.id, conversationId) : undefined;
  // i18n option A: the assistant answers in the user's saved language (English when never chosen or unreadable).
  const locale = await getUserLocale(user.id).catch(() => 'en' as const);

  // "Save as": the kind comes from a fixed table; the turn is restricted to that kind's ONE create
  // tool, behind the confirm gate. Needs a conversation (the confirmation is bound to it).
  const offered = osToolSpecs(user, tab).map((t) => t.name);
  const availableSaveAs = (Object.keys(SAVE_AS) as SaveAsKind[]).filter((k) => offered.includes(SAVE_AS[k].tool));
  let onlyTools: string[] | undefined;
  let storedUserText = clean[clean.length - 1]?.content ?? '';
  if (saveAsRaw !== null) {
    if (!conversationId || !isSaveAsKind(saveAsRaw)) return NextResponse.json({ error: 'Save as needs a conversation and a known kind.' }, { status: 400 });
    const plan = saveAsPlan(saveAsRaw, offered);
    if (!plan.ok) return NextResponse.json({ error: plan.reason }, { status: 403 });
    onlyTools = [plan.tool];
    clean.push({ role: 'user', content: plan.instruction });
    storedUserText = `Save as ${SAVE_AS[saveAsRaw].label}`;
  }
  // The turn's deadline starts only once the turn will run: an early refusal leaves no timer behind.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
  const remember = (result: Awaited<ReturnType<typeof runOsAssistant>>) => {
    if (!conversationId) return;
    saveTurn(user.id, conversationId, {
      user: storedUserText,
      assistant: {
        content: result.finalText,
        steps: result.steps.map((s) => {
          const e = askStepEvent({ tool: s.tool, isError: s.isError, result: s.result, parked: !!s.parked });
          return { name: e.name, isError: e.isError, ...(e.parked ? { parked: true } : {}), ...(e.error ? { error: e.error } : {}) };
        }),
        pending: result.pending,
      },
    });
  };
  // After the answer, fold dropped turns and record the working set — not awaited, never fails the turn.
  const memorise = (result: Awaited<ReturnType<typeof runOsAssistant>>) => {
    if (!conversationId) return;
    const complete: MemoryWorkerCall = async (r) =>
      (await assistantComplete(r.messages, { user: r.user, model: r.model, temperature: r.temperature, fixedSampling: r.fixedSampling, tab: r.tab, signal: r.signal })).content;
    void scheduleMemoryUpdate({ user, conversationId, steps: result.steps, artifacts: result.artifacts, complete, locale });
  };
  // The user gets a plain sentence (`askFailure`); the technical detail — the gateway's own answer —
  // stays in the server log, never in the browser.
  const failure = (e: unknown): { error: string; status: number } => {
    if (e instanceof AssistantNotConfiguredError) return { error: e.message, status: e.status };
    const f = askFailure(e);
    if ((e as Error)?.name !== 'AbortError') {
      const cause = (e as { cause?: unknown })?.cause;
      console.error(`[assistant/chat] turn failed: ${(e as Error)?.message ?? String(e)}${cause instanceof Error ? ` (cause: ${cause.message})` : ''}`);
    }
    return f;
  };
  const shape = async (result: Awaited<ReturnType<typeof runOsAssistant>>) =>
    ({ ...askTurnResponse({
      finalText: result.finalText,
      plan: result.plan,
      steps: result.steps,
      artifacts: result.artifacts,
      tab,
      traceId: result.traceId,
      model: getAssistantModelId(),
      modelTrace: await pricedTrace(result.modelTrace),
      pending: result.pending,
      conversationId: result.conversationId,
    }), ...(conversationId ? { saveAs: availableSaveAs } : {}) });

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
            user, tab, page, locale, messages: withConversationMemory(clean, memory), confirm, onlyTools,
            signal: ctrl.signal,
            onToken: (t) => send({ type: 'token', t }),
            onStep: (st) => send(askStepEvent({ tool: st.tool, isError: st.isError, result: st.result, parked: !!st.parked })),
            // A busy model is waited out and the same call re-sent: a quiet status line, not an error.
            onRetryWait: (w) => send(askRetryStatusEvent(w)),
          });
          remember(result);
          send({ type: 'done', ...(await shape(result)) });
          memorise(result);
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
    const result = await runOsAssistant({ user, tab, page, locale, messages: withConversationMemory(clean, memory), confirm, onlyTools });
    remember(result);
    const payload = await shape(result);
    memorise(result);
    return NextResponse.json(payload);
  } catch (e) {
    const f = failure(e);
    return NextResponse.json({ error: f.error }, { status: f.status });
  } finally {
    clearTimeout(timer);
  }
}
