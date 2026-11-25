/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { parseArtifacts, type ChatArtifact } from '@core/runtime/chat-artifacts';
import { priceTrace, type PricedTrace } from '@core/runtime/turn-ledger';
import { classifyGatewayLimit } from '@core/runtime/rate-limit';

/**
 * FEATURE:    The Ask-the-OS turn response shape — `{ content, plan, tools, artifacts, … }`.
 *
 * USER STORY: As a maintainer I want the chat route's payload shaping to be unit-testable,
 *             because a Next.js `route.ts` may export only its handlers and a test cannot
 *             import one at all.
 *
 * ARCHITECTURE:
 *   `app/api/assistant/chat/route.ts` is a shell: it resolves the user, maps the path to a
 *   tab, runs the turn and calls {@link askTurnResponse}. Everything worth asserting lives
 *   here. Pure: no transport, no `server-only`, no `next/*`.
 *
 *   C9 — `artifacts[]` travels BESIDE `content` and `tools`, never inside the markdown. The
 *   drawer extends the existing tool-chip mechanism to render them; a client that ignores
 *   the field sees exactly today's response.
 *
 *   The artifacts are re-validated here with `parseArtifacts` even though they came from our
 *   own tools: the projection ran on a governed result, but the surface is the last place
 *   that can refuse to hand the browser something it does not understand.
 */

/** The typed refusal every governed tool returns: `{ code, reason, hint }`. */
export type TypedToolError = { code: string; reason: string; hint: string };

/**
 * The typed error inside a tool result's text, or null. Only the exact `{ error: { code, reason,
 * hint } }` shape the MCP door emits counts; anything else (free text, a data row) is not an error
 * this surface may re-label.
 */
export function typedToolError(resultText: string | undefined): TypedToolError | null {
  if (!resultText) return null;
  let parsed: { error?: Partial<TypedToolError> } | null = null;
  let readable = true;
  try {
    parsed = JSON.parse(resultText) as { error?: Partial<TypedToolError> };
  } catch {
    readable = false; // free text, not a typed error: the caller shows it as it is
  }
  const e = readable ? parsed?.error : undefined;
  if (e && typeof e.code === 'string' && typeof e.reason === 'string') {
    return { code: e.code, reason: e.reason, hint: typeof e.hint === 'string' ? e.hint : '' };
  }
  return null;
}

/** The per-turn trace the surface shows as chips: which governed tools ran, and why one was refused. */
export type AskToolTrace = { name: string; isError: boolean; parked?: boolean; error?: TypedToolError };

/** A write that did NOT run and awaits the user's confirmation. */
export type AskPending = { confirmationId: string; tool: string; args: Record<string, unknown>; expiresAt: string };

export type AskTurnResponse = {
  role: 'assistant';
  content: string;
  plan: string;
  tools: AskToolTrace[];
  /** Writes parked for the user's confirmation; empty on a turn that parked nothing. */
  pending: AskPending[];
  /** C9 — the typed artifacts the governed tools produced, in call order. */
  artifacts: ChatArtifact[];
  tab: string | null;
  /** C1 — the Langfuse trace (= turn) id every model call on this turn was logged under. */
  traceId: string;
  model: string;
  /** The conversation the parked confirmations belong to; send it back with the decision. */
  conversationId: string;
  /** Every model call of the turn: purpose, model, role (strong / worker / pinned), escalation, usage and cost per role. */
  modelTrace: PricedTrace;
};

export type AskTurnInput = {
  finalText: string;
  plan: string;
  steps: { tool: string; isError: boolean; result?: string; parked?: boolean }[];
  artifacts: ChatArtifact[];
  tab: string | null;
  traceId: string;
  model: string;
  pending?: AskPending[];
  conversationId: string;
  /** Absent = a turn that made no model call of its own to report (an empty trace). */
  modelTrace?: PricedTrace;
};

/** One step as the live stream carries it (same projection as the final `tools[]`). */
export function askStepEvent(s: { tool: string; isError: boolean; result?: string; parked?: boolean; skipped?: boolean }): { type: 'step' } & AskToolTrace {
  const error = s.isError ? typedToolError(s.result) : null;
  return { type: 'step', name: s.tool, isError: s.isError, ...(s.parked ? { parked: true } : {}), ...(error ? { error } : {}) };
}

/**
 * Shape one finished turn for the wire. Deliberately total: every field is present on
 * every turn (an empty `artifacts: []` rather than an absent key), so the client has no
 * branch for "old response shape".
 */
