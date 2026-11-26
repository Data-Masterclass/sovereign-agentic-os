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
 *     is NOW, and a conversation deleted meanwhile is never re-created by a late memory write. The
 *     mirror gets a PARTIAL update of the `memory` field only (`patchThrough`, no upsert): it can
 *     neither put back a stale copy of the messages nor resurrect a record deleted elsewhere. A
 *     record's `generation` (minted at creation) tells a re-created conversation with the same id
 *     from the one a late memory update was computed for. A stored memory of the wrong shape is
 *     ignored on load (`normaliseMemory`), never trusted and never fatal.
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
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
  /** Minted when the record is created: a delete + re-create under the same id is a new generation. */
  generation?: string;
  memory?: ConversationMemory;
};

const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
function isFact(v: unknown): v is MemoryFact {
  const f = v as MemoryFact | null;
  return !!f && typeof f === 'object' && isStr(f.at) && isStrArr(f.queries) && isStrArr(f.figures)
    && Array.isArray(f.tools) && f.tools.every((t) => !!t && isStr(t.tool) && !!t.refs && typeof t.refs === 'object' && !Array.isArray(t.refs) && Object.values(t.refs).every(isStr))
    && Array.isArray(f.sources) && f.sources.every((x) => !!x && isStr(x.of) && isStr(x.id) && (x.name === undefined || isStr(x.name)));
}

/** A stored memory of the expected shape, or undefined (a bad or foreign shape is ignored, never trusted). */
export function normaliseMemory(raw: unknown): ConversationMemory | undefined {
  const m = raw as ConversationMemory | null | undefined;
  if (!m || typeof m !== 'object') return undefined;
  if (!isStr(m.summary) || typeof m.foldedThrough !== 'number' || !Number.isFinite(m.foldedThrough) || m.foldedThrough < 0) return undefined;
  if (!Array.isArray(m.facts) || !m.facts.every(isFact) || !isStr(m.updatedAt)) return undefined;
  return m;
}

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
          const rec = { ...d } as Conversation;
          const memory = normaliseMemory(d.memory);
          if (d.memory !== undefined && !memory) console.warn(`[memory] conversation ${d.id}: the stored memory has an unexpected shape and is ignored`);
          if (memory) rec.memory = memory; else delete rec.memory;
          s.records.set(d.id, rec);
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
  const m = normaliseMemory(c.memory);
  return !!m && m.summary.trim().length > 0;
}

/**
 * A conversation as its owner's doors return it (the GET route, the MCP `get_conversation`): the
 * memory itself stays server-side — the door says only whether a summary exists and how many
 * working-set entries are held.
 */
export function conversationView(c: Conversation): Omit<Conversation, 'memory' | 'appended' | 'generation'> & { hasSummary: boolean; workingSetEntries: number } {
  const { memory: _memory, appended: _appended, generation: _generation, ...rest } = c;
  const memory = normaliseMemory(c.memory);
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
  const next = reduce(normaliseMemory(c.memory), c);
  if (!next) return false;
  state().records.set(id, { ...c, memory: next });
  // Only the memory field reaches the mirror, and never as an upsert.
  mirror.patchThrough(id, { set: { memory: next }, unset: [] });
  return true;
}

/** The caller's conversation memory, if it has a valid one. */
export function getConversationMemory(userId: string, id: string): ConversationMemory | undefined {
  const c = getConversation(userId, id);
  return c ? normaliseMemory(c.memory) : undefined;
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
    generation: prev ? prev.generation ?? prev.createdAt : randomUUID(),
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
