/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Confirm or decline a write the Home chat parked
 * USER STORY: As a user I want the exact action I was shown to run once, as me, when I say yes — and
 *             to be able to say no.
 * ARCHITECTURE:
 *   - The only executor of a parked call. `beginExecute` is the single-use step (user + conversation
 *     bound, args hash checked); the call then runs through the SAME governed `handleRpc` as every
 *     other tool call, as the same user, so the role floor, OPA and the audit trail apply again.
 *     A confirmation never widens rights.
 *   - Arguments come from the stored record, never from the request.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { beginExecute, declineConfirmation, finishExecute } from '@core/policy/confirmations';
import type { ToolExecutor } from '@core/runtime/agentic';
import { typedToolError, type TypedToolError } from '@core/runtime/ask-response';
import type { ChatArtifact } from '@core/runtime/chat-artifacts';

export type DecideResult = {
  status: 'executed' | 'failed' | 'declined' | 'refused';
  tool?: string;
  /** What the tool returned (model-readable text), for the result card. */
  text?: string;
  artifacts: ChatArtifact[];
  error?: TypedToolError;
  /** Why a `refused` decision did nothing. */
  code?: string;
};

export async function decideConfirmation(input: {
  user: CurrentUser;
  confirmationId: string;
  conversationId: string;
  decision: 'confirm' | 'decline';
  /**
   * Runs ONE governed tool call as the confirming user, appending the call's typed artifacts to
   * `sink`. The caller builds it from `osToolExecutor(user, sink)` (the same governed `handleRpc` door
   * as every other call); this module never reaches the dispatcher or the admin adapters itself.
   */
  execute: (tool: string, args: Record<string, unknown>, sink: ChatArtifact[]) => ReturnType<ToolExecutor>;
}): Promise<DecideResult> {
  const { user, confirmationId, conversationId } = input;
  if (input.decision === 'decline') {
    const c = declineConfirmation(confirmationId, user.id);
    // Same conversation rule as confirm: a record of another conversation is "not found".
    return c && c.conversationId === conversationId
      ? { status: 'declined', tool: c.tool, artifacts: [] }
      : { status: 'refused', code: 'not_found', artifacts: [] };
  }
  const begun = beginExecute(confirmationId, user.id, { conversationId });
  if (!begun.ok) return { status: 'refused', code: begun.code, artifacts: [] };
  const { tool, args } = begun.confirmation;
  const artifacts: ChatArtifact[] = [];
  try {
    const out = await input.execute(tool, args, artifacts);
    const error = out.isError ? typedToolError(out.text) : null;
    finishExecute(confirmationId, out.isError ? 'failed' : 'executed', out.isError ? (error?.code ?? 'error') : 'ok');
    return out.isError
      ? { status: 'failed', tool, text: out.text, artifacts: [], ...(error ? { error } : {}) }
      : { status: 'executed', tool, text: out.text, artifacts };
  } catch (e) {
    finishExecute(confirmationId, 'failed', (e as Error).message);
    return { status: 'failed', tool, artifacts: [], error: { code: 'error', reason: (e as Error).message, hint: 'Retry, or ask for the action again.' } };
  }
}
