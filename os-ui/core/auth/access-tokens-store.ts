/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The personal-access-token records — created, listed by prefix, revoked, resolved
 * USER STORY: As an engineer I want the token I created in Platform → Access tokens to map to
 *             exactly one OS identity for as long as I keep it, to be listed afterwards by its
 *             prefix and metadata only, and to stop working the moment I revoke it (E-R2.1/2.2).
 * ARCHITECTURE:
 *   - The same in-memory + durable-mirror discipline as `core/notifications/store.ts`: the process
 *     holds the records, `osMirror` persists them, hydration is lazy and an EMPTY mirror hydrates
 *     to "this tenant owns no tokens" rather than throwing.
 *   - A record NEVER holds the plaintext token — only `prefix` (public) and `hash`
 *     (`sha256$…`, from `access-tokens.ts`). `create()` is the one and only place the plaintext
 *     exists, and it returns it to its caller once.
 *   - `resolve()` is the hot path (every git request): look the record up by its PUBLIC prefix,
 *     then `timingSafeEqual` the digest. It returns a typed reason — `unknown` / `revoked` /
 *     `expired` — so `/api/git/authenticate` can answer 401 without ever saying which token.
 *   - Expiry is optional and bounded by `MAX_TTL_DAYS`; `scope` exists so a later token kind
 *     ('git' today) cannot be mistaken for this one. Resolution NEVER widens identity: it yields a
 *     user id, and the caller re-reads the LIVE principal through `principalById`.
 */
import { osMirror } from '@core/infra/os-mirror';
import { mintToken, parseAccessToken, tokenMatches } from '@core/auth/access-tokens';

/** What a token may be used for. One value today; the field stops a future kind being confused. */
export type TokenScope = 'git';

/**
 * What a token may DO inside the repos its owner may read. `read` refuses every push (a clone,
 * fetch or CI export credential); `write` is what a token was before WP-51, and the default.
 */
export type TokenAccess = 'read' | 'write';

/** The most repositories one token may be narrowed to. */
export const MAX_TOKEN_REPOS = 20;

/** The longest life a token may be given (and the default when none is asked for). */
export const MAX_TTL_DAYS = 365;

export type AccessTokenRecord = {
  id: string;
  /** The public lookup handle — safe to show and to log. */
  prefix: string;
  /** `sha256$<hex>`. Never the token. */
  hash: string;
  /** The ONE OS identity this token acts as. */
  userId: string;
  /** The user's own label ("laptop", "VS Code at home"). */
  name: string;
  scope: TokenScope;
  /** Absent on a token minted before WP-51 — read as `write`, which is what it could do. */
  access?: TokenAccess;
  /**
   * Narrow the token to these repositories (names as in the clone URL). Absent or empty = every
   * repository the owner may read. NEVER widens: the owner's live access is checked first.
   */
  repos?: string[];
  createdAt: number;
  /** Epoch ms; 0 = never expires. */
  expiresAt: number;
  revokedAt: number;
  lastUsedAt: number;
};

/** Everything a list may show: metadata and the prefix, never the hash. */
export type AccessTokenView = Omit<AccessTokenRecord, 'hash'>;

type TokenState = { items: AccessTokenRecord[]; hydration: Promise<void> | null };
const KEY = Symbol.for('soa.access-tokens.store');
function state(): TokenState {
  const g = globalThis as unknown as Record<symbol, TokenState | undefined>;
  if (!g[KEY]) g[KEY] = { items: [], hydration: null };
  return g[KEY]!;
}

const mirror = osMirror({
  index: 'os-access-tokens',
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        prefix: { type: 'keyword' },
        hash: { type: 'keyword' },
        userId: { type: 'keyword' },
        name: { type: 'text' },
        scope: { type: 'keyword' },
        access: { type: 'keyword' },
        repos: { type: 'keyword' },
        createdAt: { type: 'date' },
        expiresAt: { type: 'date' },
        revokedAt: { type: 'date' },
        lastUsedAt: { type: 'date' },
      },
    },
  },
});

export async function ensureHydrated(): Promise<void> {
  const s = state();
  if (!s.hydration) s.hydration = hydrate();
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = state();
  const docs = (await mirror.hydrate(2000)) ?? [];
  for (const rec of docs as AccessTokenRecord[]) {
    if (rec && rec.id && rec.prefix && rec.hash && !s.items.some((t) => t.id === rec.id)) s.items.push(rec);
  }
}

/** Test seam: forget every record in this process. */
export function __resetAccessTokens(): void {
  const s = state();
  s.items = [];
  s.hydration = null;
}

