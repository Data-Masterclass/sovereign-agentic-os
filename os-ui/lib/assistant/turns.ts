/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/** A single conversation turn: a user or assistant message with string content. */
export type ConversationTurn = { role: 'user' | 'assistant'; content: string };

/**
 * Clean an arbitrary request `messages` array into a bounded, well-formed turn list:
 *   • drop anything that is not a user/assistant message with non-blank string content;
 *   • keep the LAST 20 turns (bounded context window);
 *   • trim each surviving message's content.
 *
 * This is the EXACT filter three streaming build/run routes hand-rolled identically
 * (app/api/apps/[id]/chat, app/api/agents/systems/[id]/run, app/api/software/team);
 * hoisted here so they stay in lockstep. Behaviour is unchanged from those copies.
 *
 * NOTE: the Software Define assistant (app/api/apps/[id]/assistant `readTurns`) uses a
 * DIFFERENT bound (last 12) and truncation (content.slice(0, 4000), no trim) — that is
 * a genuine divergence and is intentionally NOT folded into this helper.
 */
export function cleanTurns(messages: unknown): ConversationTurn[] {
  const raw = Array.isArray(messages) ? (messages as ConversationTurn[]) : [];
  return raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.trim() }));
}
