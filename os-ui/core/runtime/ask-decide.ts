/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Deciding a confirmation in Ask the OS — Confirm, Cancel, Allow for this conversation.
 * USER STORY: As a user I want my Confirm click to run exactly the call the server showed me,
 *             once, as me — and my Cancel to run nothing — whatever a script, another tab or
 *             another person sends to this endpoint.
 * ARCHITECTURE:
 *   - `POST /api/assistant/confirm` is a shell around {@link decideAskConfirmation}; a Next.js
 *     route may export only its handlers, so everything worth testing lives here.
 *   - It is an HTTP route for a person's click and deliberately NOT an MCP tool: a model that
 *     could call "confirm" would be confirming its own proposals.
 *   - THE CLIENT SENDS AN ID AND A DECISION. The tool and its arguments are read from the
 *     server's own record (`core/policy/confirmations.ts`); nothing else in the body is looked at.
 *   - THE DECISION IS ONE OF THREE EXACT WORDS. There is no "anything that is not a decline is
 *     a confirm" branch anywhere below: an unknown or missing word is a 400 before any lookup.
 *   - Execution goes through `osToolExecutor` — the same inner executor the chat turn's gate
 *     wraps — as the signed-in user. So the role floor, OPA and whatever approval the tool
 *     itself opens downstream apply again NOW, at execution time, not as they stood at proposal.
 *   - Single use is the store's `pending → executing` transition (`beginExecute`).
 *   - Both outcomes are audited (`assistant.confirm`, `assistant.decline`) with the call's
 *     hash, never its arguments.
 *   - CROSS-SITE / APP INTENT: the same guard the approval routes use (`guardAppIntent`, scope
 *     `approval-decide`). A cross-site request is refused; a request that announces itself as a
 *     governed app is refused, because no app is ever minted that scope. The guard's own honest
 *     limit applies here too: it cannot recognise same-origin code that sends no headers — what
 *     such code lacks is the unguessable confirmation id, which only the Ask drawer receives.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { guardAppIntent, type IntentHeaders } from '@core/kernel/app-intent';
import { record as audit } from '@core/policy/audit';
import { isSessionAllowable } from '@core/mcp/tool-classes';
import { osToolExecutor, type RpcDispatch } from '@core/runtime/agent-loop';
import { askClosedReason } from '@core/runtime/ask-confirm';
import { parseArtifacts, type ChatArtifact } from '@core/runtime/chat-artifacts';
import {
  beginExecute,
  declineConfirmation,
  ensureHydrated,
  finishExecute,
  getConfirmationForUser,
  grantSessionAllowance,
} from '@core/policy/confirmations';

/** The ONLY decisions the endpoint accepts. Compared by exact string equality. */
export const ASK_DECISIONS = ['confirm', 'decline', 'allow_for_conversation'] as const;
export type AskDecision = (typeof ASK_DECISIONS)[number];

export function isAskDecision(value: unknown): value is AskDecision {
  return typeof value === 'string' && (ASK_DECISIONS as readonly string[]).includes(value);
}

export type AskDecideResponse = { status: number; body: Record<string, unknown> };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const NOT_FOUND: AskDecideResponse = { status: 404, body: { error: 'No such confirmation.', code: 'not_found' } };

