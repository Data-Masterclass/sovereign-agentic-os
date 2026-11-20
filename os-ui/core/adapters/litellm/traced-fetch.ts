/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The HTTP client a gateway model uses for calls no agent middleware sees (WP-53b)
 * USER STORY: As the owner I want every model call of a run — the supervisor's route decision and
 *             the summariser included — to land in the run's trace, joined to the gateway's
 *             generation like every other call.
 * ARCHITECTURE:
 *   - The OpenAI SDK's documented `fetch` client option (`ChatOpenAI` `configuration.fetch`). A call
 *     that already carries `traceparent` (an agent call, traced by the run's middleware) passes
 *     through. Any other call opens a `<kind>.<agent>` span on the run's `RunObserver` (the WP-31
 *     writer's port) and runs inside its `llm.<kind>.<agent>` model span, which hands this client
 *     the span ids: they go to the gateway as W3C `traceparent` plus `x-litellm-call-id`.
 *   - No observer → the plain `fetch`. The HTTP response is returned untouched; a body this side
 *     cannot read is recorded as such on the span (`Fetched`-style honesty), never invented.
 */
import type { Fetched } from '@core/adapters/_contract';
import type { LlmCompletion, LlmRequest } from '@core/runtime/agentic';
import type { RunObserver } from '@core/infra/trace-port';

/** The traceparent of a span, when both ids are OTel-shaped (as `core/runtime/runtime.ts` builds it). */
export function traceparentOf(observe: LlmRequest['observe']): string | undefined {
  if (!observe) return undefined;
  return /^[0-9a-f]{32}$/.test(observe.traceId) && /^[0-9a-f]{16}$/.test(observe.parentObservationId ?? '')
    ? `00-${observe.traceId}-${observe.parentObservationId}-01`
    : undefined;
}

type ChatMessage = { content?: unknown; tool_calls?: { id?: string; function?: { name?: string } }[] };

/** The completion in a gateway response body, or the reason it cannot be read. */
export function completionOf(raw: string): Fetched<ChatMessage> {
  const at = new Date().toISOString();
  try {
    const msg = (JSON.parse(raw) as { choices?: { message?: ChatMessage }[] }).choices?.[0]?.message;
    return msg ? { ok: true, value: msg, at } : { ok: false, reason: 'invalid', detail: 'no choices[0].message in the response', at };
  } catch (e) {
    return { ok: false, reason: 'invalid', detail: e instanceof Error ? e.message : String(e), at };
  }
}

export function tracedModelFetch(observer: RunObserver | null, kind: string, agentId: string): typeof globalThis.fetch {
  return async (url, init) => {
    const headers = new Headers(init?.headers);
    if (!observer || headers.has('traceparent')) return globalThis.fetch(url, init);
    const span = observer.span(`${kind}.${agentId}`, { agent: agentId, kind, engine: 'module' });
    let model = '';
    if (typeof init?.body === 'string') {
      try {
        model = String((JSON.parse(init.body) as { model?: unknown }).model ?? '');
      } catch (e) {
        model = `(unreadable request: ${e instanceof Error ? e.message : String(e)})`;
      }
    }
    let res: Response | undefined;
    try {
      await span.llm(async (r: LlmRequest): Promise<LlmCompletion> => {
        const tp = traceparentOf(r.observe);
        if (tp) headers.set('traceparent', tp);
        if (r.observe?.callId) headers.set('x-litellm-call-id', r.observe.callId);
        res = await globalThis.fetch(url, { ...init, headers });
        const c = completionOf(await res.clone().text());
        const msg = c.ok ? c.value : { content: `(unreadable response: ${c.detail})` };
        const text = typeof msg.content === 'string' ? msg.content : '';
        return {
          content: text,
          toolCalls: (msg.tool_calls ?? []).map((t) => ({ id: String(t.id ?? ''), name: String(t.function?.name ?? ''), args: {} })),
          ...(r.observe?.callId ? { gatewayCallId: r.observe.callId } : {}),
        };
      }, `llm.${kind}.${agentId}`)({ model, messages: [] });
      span.end({ output: { status: res?.status } });
    } catch (e) {
      span.end({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    return res!;
  };
}
