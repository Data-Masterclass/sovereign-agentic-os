/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    One Langfuse trace per run — the RunObserver the graph nodes report into
 * USER STORY: As an engineer I open Langfuse and find ONE trace per run, id = run id, tagged with the
 *             domain, the agent system and the run, where every `plan_/act_/tools_/route_` node is a
 *             span, every model call a generation with its token usage, and every tool call a span
 *             carrying the governance decision — the tree I would build by hand with the SDK.
 * ARCHITECTURE:
 *   - A PORT (`RunObserver` / `SpanHandle`) the graph builder calls, and ONE implementation over the
 *     official `langfuse` SDK (`langfuseRunObserver`). The SDK client is INJECTED (the server wiring
 *     passes `core/infra/langfuse.ts`'s singleton; tests pass a recording subclass), so this module
 *     has no `server-only` and the pure graph builder can import it.
 *   - IDS: trace id = run id (`trace({ id: runId })` — the SDK honours a caller-chosen id); every
 *     observation id is minted here BEFORE the call so the LiteLLM caller can forward it as
 *     `parent_observation_id` and the gateway's own Langfuse generation nests under ours (A24).
 *   - ONE `trace-create` per run start; a RESUME creates no trace event (the trace exists) — spans
 *     simply reference the same trace id. The run's outcome is a terminal `run.result` span.
 *   - REDACTION: model-call content is recorded as roles + character counts, never the text; the
 *     tool-call STRUCTURE (names, ids, args) is kept in full. Tool spans record args and the
 *     decision; results as character counts. PII in traces is a checklist concern — this is the
 *     conservative default until a redaction policy exists.
 *   - Buffered by the SDK; `flush()` is fire-and-forget at run end. Nothing here throws into a run.
 */
import { randomUUID } from 'node:crypto';
import type { Langfuse } from 'langfuse';
import type { LlmCall, LlmCompletion, LlmMessage, LlmRequest, ToolCall } from '@core/runtime/agentic';

/** The governance outcome a tool span carries. */
export type ToolDecision = 'ok' | 'held' | 'denied' | 'error' | 'not_advertised' | 'dedup';

export type SpanEnd = {
  output?: unknown;
  error?: string;
  /** The node parked on `interrupt()` — a normal outcome, not an error. */
  parked?: boolean;
  metadata?: Record<string, unknown>;
};

export type SpanHandle = {
  readonly id: string;
  readonly traceId: string;
  /** Wrap an `LlmCall`: every completion becomes a GENERATION under this span, and the request carries `observe`. */
  llm(inner: LlmCall, name?: string): LlmCall;
  /** Run one tool call inside a SPAN that records the decision and the (bounded) outcome. */
  tool<T extends { text: string; isError: boolean }>(call: ToolCall, meta: { decision: ToolDecision; approvalId?: string }, fn: () => Promise<T>): Promise<T>;
  /** A tool call that did NOT execute in this superstep (held → parked, denied, rejected, dedup). */
  toolEvent(call: ToolCall, meta: { decision: ToolDecision; approvalId?: string; detail?: string }): void;
  end(status?: SpanEnd): void;
};

export type RunOutcome = {
  reachedEnd: boolean;
  parked: boolean;
  interrupted: boolean;
  failed: boolean;
  path: string[];
  finalChars: number;
  stepsUsed: number;
};

export type RunObserver = {
  readonly traceId: string;
  /** False for the no-op observer (no Langfuse configured): spans still exist, nothing is sent. */
  readonly enabled: boolean;
  /** A node span directly under the run trace. */
  span(name: string, metadata?: Record<string, unknown>): SpanHandle;
  /** The terminal span of the run (or of this resume segment). */
  finish(outcome: RunOutcome): void;
  /** Flush the SDK buffer; never rejects. */
  flush(): Promise<void>;
};

// ----------------------------------------------------------------- redaction --

/** Roles and sizes only — never the text. The tool-call structure is kept whole. */
export function redactMessages(messages: LlmMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const row: Record<string, unknown> = { role: m.role, chars: m.content?.length ?? 0 };
    if (m.tool_calls) row.tool_calls = m.tool_calls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments }));
    if (m.tool_call_id) row.tool_call_id = m.tool_call_id;
    return row;
  });
}

