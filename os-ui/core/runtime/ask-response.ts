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

/** The per-turn trace the surface already showed as chips: which governed tools ran. */
export type AskToolTrace = { name: string; isError: boolean };

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
};

export type AskTurnInput = {
  finalText: string;
  plan: string;
  steps: { tool: string; isError: boolean }[];
  artifacts: ChatArtifact[];
  tab: string | null;
  traceId: string;
  model: string;
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
    tools: input.steps.map((s) => ({ name: s.tool, isError: s.isError })),
    artifacts: parseArtifacts({ artifacts: input.artifacts }),
    tab: input.tab,
    traceId: input.traceId,
    model: input.model,
  };
}
