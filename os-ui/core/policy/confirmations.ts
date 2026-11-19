/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The user-confirmation store — a write the assistant wanted to make, waiting for the
 *             present user to say yes or no.
 * USER STORY: As a user I want the exact action I confirmed to run once, as me, and only while I
 *             am still in the conversation it was proposed in — not a different action, not twice,
 *             not for someone else, and not an hour later.
 * ARCHITECTURE:
 *   - WHO USES IT. Ask the OS only: its gate port (`core/runtime/ask-confirm.ts`) creates the
 *     records, and `POST /api/assistant/confirm` (`core/runtime/ask-decide.ts`) decides them.
 *     No MCP tool and no other route imports this module — pinned in `ask-confirm.test.ts`.
 *   - SIZE POLICY. Arguments live in this process only, never in the mirror, and a call whose
 *     arguments serialise above {@link MAX_CONFIRMATION_ARGS_BYTES} is not parked at all (the
 *     Ask port refuses it). The result text kept for the assistant's next turn is capped at
 *     {@link MAX_CONFIRMATION_RESULT_CHARS} and is in-process only as well. Decided records
 *     leave the in-process map after {@link DECIDED_RETENTION_MS} ({@link pruneConfirmations});
 *     the mirror keeps the argument-free audit row. os-ui runs as ONE replica today — a second
 *     replica would not see this map, and a Confirm landing there would answer 404.
 *   - Same shape as the approvals store (`core/policy/approvals.ts`): an in-process Map pinned to
 *     `globalThis` (one store across separately bundled route handlers), with a best-effort
 *     durable mirror through `osMirror`.
 *   - NOT an approval. An approval is a SECOND person's decision about an agent run; this is the
 *     SAME person confirming their own assistant's action. Different record, different queue,
 *     never shown in the Governance inbox.
 *   - Single use is ONE transition: `pending → executing`, taken by `beginExecute`. Everything
 *     else follows from it — a second confirm, a confirm after a decline, a confirm after expiry
 *     all find a record that is no longer `pending` and get nothing.
 */
import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { osMirror } from '@core/infra/os-mirror';
import { toolCallSignature, type PendingToolCall } from '@core/runtime/agentic';
import type { ConfirmSurface, ConfirmationPort } from '@core/runtime/confirm-gate';
import { isSessionAllowable } from '@core/mcp/tool-classes';

/** How long a confirmation stays usable — the owner's choice. */
export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

/**
 * How long an "Allow for this conversation" grant lasts. A conversation has no end event the
 * server sees, so the grant carries its own: long enough for a working session, short enough
 * that an abandoned tab does not keep an allowance overnight.
 */
export const SESSION_ALLOWANCE_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * The most a parked call's arguments may weigh (UTF-8 bytes of their JSON). They are held in
 * memory for up to ten minutes pending and {@link DECIDED_RETENTION_MS} decided, so this bounds
 * what one proposal can pin. A model-authored call is far below it; a whole file is not.
 */
export const MAX_CONFIRMATION_ARGS_BYTES = 256 * 1024;

/** The most of an executed call's result text kept for the assistant's next turn. */
export const MAX_CONFIRMATION_RESULT_CHARS = 4000;

/** How long a decided record (with its arguments and result) stays in this process. */
export const DECIDED_RETENTION_MS = SESSION_ALLOWANCE_TTL_MS;

export type ConfirmationStatus = 'pending' | 'executing' | 'executed' | 'failed' | 'declined' | 'expired';

export type Confirmation = {
  /** `cfm_` + 128 random bits (hex). Unguessable: knowing an id must not be a way to find one. */
  id: string;
  /** The ONLY user who can see, confirm or decline it. */
  userId: string;
  conversationId: string;
  surface: ConfirmSurface;
  tool: string;
  /** The full arguments, exactly as the call would run. In-process only — see `mirrorDoc`. */
  args: Record<string, unknown>;
  /** sha256 of the canonical call signature (`toolCallSignature`): what was confirmed, provably. */
  argsHash: string;
  createdAt: string;
  expiresAt: string;
  traceId?: string;
  status: ConfirmationStatus;
  /** When the status last changed away from `pending`. */
  decidedAt?: string;
  /** Set by `finishExecute`: a short account of what the execution did or why it failed. */
  outcome?: string;
  /**
   * The executed call's result text, capped — what the assistant is told on its next turn so a
   * multi-step task can use the id it just created. In-process only, like `args` (see `mirrorDoc`).
   */
  result?: string;
};

export type SessionAllowance = {
  userId: string;
  conversationId: string;
  tool: string;
  grantedAt: string;
  expiresAt: string;
  /** The confirmation on which the user chose "Allow for this conversation", when there was one. */
  viaConfirmationId?: string;
};

