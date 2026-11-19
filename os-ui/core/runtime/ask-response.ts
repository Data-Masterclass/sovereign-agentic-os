/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { parseArtifacts, type ChatArtifact } from '@core/runtime/chat-artifacts';
import { parseConfirmCards, type ConfirmCard } from '@core/runtime/confirm-card';

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

/**
 * The per-turn trace the surface shows as chips: which governed tools the model called, and what
 * became of each call. `awaiting` — it did NOT run, it waits for the user's Confirm. `skipped` —
 * it did NOT run, because it came after a call that is waiting. Neither is an error and neither
 * is a success, so both travel as their own flag beside `isError` (which stays for old clients).
 */
export type AskToolTrace = { name: string; isError: boolean; awaiting?: true; skipped?: true };

export type AskTurnResponse = {
  role: 'assistant';
  content: string;
  plan: string;
  tools: AskToolTrace[];
  /** C9 — the typed artifacts the governed tools produced, in call order. */
  artifacts: ChatArtifact[];
  tab: string | null;
  /** C1 — the Langfuse trace (= turn) id every model call on this turn was logged under. */
  traceId: string;
  model: string;
  /**
   * The Confirm cards for what this turn parked — each built by the server from its own record
   * of the held call (`core/runtime/confirm-card.ts`), never from the model's words. Empty on
   * every turn that parked nothing.
   */
  pending: ConfirmCard[];
  /**
   * The conversation id the client echoes on its next turn and that scopes confirmations,
   * their outcomes and "Allow for this conversation". Not a secret; see `ask-confirm.ts`.
   */
  conversationId: string;
};

export type AskTurnInput = {
  finalText: string;
  plan: string;
  steps: { tool: string; isError: boolean; parked?: true; skipped?: true }[];
  artifacts: ChatArtifact[];
  tab: string | null;
  traceId: string;
  model: string;
  pending?: ConfirmCard[];
  conversationId?: string;
};

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
    tools: input.steps.map((s) => ({
      name: s.tool,
      isError: s.isError,
      ...(s.parked ? { awaiting: true as const } : {}),
      ...(s.skipped ? { skipped: true as const } : {}),
    })),
    artifacts: parseArtifacts({ artifacts: input.artifacts }),
    tab: input.tab,
    traceId: input.traceId,
    model: input.model,
    pending: parseConfirmCards(input.pending ?? []),
    conversationId: input.conversationId ?? '',
  };
}
