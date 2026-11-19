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
 *     decision — refused even if a yaml offers it), then any name not in the turn's offered list.
 *   - WHAT THIS DOOR DOES NOT DO — it has NO HOLD. The engine path parks `request_deploy`,
 *     `delete` and `archive` for a second person (`hold.ts` `ALWAYS_CONFIRMED_TOOLS`); this panel
 *     is a synchronous chat turn with no checkpoint to park on. An offered tool executes
 *     immediately, as the present user, under their own role gates. Today the only
 *     always-confirmed tool any phase offers is `request_deploy`, in the `deploy` phase, which the
 *     user enters by typing a "ship it"-style phrase. Whether that typed phrase is confirmation
 *     enough is a product decision that has not been taken; it is recorded in
 *     `os-ui/ARCHITECTURE.md` rather than papered over here.
 */
import type { ToolExecutor } from '@core/runtime/agentic';
import { agentForbiddenReason } from '@core/mcp/write-tool-meta';

/** A typed refusal in the same `{ error: { code, reason } }` envelope the agent door uses. */
function refusal(code: 'forbidden' | 'not_found', reason: string): { text: string; isError: true } {
  return { text: JSON.stringify({ error: { code, reason } }), isError: true };
}

/** The offered tool names minus anything closed to agents — what a turn may actually call. */
export function phaseCallableTools(offered: readonly string[]): string[] {
  return offered.filter((n) => agentForbiddenReason(n) === null);
}

/**
 * Wrap `inner` so it dispatches ONLY the names in `offered`, and never a name closed to agents.
 * `offered` is the list of tool names the model was actually handed this turn.
 */
export function phaseToolExecutor(inner: ToolExecutor, offered: readonly string[]): ToolExecutor {
  const allow = new Set(phaseCallableTools(offered));
  return async (name, args) => {
    const forbidden = agentForbiddenReason(name);
    if (forbidden) return refusal('forbidden', forbidden);
    if (!allow.has(name)) {
      return refusal(
        'not_found',
        `Tool not available in this phase: ${name || '(none)'}. This turn may call only: ${[...allow].join(', ') || '(no tools)'}.`,
      );
    }
    return inner(name, args);
  };
}