export async function decideAskConfirmation(input: {
  user: CurrentUser;
  headers: IntentHeaders;
  /** The parsed JSON body, untrusted. Only `confirmationId` and `decision` are read. */
  body: unknown;
  /** Injected in tests; defaults to the governed dispatcher. */
  dispatch?: RpcDispatch;
  /** Injected in tests: "now", in ms. */
  at?: number;
}): Promise<AskDecideResponse> {
  const { user } = input;

  const intent = guardAppIntent(input.headers, user, 'approval-decide');
  if (!intent.ok) {
    return { status: intent.status, body: { error: `Confirming an assistant action is done by you, in the OS: ${intent.reason}`, code: 'forbidden' } };
  }

  const raw = (input.body ?? {}) as { confirmationId?: unknown; decision?: unknown };
  const confirmationId = typeof raw.confirmationId === 'string' ? raw.confirmationId : '';
  if (!confirmationId) return { status: 400, body: { error: 'confirmationId is required', code: 'invalid' } };
  if (!isAskDecision(raw.decision)) {
    return { status: 400, body: { error: "decision must be exactly 'confirm', 'decline' or 'allow_for_conversation'", code: 'invalid' } };
  }
  const decision: AskDecision = raw.decision;
  const at = input.at;

  await ensureHydrated();
  // Not this user's, not from Ask, or not there at all: one answer, so the id cannot be probed.
  const found = getConfirmationForUser(confirmationId, user.id, { at });
  if (!found || found.surface !== 'ask') return NOT_FOUND;
  if (found.status === 'expired') {
    return { status: 410, body: { error: 'This confirmation has expired. Nothing was changed — ask again if you still want it.', code: 'expired' } };
  }
  if (found.status !== 'pending') {
    return { status: 409, body: { error: `This confirmation was already decided (${found.status}).`, code: 'not_pending', confirmationStatus: found.status } };
  }
  const domain = user.activeDomain ?? user.domains[0] ?? 'none';
  const trail = {
    confirmationId: found.id,
    tool: found.tool,
    argsHash: found.argsHash,
    conversationId: found.conversationId,
    ...(found.traceId ? { proposedInTrace: found.traceId } : {}),
  };

  if (decision === 'decline') {
    const declined = declineConfirmation(found.id, user.id, { at });
    if (!declined) return { status: 409, body: { error: 'This confirmation can no longer be declined.', code: 'not_pending' } };
    audit({ actor: user.id, action: 'assistant.decline', subject: found.tool, domain, reason: 'The user declined an action their assistant proposed; nothing was run.', detail: trail });
    return { status: 200, body: { status: 'declined', confirmationId: found.id, tool: found.tool } };
  }

  // "Allow for this conversation" exists for a short reviewed list of tools and nothing else.
  // Checked BEFORE the single-use step, so a refused request leaves the card usable.
  if (decision === 'allow_for_conversation' && !isSessionAllowable(found.tool)) {
    return { status: 400, body: { error: `'${found.tool}' cannot be allowed for a whole conversation. Confirm it on its own.`, code: 'not_allowable' } };
  }

  // THE SINGLE-USE STEP. Exactly one request ever gets past this line for an id.
  const begun = beginExecute(found.id, user.id, { at });
  if (!begun.ok) {
    if (begun.code === 'not_found') return NOT_FOUND;
    if (begun.code === 'expired') return { status: 410, body: { error: 'This confirmation has expired. Nothing was changed.', code: 'expired' } };
    return { status: 409, body: { error: 'This confirmation can no longer be used. Nothing was changed.', code: begun.code } };
  }
  const { tool, args } = begun.confirmation;

  // Second line: a tool Ask never offers must not run from here even if a record exists for it.
  const closed = askClosedReason(tool);
  if (closed) {
    finishExecute(found.id, 'failed', 'refused: not available through the assistant');
    audit({ actor: user.id, action: 'assistant.confirm', subject: tool, domain, reason: 'Refused: the tool is not available through the assistant; nothing was run.', detail: trail });
    return { status: 409, body: { error: closed, code: 'surface_closed' } };
  }

  let allowedForConversation = false;
  if (decision === 'allow_for_conversation') {
    allowedForConversation = grantSessionAllowance({ userId: user.id, conversationId: found.conversationId, tool, viaConfirmationId: found.id }).ok;
  }

  // THE STORED CALL — tool and arguments from the server's record — as this user.
  const artifacts: ChatArtifact[] = [];
  let out: { text: string; isError: boolean };
  try {
    out = await osToolExecutor(user, artifacts, input.dispatch)(tool, args);
  } catch (e) {
    out = { text: `Error: ${(e as Error).message}`, isError: true };
  }
  finishExecute(found.id, out.isError ? 'failed' : 'executed', out.isError ? `failed: ${clip(out.text, 200)}` : 'executed', { resultText: out.text });
  audit({
    actor: user.id,
    action: 'assistant.confirm',
    subject: tool,
    domain,
    reason: out.isError
      ? 'The user confirmed an action their assistant proposed; it ran as the user and did not succeed.'
      : 'The user confirmed an action their assistant proposed; it ran once, as the user.',
    detail: { ...trail, isError: out.isError, allowedForConversation },
  });
  return {
    status: 200,
    body: {
      status: out.isError ? 'failed' : 'executed',
      confirmationId: found.id,
      tool,
      isError: out.isError,
      summary: clip(out.text, 600),
      artifacts: out.isError ? [] : parseArtifacts({ artifacts }),
      allowedForConversation,
    },
  };
}
