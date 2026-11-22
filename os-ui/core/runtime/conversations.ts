/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Home chat history — conversations stored per user, private by default
 * USER STORY: As a user I want my conversations kept for me and only me: listed, reopened and
 *             continued later, and invisible to every other user, on every door.
 * ARCHITECTURE:
 *   - Same shape as the confirmation and approvals stores: an in-process Map pinned to
 *     `globalThis`, with a best-effort durable mirror (`os-conversations`) through `osMirror`.
 *   - EVERY function takes the caller's user id and answers only for that user's records. A
 *     conversation of another user is indistinguishable from one that does not exist (`null`,
 *     `not_found`, `false`) — a wrong user cannot tell "not yours" from "no such thing".
 *   - A pending write's ARGUMENTS are never stored (a connection write can carry a credential);
 *     only its tool name is. After a reload the card is shown as expired and the user asks again.
 *   - Tool results are not stored — only what the user typed, what the assistant answered and a
 *     one-line trace of the tools that ran.
 */
import 'server-only';
import { osMirror } from '@core/infra/os-mirror';

export type StoredStep = { name: string; isError: boolean; parked?: boolean; error?: { code: string; reason: string; hint: string } };
export type StoredPending = { confirmationId: string; tool: string };
export type StoredMessage =
  | { role: 'user'; content: string; at: string }
  | { role: 'assistant'; content: string; at: string; steps: StoredStep[]; pending: StoredPending[] };

export type Conversation = {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
};

export type ConversationSummary = { id: string; title: string; updatedAt: string; messageCount: number };

const MAX_MESSAGES = 200;
const MAX_CONTENT = 20_000;

type State = { records: Map<string, Conversation>; hydration: Promise<void> | null };
const STATE_KEY = Symbol.for('soa.conversations.state');
function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { records: new Map(), hydration: null };
  return g[STATE_KEY]!;
}

const mirror = osMirror({ index: 'os-conversations' });
const persist = (c: Conversation) => { state().records.set(c.id, c); mirror.writeThrough(c.id, c); };

export async function ensureHydrated(): Promise<void> {
  const s = state();
  if (!s.hydration) {
    s.hydration = (async () => {
      const docs = (await mirror.hydrate(5000)) ?? [];
      for (const d of docs as Partial<Conversation>[]) {
        if (d && typeof d.id === 'string' && typeof d.userId === 'string' && Array.isArray(d.messages) && !s.records.has(d.id)) {
          s.records.set(d.id, d as Conversation);
        }
      }
    })();
  }
  return s.hydration;
}

const clip = (t: string) => (t.length > MAX_CONTENT ? `${t.slice(0, MAX_CONTENT)}…` : t);

/** The caller's conversation, or null when it is absent OR someone else's. */
export function getConversation(userId: string, id: string): Conversation | null {
  const c = state().records.get(id);
  return c && c.userId === userId ? c : null;
}

/** May this user write to this conversation id? True for a new id and for their own. */
export function canContinue(userId: string, id: string): boolean {
  const c = state().records.get(id);
  return !c || c.userId === userId;
}

export function listConversations(userId: string): ConversationSummary[] {
  return [...state().records.values()]
    .filter((c) => c.userId === userId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messageCount: c.messages.length }));
}

export type SaveTurnInput = {
  user: string;
  assistant: { content: string; steps: StoredStep[]; pending: { confirmationId: string; tool: string; args?: unknown }[] };
};

/** Append one finished turn. A conversation that exists and is not the caller's answers `not_found`. */
export function saveTurn(userId: string, id: string, turn: SaveTurnInput, at = new Date()): { ok: true } | { ok: false; code: 'not_found' } {
  if (!userId || !id) return { ok: false, code: 'not_found' };
  if (!canContinue(userId, id)) return { ok: false, code: 'not_found' };
  const now = at.toISOString();
  const prev = state().records.get(id);
  const messages: StoredMessage[] = [
    ...(prev?.messages ?? []),
    { role: 'user', content: clip(turn.user), at: now },
    {
      role: 'assistant',
      content: clip(turn.assistant.content),
      at: now,
      steps: turn.assistant.steps.map((s) => ({ name: s.name, isError: s.isError, ...(s.parked ? { parked: true } : {}), ...(s.error ? { error: s.error } : {}) })),
      // Only the tool name: the arguments of a parked write are never stored.
      pending: turn.assistant.pending.map((p) => ({ confirmationId: p.confirmationId, tool: p.tool })),
    },
  ].slice(-MAX_MESSAGES) as StoredMessage[];
  persist({
    id,
    userId,
    title: prev?.title ?? (turn.user.trim().replace(/\s+/g, ' ').slice(0, 60) || 'New chat'),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    messages,
  });
  return { ok: true };
}

export function deleteConversation(userId: string, id: string): boolean {
  const c = getConversation(userId, id);
  if (!c) return false;
  state().records.delete(id);
  mirror.deleteThrough(id);
  return true;
}

export function __resetConversations(): void {
  const s = state();
  s.records.clear();
  s.hydration = null;
  mirror.__reset();
}
export function __simulateRestart(): void {
  const s = state();
  s.records.clear();
  s.hydration = null;
}
