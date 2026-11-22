/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-53b — Langfuse spans for a module run, through the ONE writer (WP-31)
 * USER STORY: As the owner I want a run of a team's `graph.mjs` to land in Langfuse like any run:
 *             one trace, one span per agent visit, one span per model call that the gateway nests
 *             its generation under, and a tool observation per governed call with its decision.
 * ARCHITECTURE:
 *   - Everything goes through the `RunObserver` port (`core/infra/trace-port.ts`), implemented by
 *     `core/infra/langfuse.ts` `withRunTrace` — no second writer, no SDK import here.
 *   - `moduleTracer(observer)`: `spans` opens `agent.<id>` on an agent task start and ends it once
 *     (output, error or parked); `current()` is the open visit's handle (a team runs one agent at
 *     a time); `middleware(agentId)` is a `wrapModelCall` middleware that runs each model call
 *     inside the visit's `llm.<agent>` span (`SpanHandle.llm`) and passes that span to the gateway
 *     as W3C `traceparent` plus `x-litellm-call-id` — as request headers through the documented
 *     `modelSettings` → `bindTools` call options (`ChatOpenAI` `options.headers`).
 *   - Tool observations: `module/os-agent.ts` `osTools` wraps each governed call in
 *     `current().tool(...)`, so what the governed call records nests under it.
 *   - Observability never fails a run: with no observer (Langfuse unconfigured) everything is a no-op.
 */
import { createMiddleware } from 'langchain';
import type { LlmCompletion, LlmMessage, LlmRequest } from '@core/runtime/agentic';
import type { RunObserver, SpanHandle } from '@core/infra/trace-port';
import type { AgentSpans } from '@tabs/agents/lib/module/run';
import { tracedModelFetch } from '@core/adapters/litellm/traced-fetch';

export type ModuleTracer = {
  spans: AgentSpans;
  current(): SpanHandle | null;
  middleware(agentId: string): ReturnType<typeof createMiddleware>;
  /**
   * The HTTP client for the model calls no middleware sees — the supervisor's `route` call and the
   * stock summariser's call: each becomes a `route.<agent>` / `summary.<agent>` span with its
   * `llm.…` model span, sent to the gateway as `traceparent` + `x-litellm-call-id`. A call that
   * already carries a `traceparent` (an agent call, traced by the middleware) passes through.
   */
  fetchFor(kind: 'route' | 'summary', agentId: string): typeof globalThis.fetch;
};

type AnyMsg = { type?: string; _getType?: () => string; content?: unknown; tool_calls?: { id?: string; name: string; args: Record<string, unknown> }[]; tool_call_id?: string };

const text = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : String((p as { text?: string }).text ?? ''))).join('') : '');
const roleOf = (m: AnyMsg): LlmMessage['role'] => {
  const t = m.type ?? m._getType?.();
  return (t === 'ai' ? 'assistant' : t === 'human' ? 'user' : t === 'tool' ? 'tool' : 'system') as LlmMessage['role'];
};

export { traceparentOf } from '@core/adapters/litellm/traced-fetch';
import { traceparentOf } from '@core/adapters/litellm/traced-fetch';

export function moduleTracer(observer: RunObserver | null): ModuleTracer {
  const open = new Map<string, SpanHandle>();
  let active: string | null = null;
  const spans: AgentSpans = {
    start(agentId, visit) {
      if (!observer) return;
      open.get(agentId)?.end({ error: 'superseded by a new visit' });
      open.set(agentId, observer.span(`agent.${agentId}`, { agent: agentId, visit, engine: 'module' }));
      active = agentId;
    },
    end(agentId, status) {
      const h = open.get(agentId);
      if (!h) return;
      open.delete(agentId);
      if (active === agentId) active = null;
      h.end(status);
    },
  };
  const current = () => (active ? open.get(active) ?? null : null);
  const middleware = (agentId: string) =>
    createMiddleware({
      name: 'OsRunTrace',
      wrapModelCall: async (request, handler) => {
        const span = open.get(agentId);
        if (!span) return handler(request);
        const msgs = request.messages as unknown as AnyMsg[];
        const req: LlmRequest = {
          model: String((request.model as { model?: string }).model ?? ''),
          messages: msgs.map((m) => ({ role: roleOf(m), content: text(m.content) })),
          tools: (request.tools ?? []).map((t) => ({ type: 'function' as const, function: { name: String((t as { name?: string }).name ?? ''), description: '', parameters: { type: 'object' as const, properties: {} } } })),
        };
        let ai: Awaited<ReturnType<typeof handler>> | undefined;
        await span.llm(async (r: LlmRequest): Promise<LlmCompletion> => {
          const tp = traceparentOf(r.observe);
          const headers: Record<string, string> = { ...(tp ? { traceparent: tp } : {}), ...(r.observe?.callId ? { 'x-litellm-call-id': r.observe.callId } : {}) };
          ai = await handler({ ...request, modelSettings: { ...(request.modelSettings ?? {}), options: { headers } } });
          const out = ai as unknown as AnyMsg;
          return {
            content: text(out.content),
            toolCalls: (out.tool_calls ?? []).map((c) => ({ id: String(c.id ?? ''), name: c.name, args: c.args ?? {} })),
            ...(r.observe?.callId ? { gatewayCallId: r.observe.callId } : {}),
          };
        }, `llm.${agentId}`)(req);
        return ai!;
      },
    });
  const fetchFor = (kind: 'route' | 'summary', agentId: string): typeof globalThis.fetch => tracedModelFetch(observer, kind, agentId);
  return { spans, current, middleware, fetchFor };
}
