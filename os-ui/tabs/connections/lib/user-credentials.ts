/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    Per-user credentials of a connection: each user's own OAuth sign-in, kept in the vault
 * USER STORY: As a user I want to connect my OWN Notion, Microsoft or Google account to a connection
 *             my admin set up, so that the chat reads only what I may read, and nobody else can run on
 *             my sign-in.
 * ARCHITECTURE:
 *   - One vault entry per (connection, user): ref `<connection secret name>-u-<sha256(id, user)[:16]>`, key
 *     `user-oauth`. The value is JSON `{ v, tokens, subject, connectedAt, reg? }` and lives ONLY in the
 *     secrets store (`@core/infra/secrets`: encrypted and durable once the Kubernetes backend is on);
 *     the connection record never holds it, the OS database never holds it, no trace or response does.
 *   - The ref is DERIVED from (connection id, user). A small per-connection index (the user ids that
 *     have a sign-in, no secret) lives beside it in the same store, so deleting a connection purges
 *     every user's entry; revoke-on-deactivation walks the per-user connections.
 *   - `UserCredentialStore` is the seam the LiteLLM MCP gateway replaces: there the store seeds the
 *     user's token into LiteLLM (`POST /v1/mcp/server/{id}/oauth-user-credential`) under an OS-minted,
 *     OS-held per-user key, and LiteLLM refreshes. Callers only use this interface.
 *   - Refreshes are serialised per (connection, user) IN THIS PROCESS: Notion rotates refresh tokens and
 *     a replayed one can revoke the whole grant. Only os-ui (one replica on dev) refreshes account
 *     tokens; a second process or replica would need a store-level conditional write (#334 follow-up).
 */
import 'server-only';
import { createHash } from 'crypto';
import { putSecret, getSecretServerSide, deleteSecret, hasSecret, type SecretRef } from '@core/infra/secrets';
import type { TokenSet } from '@core/auth/token-set';
import type { NotionClientReg } from '@core/auth/notion-mcp';

/** What one user's stored credential carries (server-side only). */
export type UserCredential = {
  tokens: TokenSet;
  /** The account the user signed in with (e-mail / UPN), for "Connected as …" and the audit. */
  subject?: string;
  connectedAt: string;
  /** Notion: the dynamically registered client the token belongs to. */
  reg?: NotionClientReg;
};

/** The seam: the vault today, the LiteLLM MCP gateway later. */
export type UserCredentialStore = {
  get(connection: { id: string; secretRef: SecretRef }, userId: string): UserCredential | null;
  put(connection: { id: string; secretRef: SecretRef }, userId: string, cred: UserCredential): void;
  remove(connection: { id: string; secretRef: SecretRef }, userId: string): void;
  has(connection: { id: string; secretRef: SecretRef }, userId: string): boolean;
  /** The users with a stored sign-in on this connection (ids only). */
  users(connection: { id: string; secretRef: SecretRef }): string[];
};

/** The derived vault ref of one user's credential on one connection. Pure. */
export function userCredentialRef(connection: { id: string; secretRef: SecretRef }, userId: string): SecretRef {
  // The connection id is part of the hash: a connection deleted and re-created under the same name
  // (same secret name) never inherits the old connection's sign-ins.
  const h = createHash('sha256').update(`${connection.id}\u0000user:${userId}`).digest('hex').slice(0, 16);
  return { name: `${connection.secretRef.name}-u-${h}`, key: 'user-oauth' };
}

/** The stored value as a credential; null when nothing is stored. A value that is not ours throws (a real fault). */
function parse(raw: string | null): UserCredential | null {
  if (!raw) return null;
  const o = JSON.parse(raw) as { v?: number; tokens?: TokenSet; subject?: string; connectedAt?: string; reg?: NotionClientReg };
  if (!o || o.v !== 1 || !o.tokens || typeof o.tokens.accessToken !== 'string' || !o.tokens.accessToken) {
    throw new Error('A stored account sign-in is unreadable; disconnect and connect the account again.');
  }
  return {
    tokens: o.tokens,
    ...(typeof o.subject === 'string' && o.subject ? { subject: o.subject } : {}),
    connectedAt: typeof o.connectedAt === 'string' ? o.connectedAt : '',
    ...(o.reg && typeof o.reg.clientId === 'string' ? { reg: o.reg } : {}),
  };
}

/** The per-connection index of user ids with a sign-in (not a secret; kept beside the entries). */
export function userIndexRef(connection: { id: string; secretRef: SecretRef }): SecretRef {
  const h = createHash('sha256').update(`${connection.id}\u0000index`).digest('hex').slice(0, 16);
  return { name: `${connection.secretRef.name}-u-${h}`, key: 'user-index' };
}

function readIndex(c: { id: string; secretRef: SecretRef }): string[] {
  const raw = getSecretServerSide(userIndexRef(c));
  if (!raw) return [];
  const v: unknown = JSON.parse(raw);
  if (!Array.isArray(v)) throw new Error('The per-user sign-in index of a connection is unreadable.');
  return v.filter((x): x is string => typeof x === 'string');
}

function writeIndex(c: { id: string; secretRef: SecretRef }, ids: string[]): void {
  const ref = userIndexRef(c);
  if (ids.length === 0) deleteSecret(ref);
  else putSecret(ref.name, ref.key, JSON.stringify([...new Set(ids)].sort()));
}

export const vaultUserCredentialStore: UserCredentialStore = {
  get: (c, u) => parse(getSecretServerSide(userCredentialRef(c, u))),
  put: (c, u, cred) => {
    const ref = userCredentialRef(c, u);
    putSecret(ref.name, ref.key, JSON.stringify({ v: 1, ...cred }));
    const ids = readIndex(c);
    if (!ids.includes(u)) writeIndex(c, [...ids, u]);
  },
  remove: (c, u) => {
    deleteSecret(userCredentialRef(c, u));
    const ids = readIndex(c);
    if (ids.includes(u)) writeIndex(c, ids.filter((x) => x !== u));
  },
  has: (c, u) => hasSecret(userCredentialRef(c, u)),
  users: (c) => readIndex(c),
};

let active: UserCredentialStore = vaultUserCredentialStore;
export function userCredentials(): UserCredentialStore {
  return active;
}
/** Swap the backend (the gateway backend, or a test double). */
export function setUserCredentialStore(s: UserCredentialStore | null): void {
  active = s ?? vaultUserCredentialStore;
}

// ------------------------------------------------------------ refresh serialisation ---

const LOCKS = Symbol.for('soa.connections.user-cred.locks');
function locks(): Map<string, Promise<unknown>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<unknown>> | undefined>;
  if (!g[LOCKS]) g[LOCKS] = new Map();
  return g[LOCKS]!;
}

/** Run `fn` with no other refresh of the same (connection, user) in flight. */
export async function serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const m = locks();
  const prev = m.get(key) ?? Promise.resolve();
  // Run after the previous holder settles, whatever its outcome (its failure is its caller's).
  const next = prev.then(fn, fn);
  m.set(key, next);
  try {
    return await next;
  } finally {
    if (m.get(key) === next) m.delete(key);
  }
}
