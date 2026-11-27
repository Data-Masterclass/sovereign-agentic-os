/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The Software Team panel's tool door — only what this turn's agent was offered
 * USER STORY: As the person typing into "Build with the Software Delivery Team" I want the agent
 *             that answers my turn to be able to call exactly the tools its phase was given and
 *             nothing else — so a model that emits `decide_deploy`, `promote` or `delete` on its
 *             own initiative gets a refusal, not a dispatched call under my name.
 * ARCHITECTURE:
 *   - Pure wrapper over a `ToolExecutor`, no `server-only` import, so it is unit-testable and
 *     `runPhaseTurn` (`agentic-graph-server.ts`) wires it around `tabToolExecutor(user,'software')`.
 *   - WHY IT EXISTS (review H1). `runPhaseTurn` handed the model the turn agent's tool specs but
 *     executed through the whole Software-tab executor, and `runAgentic` does not check a call
 *     against the specs it offered. So the offered list was advice, not a boundary: any Software
 *     tool the user's role clears — the approvals and the destructive ones included — was one
 *     hallucinated tool call away.
 *   - TWO refusals, in this order: a name in `AGENT_FORBIDDEN_TOOLS` (an approval is a person's
 *     decision — refused even if a yaml offers it) or a call closed on its arguments
 *     (`agentForbiddenCallReason`: an app's Prod env/secrets), then any name not in the turn's
 *     offered list.
 *   - THE CONFIRM STEP lives OUTSIDE this door, in the shared user-confirm gate
 *     (`core/runtime/confirm-gate.ts`, wired in `runPhaseTurn`): every write the turn asks for,
 *     `request_deploy` included, is parked there for the signed-in user and decided through
 *     `resolvePhaseConfirmation` (POST /api/software/team/confirm). This door is the layer under
 *     it: it refuses what the turn may not call, and it never dispatches a name in
 *     {@link PANEL_CONFIRMED_TOOLS} on its own — fail closed if the gate were ever missing.
 */
import type { ToolExecutor } from '@core/runtime/agentic';
import { agentForbiddenCallReason, agentForbiddenReason } from '@core/mcp/write-tool-meta';

/** A typed refusal in the same `{ error: { code, reason } }` envelope the agent door uses. */
function refusal(code: 'forbidden' | 'not_found' | 'confirmation_required', reason: string): { text: string; isError: true } {
  return { text: JSON.stringify({ error: { code, reason } }), isError: true };
}

/**
 * The tools this door never dispatches itself even when the gate in front is missing: the one
 * always-confirmed tool any phase of the team offers. (The gate parks EVERY write; this is the
 * floor under it.)
 */
export const PANEL_CONFIRMED_TOOLS: ReadonlySet<string> = new Set(['request_deploy']);

/** One call waiting for the user's Confirm / Cancel: the session's handle on a record in the shared confirmation store. */
export type PanelConfirmation = {
  /** The confirmation store's id. Opaque, single-use. The confirm request must present it. */
  id: string;
  tool: string;
  /** The arguments the model asked for — what will be executed on Confirm, never a client copy. */
  args: Record<string, unknown>;
  createdAt: string;
};

/** The offered tool names minus anything closed to agents — what a turn may actually call. */
export function phaseCallableTools(offered: readonly string[]): string[] {
  return offered.filter((n) => agentForbiddenReason(n) === null);
}

/**
 * Wrap `inner` so it dispatches ONLY the names in `offered`, never a name closed to agents, and
 * never a name in {@link PANEL_CONFIRMED_TOOLS} (the shared gate in front of this door parks those).
 * `offered` is the list of tool names the model was actually handed this turn.
 */
export function phaseToolExecutor(inner: ToolExecutor, offered: readonly string[]): ToolExecutor {
  const allow = new Set(phaseCallableTools(offered));
  return async (name, args) => {
    // By name, and by the call's arguments (an app's Prod env/secrets — `AGENT_ENV_SCOPED_TOOLS`).
    const forbidden = agentForbiddenCallReason(name, args);
    if (forbidden) return refusal('forbidden', forbidden);
    if (!allow.has(name)) {
      return refusal(
        'not_found',
        `Tool not available in this phase: ${name || '(none)'}. This turn may call only: ${[...allow].join(', ') || '(no tools)'}.`,
      );
    }
    if (PANEL_CONFIRMED_TOOLS.has(name)) {
      return refusal('confirmation_required', `'${name}' needs the user's confirmation and this door has no way to ask for it. Nothing was done.`);
    }
    return inner(name, args);
  };
}