type ConfirmationsState = {
  records: Map<string, Confirmation>;
  allowances: Map<string, SessionAllowance>;
  hydration: Promise<void> | null;
};
const STATE_KEY = Symbol.for('soa.confirmations.state');
function state(): ConfirmationsState {
  const g = globalThis as unknown as Record<symbol, ConfirmationsState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { records: new Map(), allowances: new Map(), hydration: null };
  return g[STATE_KEY]!;
}

const mirror = osMirror({ index: 'os-confirmations' });

/**
 * What reaches the durable mirror: the record WITHOUT `args`. The arguments of a write can carry
 * a credential (`configure_connection`) or a whole file (`upload_file`), and a confirmation lives
 * ten minutes — there is no reason for either to sit in a search index. The hash stays, so the
 * audit trail still says exactly which call was confirmed.
 *
 * The consequence, on purpose: a record read back after a restart has no arguments and so cannot
 * be executed. `hydrate` marks such a `pending`/`executing` record `expired` — the user is asked
 * again rather than the server running a call it can no longer show.
 */
function mirrorDoc(c: Confirmation): Omit<Confirmation, 'args' | 'result'> {
  const { args: _args, result: _result, ...rest } = c;
  void _args;
  void _result;
  return rest;
}

function persist(c: Confirmation): void {
  state().records.set(c.id, c);
  mirror.writeThrough(c.id, mirrorDoc(c));
}