function view(rec: AccessTokenRecord): AccessTokenView {
  const { hash: _hash, ...rest } = rec;
  return rest;
}

let seq = 0;

/**
 * Mint a token for a user. Returns the record's VIEW plus the plaintext, which the caller shows
 * once and then forgets. The plaintext is not persisted, not logged and not recoverable.
 */
export function createAccessToken(input: {
  userId: string;
  name: string;
  ttlDays?: number;
  scope?: TokenScope;
  access?: TokenAccess;
  repos?: string[];
  now?: number;
}): { token: string; record: AccessTokenView } {
  const userId = String(input.userId ?? '').trim();
  if (!userId) throw tokenError('a token needs an owner', 400);
  const name = String(input.name ?? '').trim();
  if (!name) throw tokenError('a token needs a name — you will see it in the list, not the token', 400);
  const now = input.now ?? Date.now();
  const ttl = Math.min(Math.max(Math.trunc(input.ttlDays ?? MAX_TTL_DAYS), 1), MAX_TTL_DAYS);
  const access: TokenAccess = input.access ?? 'write';
  if (access !== 'read' && access !== 'write') throw tokenError("a token's access is 'read' or 'write'", 400);
  const repos = [...new Set((input.repos ?? []).map((r) => String(r ?? '').trim()).filter(Boolean))];
  if (repos.length > MAX_TOKEN_REPOS) throw tokenError(`a token may be narrowed to at most ${MAX_TOKEN_REPOS} repositories`, 400);
  for (const r of repos) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r) || r.includes('..')) throw tokenError(`'${r.slice(0, 64)}' is not a repository name`, 400);
  }
  const minted = mintToken();
  const rec: AccessTokenRecord = {
    id: `pat_${now.toString(36)}_${++seq}`,
    prefix: minted.prefix,
    hash: minted.hash,
    userId,
    name: name.slice(0, 120),
    scope: input.scope ?? 'git',
    access,
    ...(repos.length ? { repos } : {}),
    createdAt: now,
    expiresAt: now + ttl * 24 * 60 * 60 * 1000,
    revokedAt: 0,
    lastUsedAt: 0,
  };
  state().items.push(rec);
  mirror.writeThrough(rec.id, rec);
  return { token: minted.token, record: view(rec) };
}

/** A user's own tokens, newest first — prefix and metadata only. */
export function listAccessTokens(userId: string): AccessTokenView[] {
  return state()
    .items.filter((t) => t.userId === userId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(view);
}

/**
 * Revoke one of the caller's OWN tokens. A token belonging to someone else is reported as
 * not-found, never as forbidden — a 403 would confirm the id exists.
 */
export function revokeAccessToken(userId: string, id: string, now = Date.now()): AccessTokenView {
  const rec = state().items.find((t) => t.id === id && t.userId === userId);
  if (!rec) throw tokenError('no such token', 404);
  if (!rec.revokedAt) {
    rec.revokedAt = now;
    mirror.writeThrough(rec.id, rec);
  }
  return view(rec);
}

export type ResolveFailure = 'malformed' | 'unknown' | 'revoked' | 'expired';
export type ResolveResult =
  | { ok: true; userId: string; tokenId: string; prefix: string; access: TokenAccess; repos: string[] }
  | { ok: false; reason: ResolveFailure };

/**
 * Resolve a presented token to its owner's id. The failure reason is for the SERVER's log (where
 * only the prefix is ever written) — every failure is the same 401 to the client.
 */
export function resolveAccessToken(presented: string, opts: { scope?: TokenScope; now?: number } = {}): ResolveResult {
  const parsed = parseAccessToken(presented);
  if (!parsed) return { ok: false, reason: 'malformed' };
  const now = opts.now ?? Date.now();
  const scope = opts.scope ?? 'git';
  const candidates = state().items.filter((t) => t.prefix === parsed.prefix && t.scope === scope);
  for (const rec of candidates) {
    if (!tokenMatches(presented, rec.hash)) continue;
    if (rec.revokedAt) return { ok: false, reason: 'revoked' };
    if (rec.expiresAt && rec.expiresAt <= now) return { ok: false, reason: 'expired' };
    rec.lastUsedAt = now;
    mirror.writeThrough(rec.id, rec);
    return { ok: true, userId: rec.userId, tokenId: rec.id, prefix: rec.prefix, access: rec.access ?? 'write', repos: rec.repos ?? [] };
  }
  return { ok: false, reason: 'unknown' };
}

function tokenError(message: string, status: number): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}