export function askTurnResponse(input: AskTurnInput): AskTurnResponse {
  return {
    role: 'assistant',
    content: input.finalText,
    plan: input.plan,
    // The transparent, honest trace of the governed tools it invoked this turn.
    tools: input.steps.map((s) => {
      const error = s.isError ? typedToolError(s.result) : null;
      return { name: s.tool, isError: s.isError, ...(s.parked ? { parked: true } : {}), ...(error ? { error } : {}) };
    }),
    pending: input.pending ?? [],
    artifacts: parseArtifacts({ artifacts: input.artifacts }),
    tab: input.tab,
    traceId: input.traceId,
    model: input.model,
    conversationId: input.conversationId,
    modelTrace: input.modelTrace ?? priceTrace({ calls: [], delegations: [], escalations: [] }, {}),
  };
}

/** What the chat shows while it waits out a busy model and re-sends the same call. */
export const MODEL_BUSY_RETRYING = 'The model is busy — retrying…';
/** What the chat shows when the busy model did not clear within the chat's short retry budget. */
export const MODEL_BUSY_GIVE_UP = 'The model is busy right now. Please try again in a minute.';
/** What the chat shows for any other failure of the model gateway (the detail stays in the server log). */
export const MODEL_UNREACHABLE = 'The assistant could not reach the model just now. Please try again in a minute.';

/**
 * The quiet status line the stream carries while the turn waits out a rate limit or an overloaded
 * provider. Deliberately carries no limit, key or model name: only the retry count and the wait.
 */
export function askRetryStatusEvent(wait: { attempt: number; maxAttempts: number; waitMs: number }): {
  type: 'status'; status: 'retrying'; message: string; attempt: number; maxAttempts: number; waitMs: number;
} {
  return { type: 'status', status: 'retrying', message: MODEL_BUSY_RETRYING, attempt: wait.attempt, maxAttempts: wait.maxAttempts, waitMs: wait.waitMs };
}

/** The chat's model budget is spent (gateway key budget). Waiting does not bring it back. */
export const MODEL_BUDGET_SPENT = 'The model budget for the assistant is used up, so it cannot answer right now. Waiting does not help: ask an admin to raise the budget.';
/** A governance cost cap was reached before the model was called. */
export const COST_CAP_REACHED = 'A cost limit set in Governance has been reached, so the assistant did not answer. Ask an admin to raise it, or try again when the period resets.';
/** The model used its whole output allowance thinking and wrote no answer. */
export const ANSWER_TOO_LONG = 'The model ran out of room before it could finish an answer. Try a shorter or more specific question.';
/** Anything else that stopped the turn (the detail stays in the server log). */
export const TURN_FAILED = 'The assistant could not complete the request. Please try again in a minute.';

/** A failure raised by the model gateway itself, whose message carries the provider's raw answer. */
const GATEWAY_RAW = /^LiteLLM (\d{3}\b|returned non-JSON|stream error:)/;

/**
 * The plain sentence (and HTTP status) a failed chat turn shows the user. Nothing internal is ever
 * passed through verbatim — no provider JSON, key, model or role name, chart key or network error:
 *   • a rate limit or an overloaded provider that outlasted the retries → "the model is busy" (503);
 *   • a spent model budget → "budget used up" (402); a governance cost cap → "cost limit" (402);
 *   • the model spending its whole output on reasoning → "ran out of room" (502);
 *   • any other raw gateway failure (status, non-JSON, a mid-stream error) → "could not reach the model" (502);
 *   • anything else → a generic "could not complete the request" (502).
 * Only `AssistantNotConfiguredError`, which is written for the person who must fix it, keeps its
 * own words. The route logs the technical detail server-side.
 */
export function askFailure(e: unknown): { error: string; status: number } {
  const err = (e ?? {}) as { name?: unknown; message?: unknown; status?: unknown; code?: unknown };
  const message = typeof err.message === 'string' ? err.message : String(e);
  if (err.name === 'AssistantNotConfiguredError') return { error: message, status: typeof err.status === 'number' ? err.status : 503 };
  if (err.name === 'AbortError') {
    return { error: 'The model did not respond in time — it may still be warming up. Try again in a few seconds.', status: 504 };
  }
  if (err.name === 'CostCapExceededError') return { error: COST_CAP_REACHED, status: 402 };
  if (err.name === 'ReasoningBudgetExhaustedError' || err.code === 'reasoning_budget_exhausted') return { error: ANSWER_TOO_LONG, status: 502 };
  const limit = classifyGatewayLimit(e);
  if (limit === 'rate-limit') return { error: MODEL_BUSY_GIVE_UP, status: 503 };
  if (limit === 'budget') return { error: MODEL_BUDGET_SPENT, status: 402 };
  if (GATEWAY_RAW.test(message)) return { error: MODEL_UNREACHABLE, status: 502 };
  return { error: TURN_FAILED, status: 502 };
}
