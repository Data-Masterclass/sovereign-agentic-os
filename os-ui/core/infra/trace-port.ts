/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The run-trace PORT the engine reports into, and the OS redaction policy for it.
 * USER STORY: As an engineer I build and test the LangGraph engine without a trace store: the graph
 *             builder talks to this port only, and the one Langfuse writer (`core/infra/langfuse.ts`)
 *             implements it with the official OpenTelemetry SDK.
 * ARCHITECTURE:
 *   - Pure: no SDK import and no `server-only`, so the pure graph builder and its tests import it.
 *   - The port: `RunObserver` (one per run segment) hands out `SpanHandle`s per graph node. A node's
 *     model calls become a `llm.<node>` span whose id the gateway receives as its parent, so the
 *     gateway's GENERATION is the only generation of the call (05 §5.1). Tool calls become `tool`
 *     observations carrying the governance decision; non-executed calls become `event`s.
 *   - Redaction (`LANGFUSE_REDACTION`, `structure` | `strict`) is OS policy, applied here before
 *     anything reaches the SDK. `structure` records message roles and sizes, never text, plus the
 *     tool-call structure and a 160-character result preview; `strict` keeps argument key names and
 *     sizes only. The span processor's `osMask` additionally strips inline media.
 */
import { randomUUID } from 'node:crypto';
import type { LlmCall, LlmCompletion, LlmMessage, LlmRequest, ToolCall } from '@core/runtime/agentic';

/**
 * A governed call that belongs to an agent run. `traceId` is the RUN ID (the Langfuse trace id is
 * derived from it with `createTraceId(runId)`); the run's own observer writes the tool observation,
 * so a governed call under a run writes nothing to Langfuse itself.
 */
export type RunTraceContext = { traceId: string; parentObservationId?: string };

/** The governance outcome a tool observation carries. */
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
  /** Wrap an `LlmCall`: every call runs inside a `llm.<node>` span whose id the gateway nests under. */
  llm(inner: LlmCall, name?: string): LlmCall;
  /** Run one tool call inside a `tool` observation that records the decision and the (bounded) outcome. */
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
  /** The Langfuse trace id of the run (`createTraceId(runId)`), or the run id for the no-op observer. */
  readonly traceId: string;
  /** False for the no-op observer (no Langfuse configured): spans still exist, nothing is sent. */
  readonly enabled: boolean;
  /** A graph-node observation directly under the run segment's root. */
  span(name: string, metadata?: Record<string, unknown>): SpanHandle;
  /** Close the run segment with its outcome. */
  finish(outcome: RunOutcome): void;
  /** Flush the exporter; never rejects. */
  flush(): Promise<void>;
};

/** What the writer needs to open one run segment's trace. */
export type RunTraceInput = {
  runId: string;
  systemId: string;
  systemName: string;
  /** The runner's bare OS user id — Langfuse `userId` (never the approver, never `os-<systemId>`). */
  userId: string;
  domain: string;
  engine?: string;
  /** The user task (bounded) recorded as the run input on a fresh start. */
  task?: string;
  /** Continuing a parked or interrupted thread: a `run segment` under the same fixed root id. */
  resume?: boolean;
  /** The trace `environment` (`studio` | `test` | `run`), the same word as the gateway's `env:` tag. */
  environment?: string;
  /** How much of a call to record (default `structure`). */
  redaction?: RedactionLevel;
  /** The system version, recorded as the trace `version`. */
  version?: string;
  /** The `os-<systemId>` principal; metadata only, never the user id. */
  principal?: string;
};

// ----------------------------------------------------------------- redaction --

export type RedactionLevel = 'structure' | 'strict';
export const DEFAULT_REDACTION: RedactionLevel = 'structure';

/** Argument values replaced by their sizes — the shape of the call without its content. */
export function argShape(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object') return { chars: JSON.stringify(args ?? null).length };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    out[k] = { chars: (typeof v === 'string' ? v : JSON.stringify(v ?? null)).length };
  }
  return out;
}

/** A tool-call argument blob as the given level records it. */
export function redactArgs(args: unknown, level: RedactionLevel): unknown {
  return level === 'strict' ? argShape(args) : args;
}

/** Raw JSON arguments (the wire form on an assistant message) as the given level records them. */
function redactArgString(json: string | undefined, level: RedactionLevel): unknown {
  if (level !== 'strict') return json;
  try { return argShape(JSON.parse(json ?? '{}')); } catch { return { chars: (json ?? '').length }; }
}

/** Roles and sizes only — never the text. The tool-call structure is kept per {@link RedactionLevel}. */
export function redactMessages(messages: LlmMessage[], level: RedactionLevel = DEFAULT_REDACTION): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const row: Record<string, unknown> = { role: m.role, chars: m.content?.length ?? 0 };
    if (m.tool_calls) row.tool_calls = m.tool_calls.map((c) => ({ id: c.id, name: c.function.name, arguments: redactArgString(c.function.arguments, level) }));
    if (m.tool_call_id) row.tool_call_id = m.tool_call_id;
    return row;
  });
}

export function redactRequest(req: LlmRequest, level: RedactionLevel = DEFAULT_REDACTION): Record<string, unknown> {
  return {
    messages: redactMessages(req.messages, level),
    tools: (req.tools ?? []).map((t) => t.function.name),
    temperature: req.temperature,
    maxTokens: req.maxTokens,
    redaction: level,
  };
}

export function redactCompletion(c: LlmCompletion, level: RedactionLevel = DEFAULT_REDACTION): Record<string, unknown> {
  return {
    role: 'assistant',
    chars: c.content?.length ?? 0,
    toolCalls: (c.toolCalls ?? []).map((t) => ({ id: t.id, name: t.name, args: redactArgs(t.args, level) })),
  };
}

const RESULT_PREVIEW = 160;

/** `structure` keeps a 160-char preview beside the size; `strict` keeps only the size. */
export function boundedResult(text: string, level: RedactionLevel = DEFAULT_REDACTION): { chars: number; preview?: string } {
  if (level === 'strict') return { chars: text.length };
  const flat = text.replace(/\s+/g, ' ').trim();
  return { chars: text.length, preview: flat.length > RESULT_PREVIEW ? `${flat.slice(0, RESULT_PREVIEW)}…` : flat };
}

/** The tags every run trace carries (the vocabulary Monitoring and the gateway mirror share). */
export function runTraceTags(input: Pick<RunTraceInput, 'domain' | 'systemId' | 'runId' | 'engine' | 'environment'>): string[] {
  const tags = [`domain:${input.domain}`, `agent:${input.systemId}`, `system:${input.systemId}`, `run:${input.runId}`, `engine:${input.engine ?? 'langgraph'}`];
  // The same `env:` word the LiteLLM credential tags a model call with.
  if (input.environment) tags.push(`env:${input.environment}`);
  return tags;
}

/** The Langfuse session of a run: one session per agent system (owner's rule, 05 §5.2). */
export function runSessionId(systemId: string): string {
  return `system:${systemId}`;
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
