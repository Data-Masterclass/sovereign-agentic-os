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
 *   - The conversation's short-term MEMORY (`conversation-memory.ts`: a rolling summary of the turns
 *     that fell out of the model window, and a bounded working set of what the tools touched) lives
 *     ON the record, so it has exactly the conversation's access and is deleted with it. It is
 *     written read-reduce-write (`updateConversationMemory`): the reducer runs on the record as it
 *     is NOW, and a conversation deleted meanwhile is never re-created by a late memory write.
 */
import 'server-only';
import { osMirror } from '@core/infra/os-mirror';

export type StoredStep = { name: string; isError: boolean; parked?: boolean; error?: { code: string; reason: string; hint: string } };
export type StoredPending = { confirmationId: string; tool: string };
export type StoredMessage =
  | { role: 'user'; content: string; at: string }
  | { role: 'assistant'; content: string; at: string; steps: StoredStep[]; pending: StoredPending[] };

/** One working-set entry: what the tools of ONE turn touched, every value copied verbatim from the turn. */
export type MemoryFact = {
  at: string;
  /** Each tool that ran successfully, with the id / name arguments it was called with. */
  tools: { tool: string; refs: Record<string, string> }[];
  /** SQL or semantic queries that ran, verbatim. */
  queries: string[];
  /** The governed records the answer cited. */
  sources: { of: string; id: string; name?: string }[];
  /** Key figures, each one occurring verbatim in the turn's tool results (worker-extracted, checked). */
  figures: string[];
};

export type ConversationMemory = {
  /** The rolling summary of the turns that fell out of the model window ('' = none yet). */
  summary: string;
  /** Absolute message index (see `Conversation.appended`) up to which turns are folded into `summary`. */
  foldedThrough: number;
  /** The bounded working set, oldest first. */
  facts: MemoryFact[];
  updatedAt: string;
};

export type Conversation = {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
  /** How many messages were EVER appended (messages beyond MAX_MESSAGES are cut; this keeps counting). Absent on old records = messages.length. */
  appended?: number;
  memory?: ConversationMemory;
};

export type ConversationSummary = { id: string; title: string; updatedAt: string; messageCount: number; hasSummary: boolean };

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
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messageCount: c.messages.length, hasSummary: hasSummary(c) }));
}

/** Does this conversation carry a rolling summary of earlier turns? */
export function hasSummary(c: Conversation): boolean {
  return !!c.memory && c.memory.summary.trim().length > 0;
}

/**
 * A conversation as its owner's doors return it (the GET route, the MCP `get_conversation`): the
 * memory itself stays server-side — the door says only whether a summary exists and how many
 * working-set entries are held.
 */
export function conversationView(c: Conversation): Omit<Conversation, 'memory' | 'appended'> & { hasSummary: boolean; workingSetEntries: number } {
  const { memory, appended: _appended, ...rest } = c;
  return { ...rest, hasSummary: hasSummary(c), workingSetEntries: memory?.facts.length ?? 0 };
}

/** The absolute index of the conversation's first stored message (older ones were cut at MAX_MESSAGES). */
export function firstStoredIndex(c: Conversation): number {
  return (c.appended ?? c.messages.length) - c.messages.length;
}

/**
 * Change the caller's conversation memory, read-reduce-write: `reduce` gets the memory and record as
 * they are NOW. Someone else's conversation, or one that was deleted meanwhile, is left alone (false):
 * a memory write never creates a conversation. `reduce` returning null writes nothing.
 */
export function updateConversationMemory(
  userId: string,
  id: string,
  reduce: (prev: ConversationMemory | undefined, c: Conversation) => ConversationMemory | null,
): boolean {
  const c = getConversation(userId, id);
  if (!c) return false;
  const next = reduce(c.memory, c);
  if (!next) return false;
  persist({ ...c, memory: next });
  return true;
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
  const appended = (prev ? prev.appended ?? prev.messages.length : 0) + 2;
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
    appended,
    ...(prev?.memory ? { memory: prev.memory } : {}),
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