export function redactRequest(req: LlmRequest): Record<string, unknown> {
  return {
    messages: redactMessages(req.messages),
    tools: (req.tools ?? []).map((t) => t.function.name),
    temperature: req.temperature,
    maxTokens: req.maxTokens,
  };
}

export function redactCompletion(c: LlmCompletion): Record<string, unknown> {
  return { role: 'assistant', chars: c.content?.length ?? 0, toolCalls: c.toolCalls };
}

const RESULT_PREVIEW = 160;

function boundedResult(text: string): { chars: number; preview: string } {
  const flat = text.replace(/\s+/g, ' ').trim();
  return { chars: text.length, preview: flat.length > RESULT_PREVIEW ? `${flat.slice(0, RESULT_PREVIEW)}…` : flat };
}

// ------------------------------------------------------------------ no-op --

/** The observer used when Langfuse is not configured: ids and structure, nothing sent. */
export function noopObserver(traceId: string): RunObserver {
  const handle = (): SpanHandle => ({
    id: randomUUID(),
    traceId,
    llm: (inner) => inner,
    tool: (_call, _meta, fn) => fn(),
    toolEvent: () => undefined,
    end: () => undefined,
  });
  return { traceId, enabled: false, span: handle, finish: () => undefined, flush: () => Promise.resolve() };
}

// --------------------------------------------------------------- langfuse --

export type LangfuseObserverInput = {
  runId: string;
  systemId: string;
  systemName: string;
  /** The runner's OS user id — Langfuse `userId`. */
  userId: string;
  domain: string;
  engine?: string;
  /** The user task (bounded) recorded as the trace input on a fresh start. */
  task?: string;
  /** Continuing an existing thread: no trace-create, spans reference the same id. */
  resume?: boolean;
  /** The SDK client, or null to get the no-op observer. */
  client: Langfuse | null;
  metadata?: Record<string, unknown>;
};

const TASK_MAX = 500;

/** The tags every run trace carries (the vocabulary Monitoring and the gateway mirror share). */
export function runTraceTags(input: Pick<LangfuseObserverInput, 'domain' | 'systemId' | 'runId' | 'engine'>): string[] {
  return [`domain:${input.domain}`, `agent:${input.systemId}`, `run:${input.runId}`, `engine:${input.engine ?? 'langgraph'}`];
}

/**
 * The Langfuse-backed observer. One `trace-create` with `id = runId` on a fresh start; every
 * span/generation carries `traceId = runId`. Resumes add observations to the same trace.
 */