export async function ensureHydrated(): Promise<void> {
  const s = state();
  if (!s.hydration) s.hydration = hydrate();
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = state();
  const docs = (await mirror.hydrate(2000)) ?? [];
  for (const d of docs as Partial<Confirmation>[]) {
    if (!d || typeof d.id !== 'string' || s.records.has(d.id)) continue;
    const open = d.status === 'pending' || d.status === 'executing';
    // No arguments survived (see `mirrorDoc`): an open record from before the restart is dead.
    s.records.set(d.id, { ...(d as Confirmation), args: {}, status: open ? 'expired' : (d.status as ConfirmationStatus) });
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

/** sha256 (hex) of the canonical signature of a call — key order and string whitespace never matter. */
export function argsHashOf(tool: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(toolCallSignature(tool, args)).digest('hex');
}

function newId(): string {
  return `cfm_${randomBytes(16).toString('hex')}`;
}

export type CreateConfirmationInput = {
  userId: string;
  conversationId: string;
  surface: ConfirmSurface;
  tool: string;
  args: Record<string, unknown>;
  traceId?: string;
};

/** Record a call that awaits the user. `at` (ms) and `ttlMs` exist for tests and for a tighter caller. */
export function createConfirmation(input: CreateConfirmationInput, opts: { at?: number; ttlMs?: number } = {}): Confirmation {
  if (!input.userId || !input.conversationId || !input.tool) {
    throw new Error('a confirmation needs a userId, a conversationId and a tool');
  }
  const at = opts.at ?? Date.now();
  const c: Confirmation = {
    id: newId(),
    userId: input.userId,
    conversationId: input.conversationId,
    surface: input.surface,
    tool: input.tool,
    // A private copy: the caller's object must not be able to change what was confirmed.
    args: structuredClone(input.args),
    argsHash: argsHashOf(input.tool, input.args),
    createdAt: iso(at),
    expiresAt: iso(at + (opts.ttlMs ?? CONFIRMATION_TTL_MS)),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    status: 'pending',
  };
  persist(c);
  return c;
}

/** Turn a `pending` record whose time has passed into `expired`. Returns the (possibly updated) record. */
function settleExpiry(c: Confirmation, at: number): Confirmation {
  if (c.status === 'pending' && at >= Date.parse(c.expiresAt)) {
    c.status = 'expired';
    c.decidedAt = iso(at);
    persist(c);
  }
  return c;
}

/**
 * The confirmation, for ITS user. Anyone else — and any id that does not exist — gets `null`: a
 * wrong user must not be able to tell "not yours" from "no such thing".
 */
export function getConfirmationForUser(id: string, userId: string, opts: { at?: number } = {}): Confirmation | null {
  const c = state().records.get(id);
  if (!c || c.userId !== userId) return null;
  return settleExpiry(c, opts.at ?? Date.now());
}

export type BeginExecuteResult =
  | { ok: true; confirmation: Confirmation }
  | { ok: false; code: 'not_found' | 'expired' | 'not_pending' | 'args_changed'; status?: ConfirmationStatus };

/**
 * THE SINGLE-USE STEP: `pending → executing`, for the record's own user. Exactly one caller ever
 * gets `ok: true` for an id; it then runs the call with `confirmation.tool` / `.args` — never
 * with arguments from the request — and reports back through {@link finishExecute}.
 *
 * `conversationId`, when given, must match: a confirmation proposed in one conversation is not
 * usable from another. A mismatch answers `not_found`, like a wrong user.
 */
export function beginExecute(id: string, userId: string, opts: { at?: number; conversationId?: string } = {}): BeginExecuteResult {
  const c = getConfirmationForUser(id, userId, opts);
  if (!c) return { ok: false, code: 'not_found' };
  if (opts.conversationId !== undefined && opts.conversationId !== c.conversationId) return { ok: false, code: 'not_found' };
  if (c.status === 'expired') return { ok: false, code: 'expired', status: c.status };
  if (c.status !== 'pending') return { ok: false, code: 'not_pending', status: c.status };
  // The stored arguments must still be the ones that were hashed at creation. They are a private
  // copy, so this can only fail on a bug or on a record rebuilt without them — refuse either way.
  if (argsHashOf(c.tool, c.args) !== c.argsHash) {
    c.status = 'failed';
    c.decidedAt = iso(opts.at ?? Date.now());
    c.outcome = 'the stored arguments no longer match what was confirmed; not executed';
    persist(c);
    return { ok: false, code: 'args_changed', status: c.status };
  }
  c.status = 'executing';
  c.decidedAt = iso(opts.at ?? Date.now());
  persist(c);
  return { ok: true, confirmation: c };
}

/** Close an `executing` confirmation. Returns null unless THIS call made the transition. */
export function finishExecute(
  id: string,
  result: 'executed' | 'failed',
  outcome?: string,
  opts: { resultText?: string } = {},
): Confirmation | null {
  const c = state().records.get(id);
  if (!c || c.status !== 'executing') return null;
  c.status = result;
  if (outcome) c.outcome = outcome.slice(0, 500);
  if (opts.resultText) c.result = opts.resultText.slice(0, MAX_CONFIRMATION_RESULT_CHARS);
  persist(c);
  return c;
}

/** The user says no. Only a `pending` record of that user can be declined; returns null otherwise. */
export function declineConfirmation(id: string, userId: string, opts: { at?: number } = {}): Confirmation | null {
  const c = getConfirmationForUser(id, userId, opts);
  if (!c || c.status !== 'pending') return null;
  c.status = 'declined';
  c.decidedAt = iso(opts.at ?? Date.now());
  persist(c);
  return c;
}

/** Sweep: mark every overdue `pending` confirmation `expired` and drop lapsed grants. Returns how many expired. */
export function expireConfirmations(opts: { at?: number } = {}): number {
  const at = opts.at ?? Date.now();
  let n = 0;
  for (const c of state().records.values()) {
    if (c.status !== 'pending') continue;
    if (settleExpiry(c, at).status === 'expired') n += 1;
  }
  for (const [key, a] of state().allowances) {
    if (at >= Date.parse(a.expiresAt)) state().allowances.delete(key);
  }
  return n;
}

/** The user's still-pending confirmations in one conversation, oldest first. */
export function listPendingForConversation(userId: string, conversationId: string, opts: { at?: number } = {}): Confirmation[] {
  const at = opts.at ?? Date.now();
  return [...state().records.values()]
    .filter((c) => c.userId === userId && c.conversationId === conversationId)
    .map((c) => settleExpiry(c, at))
    .filter((c) => c.status === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const DECIDED: ReadonlySet<ConfirmationStatus> = new Set(['executed', 'failed', 'declined', 'expired']);

/**
 * The user's DECIDED confirmations in one conversation (executed, failed, declined, expired),
 * oldest first, at most the last `limit`. This is what the assistant is told happened — read
 * from the record, never from the chat text.
 */
export function listDecidedForConversation(
  userId: string,
  conversationId: string,
  opts: { at?: number; limit?: number } = {},
): Confirmation[] {
  const at = opts.at ?? Date.now();
  const all = [...state().records.values()]
    .filter((c) => c.userId === userId && c.conversationId === conversationId)
    .map((c) => settleExpiry(c, at))
    .filter((c) => DECIDED.has(c.status))
    .sort((a, b) => (a.decidedAt ?? a.createdAt).localeCompare(b.decidedAt ?? b.createdAt));
  return all.slice(-(opts.limit ?? 12));
}

/** The still-pending confirmation for exactly this call in this conversation, if there is one. */
export function findPendingForCall(
  request: { userId: string; conversationId: string; tool: string; argsHash: string },
  opts: { at?: number } = {},
): Confirmation | null {
  return (
    listPendingForConversation(request.userId, request.conversationId, opts).find(
      (c) => c.tool === request.tool && c.argsHash === request.argsHash,
    ) ?? null
  );
}

/** How many times this user declined exactly this call (tool + arguments hash) in this conversation. */
export function declinedCountForCall(request: { userId: string; conversationId: string; tool: string; argsHash: string }): number {
  let n = 0;
  for (const c of state().records.values()) {
    if (c.status !== 'declined') continue;
    if (c.userId !== request.userId || c.conversationId !== request.conversationId) continue;
    if (c.tool === request.tool && c.argsHash === request.argsHash) n += 1;
  }
  return n;
}

/**
 * Drop DECIDED records older than `olderThanMs` from this process (their arguments and result
 * with them). The durable mirror is not touched: the argument-free audit row stays. Returns how
 * many were dropped.
 */
export function pruneConfirmations(opts: { at?: number; olderThanMs?: number } = {}): number {
  const at = opts.at ?? Date.now();
  const cutoff = at - (opts.olderThanMs ?? DECIDED_RETENTION_MS);
  let n = 0;
  for (const [id, c] of state().records) {
    if (!DECIDED.has(c.status)) continue;
    if (Date.parse(c.decidedAt ?? c.createdAt) > cutoff) continue;
    state().records.delete(id);
    n += 1;
  }
  return n;
}

// --- "Allow for this conversation" -------------------------------------------------------------

const allowanceKey = (userId: string, conversationId: string, tool: string) => JSON.stringify([userId, conversationId, tool]);

export type GrantResult = { ok: true; allowance: SessionAllowance } | { ok: false; code: 'not_allowable' | 'invalid' };

/**
 * Record that this user allows this tool for the rest of this conversation. REFUSED for any tool
 * outside `SESSION_ALLOWABLE_TOOLS` — the set is the whole policy, and it is checked here (so a
 * grant cannot be created) AND in {@link sessionAllows} (so one that somehow exists is not honoured).
 * In-process only: an allowance does not survive a restart, and the user is simply asked again.
 */
export function grantSessionAllowance(
  input: { userId: string; conversationId: string; tool: string; viaConfirmationId?: string },
  opts: { at?: number; ttlMs?: number } = {},
): GrantResult {
  if (!input.userId || !input.conversationId || !input.tool) return { ok: false, code: 'invalid' };
  if (!isSessionAllowable(input.tool)) return { ok: false, code: 'not_allowable' };
  const at = opts.at ?? Date.now();
  const allowance: SessionAllowance = {
    userId: input.userId,
    conversationId: input.conversationId,
    tool: input.tool,
    grantedAt: iso(at),
    expiresAt: iso(at + (opts.ttlMs ?? SESSION_ALLOWANCE_TTL_MS)),
    ...(input.viaConfirmationId ? { viaConfirmationId: input.viaConfirmationId } : {}),
  };
  state().allowances.set(allowanceKey(input.userId, input.conversationId, input.tool), allowance);
  return { ok: true, allowance };
}

/** Is there a live allowance for exactly this (user, conversation, tool)? */
export function sessionAllows(request: { userId: string; conversationId: string; tool: string }, opts: { at?: number } = {}): boolean {
  if (!isSessionAllowable(request.tool)) return false;
  const key = allowanceKey(request.userId, request.conversationId, request.tool);
  const a = state().allowances.get(key);
  if (!a) return false;
  if ((opts.at ?? Date.now()) >= Date.parse(a.expiresAt)) {
    state().allowances.delete(key);
    return false;
  }
  return true;
}

/** Withdraw every allowance of one conversation (or one tool of it). Returns how many were removed. */
export function revokeSessionAllowances(userId: string, conversationId: string, tool?: string): number {
  let n = 0;
  for (const [key, a] of state().allowances) {
    if (a.userId !== userId || a.conversationId !== conversationId) continue;
    if (tool !== undefined && a.tool !== tool) continue;
    state().allowances.delete(key);
    n += 1;
  }
  return n;
}

// --- the gate's port ---------------------------------------------------------------------------

/** The store, in the shape `userConfirmGate` asks for. The gate itself never imports this module. */
export function confirmationPort(): ConfirmationPort {
  return {
    create: (request): PendingToolCall => {
      const c = createConfirmation(request);
      return { confirmationId: c.id, tool: c.tool, args: c.args, expiresAt: c.expiresAt };
    },
    sessionAllows: (request) => sessionAllows(request),
  };
}

/** Test-only: how many confirmation records this process holds, in any state. */
export function __countConfirmations(): number {
  return state().records.size;
}

/** Test-only: drop everything so each test starts clean. */
export function __resetConfirmations(): void {
  const s = state();
  s.records.clear();
  s.allowances.clear();
  s.hydration = null;
  mirror.__reset();
}

/** Test-only: a pod restart — the in-process state is gone, the durable mirror is untouched. */
export function __simulateRestart(): void {
  const s = state();
  s.records.clear();
  s.allowances.clear();
  s.hydration = null;
}
