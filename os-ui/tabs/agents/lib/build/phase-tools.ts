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
 *   - THE CONFIRM STEP (owner decision, 2026-11-19). The engine path parks `request_deploy`,
 *     `delete` and `archive` for a SECOND person (`hold.ts`). This panel is a synchronous chat
 *     turn with no checkpoint to park on, and the person is present — so the rule here is the
 *     product's own: a write happens only on the signed-in user's explicit confirmation. A name
 *     in {@link PANEL_CONFIRMED_TOOLS} is therefore NEVER dispatched by this door. The call is
 *     handed to `park`, which records it in the user's server-side session, and the model gets a
 *     typed `awaiting_user_confirmation` result. Only `resolvePhaseConfirmation`
 *     (`agentic-graph-server.ts`, POST /api/software/team/confirm) executes it, as that user,
 *     from the server-held copy of the arguments. With no `park` wired the call is refused —
 *     fail closed, never "run it anyway".
 *   - The set is this door's OWN, deliberately not derived from `hold.ts`: that classification
 *     answers "does a second person decide?", and growing it must not silently change what this
 *     panel asks its user to click.
 */
import type { ToolExecutor } from '@core/runtime/agentic';
import { agentForbiddenReason } from '@core/mcp/write-tool-meta';

/** A typed refusal in the same `{ error: { code, reason } }` envelope the agent door uses. */
function refusal(code: 'forbidden' | 'not_found' | 'confirmation_required', reason: string): { text: string; isError: true } {
  return { text: JSON.stringify({ error: { code, reason } }), isError: true };
}

/**
 * The tools this panel never runs on the model's say-so: the signed-in user confirms each call
 * with a button first. Today that is the one always-confirmed tool any phase of the team offers.
 */
export const PANEL_CONFIRMED_TOOLS: ReadonlySet<string> = new Set(['request_deploy']);

/** One call waiting for the user's Confirm / Cancel. Held server-side, in the user's session. */
export type PanelConfirmation = {
  /** Opaque, single-use. The confirm request must present it. */
  id: string;
  tool: string;
  /** The arguments the model asked for — what will be executed on Confirm, never a client copy. */
  args: Record<string, unknown>;
  createdAt: string;
};

/** Records a call as waiting for the user and returns its handle. */
export type ConfirmPark = (tool: string, args: Record<string, unknown>) => PanelConfirmation;

/** The `status` of the typed result a parked call returns to the model. */
export const AWAITING_USER_CONFIRMATION = 'awaiting_user_confirmation';

/** True when a tool step's result text is the parked-call result (the UI labels it differently). */
export function isAwaitingConfirmation(resultText: string): boolean {
  return resultText.includes(`"status":"${AWAITING_USER_CONFIRMATION}"`);
}

/** The offered tool names minus anything closed to agents — what a turn may actually call. */
export function phaseCallableTools(offered: readonly string[]): string[] {
  return offered.filter((n) => agentForbiddenReason(n) === null);
}

/**
 * Wrap `inner` so it dispatches ONLY the names in `offered`, never a name closed to agents, and
 * never a name in {@link PANEL_CONFIRMED_TOOLS} — those are parked for the user's confirmation.
 * `offered` is the list of tool names the model was actually handed this turn.
 */
export function phaseToolExecutor(inner: ToolExecutor, offered: readonly string[], park?: ConfirmPark): ToolExecutor {
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
    if (PANEL_CONFIRMED_TOOLS.has(name)) {
      if (!park) {
        return refusal('confirmation_required', `'${name}' needs the user's confirmation and this caller has no way to ask for it. Nothing was done.`);
      }
      const pending = park(name, args ?? {});
      return {
        text: JSON.stringify({
          status: AWAITING_USER_CONFIRMATION,
          executed: false,
          tool: name,
          confirmationId: pending.id,
          hint: `NOT done yet. The user now sees a Confirm and a Cancel button for this '${name}' call. Do not call it again. Tell the user it is waiting for their confirmation, and stop.`,
        }),
        isError: false,
      };
    }
    return inner(name, args);
  };
}