export function langfuseRunObserver(input: LangfuseObserverInput): RunObserver {
  const client = input.client;
  if (!client) return noopObserver(input.runId);
  const traceId = input.runId;
  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch {
      /* observability never fails a run */
    }
  };

  if (!input.resume) {
    safe(() =>
      client.trace({
        id: traceId,
        name: input.systemName,
        userId: input.userId,
        sessionId: input.systemId,
        tags: runTraceTags(input),
        input: input.task ? { task: input.task.length > TASK_MAX ? `${input.task.slice(0, TASK_MAX)}…` : input.task } : undefined,
        metadata: { systemId: input.systemId, domain: input.domain, engine: input.engine ?? 'langgraph', runId: traceId, ...(input.metadata ?? {}) },
      }),
    );
  }

  const makeSpan = (name: string, parentObservationId: string | undefined, metadata?: Record<string, unknown>, inputBody?: unknown): SpanHandle => {
    const id = randomUUID();
    let span: ReturnType<Langfuse['span']> | null = null;
    safe(() => { span = client.span({ id, traceId, parentObservationId, name, startTime: new Date(), metadata, input: inputBody }); });
    const handle: SpanHandle = {
      id,
      traceId,
      llm: (inner, genName) => async (req) => {
        const genId = randomUUID();
        const observed: LlmRequest = { ...req, observe: { traceId, parentObservationId: genId } };
        let gen: ReturnType<Langfuse['generation']> | null = null;
        safe(() => {
          gen = client.generation({
            id: genId,
            traceId,
            parentObservationId: id,
            name: genName ?? `llm.${name}`,
            model: req.model,
            startTime: new Date(),
            input: redactRequest(req),
            modelParameters: { temperature: req.temperature ?? 0.2, ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}) },
            metadata: { tools: (req.tools ?? []).length, node: metadata?.agent },
          });
        });
        try {
          const completion = await inner(observed);
          safe(() => gen?.end({
            output: redactCompletion(completion),
            usage: completion.usage ? { input: completion.usage.input, output: completion.usage.output, total: completion.usage.total, unit: 'TOKENS' } : undefined,
          }));
          return completion;
        } catch (e) {
          const message = (e as Error)?.message ?? String(e);
          safe(() => gen?.end({ level: 'ERROR', statusMessage: message.slice(0, 300) }));
          throw e;
        }
      },
      tool: async (call, meta, fn) => {
        let toolSpan: ReturnType<Langfuse['span']> | null = null;
        safe(() => {
          toolSpan = client.span({
            traceId,
            parentObservationId: id,
            name: `tool.${call.name}`,
            startTime: new Date(),
            input: { tool: call.name, callId: call.id, args: call.args },
            metadata: { decision: meta.decision, approvalId: meta.approvalId },
          });
        });
        try {
          const out = await fn();
          const decision: ToolDecision = out.isError ? (/"code":"(forbidden|denied|held|rejected|not_found)"/.test(out.text) ? 'denied' : 'error') : meta.decision;
          safe(() => toolSpan?.end({ output: { isError: out.isError, ...boundedResult(out.text) }, level: out.isError ? 'WARNING' : 'DEFAULT', metadata: { decision, approvalId: meta.approvalId } }));
          return out;
        } catch (e) {
          const message = (e as Error)?.message ?? String(e);
          safe(() => toolSpan?.end({ level: 'ERROR', statusMessage: message.slice(0, 300), metadata: { decision: 'error', approvalId: meta.approvalId } }));
          throw e;
        }
      },
      toolEvent: (call, meta) => {
        const at = new Date();
        safe(() => client.span({
          traceId,
          parentObservationId: id,
          name: `tool.${call.name}`,
          startTime: at,
          endTime: at,
          input: { tool: call.name, callId: call.id, args: call.args },
          output: meta.detail ? { detail: meta.detail } : undefined,
          level: meta.decision === 'held' ? 'DEFAULT' : 'WARNING',
          metadata: { decision: meta.decision, approvalId: meta.approvalId },
        }));
      },
      end: (status) => {
        safe(() => span?.end({
          output: status?.output,
          level: status?.error ? 'ERROR' : 'DEFAULT',
          statusMessage: status?.error ? status.error.slice(0, 300) : status?.parked ? 'parked on approval' : undefined,
          metadata: { ...(metadata ?? {}), ...(status?.metadata ?? {}), ...(status?.parked ? { parked: true } : {}) },
        }));
      },
    };
    return handle;
  };

  return {
    traceId,
    enabled: true,
    span: (name, metadata) => makeSpan(name, undefined, metadata),
    finish: (outcome) => {
      const at = new Date();
      safe(() => client.span({ traceId, name: 'run.result', startTime: at, endTime: at, output: outcome, level: outcome.failed ? 'ERROR' : 'DEFAULT', metadata: { resume: !!input.resume } }));
    },
    flush: () => client.flushAsync().catch(() => undefined),
  };
}
