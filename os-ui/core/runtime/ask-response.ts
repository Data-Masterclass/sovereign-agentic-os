/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { parseArtifacts, type ChatArtifact } from '@core/runtime/chat-artifacts';

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
  };
}
