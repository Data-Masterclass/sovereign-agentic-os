/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import { config } from '@/lib/config';
import type { Role } from '@/lib/session';
import { createHash } from 'node:crypto';
import { hashPassword, verifyPassword, isHashed } from '@/lib/password';

/**
 * User directory — a pragmatic, self-hosted identity store (the seam Ory would
 * replace later). It is SECURE BY DEFAULT:
 *
 *  - Passwords are stored ONLY as scrypt hashes (lib/password.ts) — never
 *    plaintext, never logged, never returned to a client.
 *  - The shipped build seeds NO real/fake users. On an empty store a single
 *    first-run bootstrap admin (`admin`/`admin`) is created, flagged
 *    `mustChangeCredentials` + `bootstrap`. The forced setup (setupAdmin) gives
 *    it a real email + strong password and DISABLES the default credential; on
 *    email verification the bootstrap tombstone is auto-deleted. So `admin/admin`
 *    is never usable past first-run.
 *  - A single high-entropy master recovery key (hash only, server-side) can reset
 *    a locked-out account.
 *
 * Persistence mirrors the artifact store: an authoritative in-process cache (so
 * it works with no cluster) plus a best-effort OpenSearch mirror ("os-users")
 * for durability in a real deploy. Only hashes ever reach the mirror.
 */

export type StoredUser = {
  id: string;
  name: string;
  /** scrypt hash — NEVER plaintext. */
  password: string;
  domains: string[];
  role: Role;
  email?: string;
  emailVerified?: boolean;
  /** Forces the post-first-login email+strong-password setup. */
  mustChangeCredentials?: boolean;
  /** True only for the first-run default-credential row (and its tombstone). */
  bootstrap?: boolean;
  /** First-login onboarding wizard completed. */
  onboarded?: boolean;
  /** Disabled rows cannot authenticate (e.g. the neutralised bootstrap admin). */
  disabled?: boolean;
  createdAt?: number;
  updatedAt?: number;
};

export type PublicUser = {
  id: string;
  name: string;
  domains: string[];
  role: Role;
  email?: string;
  emailVerified?: boolean;
  mustChangeCredentials?: boolean;
  bootstrap?: boolean;
  onboarded?: boolean;
};

const META_ID = '__meta__';
const BOOTSTRAP_ID = 'admin';
const BOOTSTRAP_TOMBSTONE_ID = '__bootstrap_tombstone__';
const RESERVED_IDS = new Set([META_ID, BOOTSTRAP_TOMBSTONE_ID]);
const VERIFY_TTL_MS = 1000 * 60 * 60 * 24; // 24h single-use verification window

type PendingVerify = { tokenHash: string; userId: string; expiresAt: number };
type Meta = { recoveryHash?: string; initialized?: boolean; pendingVerify?: PendingVerify };

let cache: Map<string, StoredUser> | null = null;
let meta: Meta = {};
let osHealthy = false;

// Single-use email-verification tokens (in-memory fast path). Keyed by a
// SHA-256 of the token so the raw token is never held in memory either. The
// authoritative copy is mirrored into `meta.pendingVerify` so verification
// survives a process restart / a second replica.
const verifyTokens = new Map<string, { userId: string; expiresAt: number }>();

// A constant, valid scrypt hash used to equalise authentication timing for
// unknown handles (so response time does not reveal whether an account exists).
// Lazily computed once; the plaintext behind it is irrelevant and never matched.
let dummyHash: string | null = null;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function isReserved(id: string): boolean {
  return RESERVED_IDS.has(id) || id.startsWith('__');
}

/** id-exact match first, then a unique email match — never an ambiguous find. */
function findByHandle(map: Map<string, StoredUser>, handle: string): StoredUser | undefined {
  const h = handle.trim().toLowerCase();
  const users = visible(map);
  return users.find((u) => u.id.toLowerCase() === h) ?? users.find((u) => u.email?.toLowerCase() === h);
}

/** True if some OTHER user already owns this email (case-insensitive). */
function emailTaken(map: Map<string, StoredUser>, email: string, exceptId?: string): boolean {
  const e = email.trim().toLowerCase();
  if (!e) return false;
  return visible(map).some((u) => u.id !== exceptId && u.email?.toLowerCase() === e);
}

async function bootstrapAdmin(): Promise<StoredUser> {
  return {
    id: BOOTSTRAP_ID,
    name: 'Platform Admin',
    password: await hashPassword('admin'),
    domains: ['platform'],
    role: 'admin',
    bootstrap: true,
    mustChangeCredentials: true,
    emailVerified: false,
    onboarded: false,
    createdAt: Date.now(),
  };
}

/**
 * Optional operator pre-seed via OS_USERS (a JSON array). This is NOT shipped —
 * it is an operator's own real users. Plaintext passwords supplied here are
 * hashed on ingest so nothing is stored in the clear. Empty/invalid → bootstrap.
 */
async function loadSeed(): Promise<StoredUser[]> {
  if (!config.usersSeed) return [await bootstrapAdmin()];
  try {
    const parsed = JSON.parse(config.usersSeed);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const out: StoredUser[] = [];
      for (const u of parsed as Record<string, unknown>[]) {
        const id = String(u.id ?? '').trim().toLowerCase();
        if (!id || isReserved(id)) continue;
        const rawPw = String(u.password ?? '');
        out.push({
          id,
          name: String(u.name ?? id),
          password: isHashed(rawPw) ? rawPw : await hashPassword(rawPw || 'changeme'),
          domains: Array.isArray(u.domains)
            ? u.domains.map(String)
            : u.domain
              ? [String(u.domain)]
              : ['default'],
          role: (['participant', 'creator', 'builder', 'admin'].includes(String(u.role)) ? u.role : 'participant') as Role,
          emailVerified: true,
          onboarded: false,
          createdAt: Date.now(),
        });
      }
      if (out.length > 0) return out;
    }
  } catch {
    /* fall through */
  }
  return [await bootstrapAdmin()];
}

async function osFetch(path: string, init?: RequestInit): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    return await fetch(`${config.opensearchUrl}${path}`, {
      ...init,
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function writeThrough(u: StoredUser): void {
  if (!osHealthy) return;
  void osFetch(`/os-users/_doc/${u.id}?refresh=true`, { method: 'PUT', body: JSON.stringify(u) });
}

function persistMeta(): void {
  if (!osHealthy) return;
  void osFetch(`/os-users/_doc/${META_ID}?refresh=true`, { method: 'PUT', body: JSON.stringify({ id: META_ID, ...meta }) });
}

async function getCache(): Promise<Map<string, StoredUser>> {
  if (cache) return cache;
  const map = new Map<string, StoredUser>();
  const ping = await osFetch('/os-users/_count');
  if (ping && ping.ok) {
    osHealthy = true;
    const res = await osFetch('/os-users/_search?size=1000', {
      method: 'POST',
      body: JSON.stringify({ query: { match_all: {} } }),
    });
    if (res && res.ok) {
      const data = (await res.json()) as {
        hits?: { hits?: { _source: StoredUser & Meta }[] };
      };
      for (const h of data?.hits?.hits ?? []) {
        const src = h._source;
        if (src.id === META_ID) {
          meta = { recoveryHash: src.recoveryHash, initialized: src.initialized, pendingVerify: src.pendingVerify };
          continue;
        }
        map.set(src.id, src);
      }
    }
    // Seed the first-run bootstrap admin ONLY on a never-initialised store. Once
    // a deployment has been set up (meta.initialized), an empty user map means
    // every account was removed — we must NOT silently resurrect admin/admin;
    // recovery is via the master key. This closes the default-credential
    // resurrection path.
    if (map.size === 0 && !meta.initialized) {
      for (const u of await loadSeed()) { map.set(u.id, u); writeThrough(u); }
      meta.initialized = true;
      persistMeta();
    }
  } else {
    osHealthy = false;
    // Offline/in-memory mode (no durability): seed only when nothing is loaded.
    if (map.size === 0 && !meta.initialized) {
      for (const u of await loadSeed()) map.set(u.id, u);
      meta.initialized = true;
    }
  }
  cache = map;
  return map;
}

function publicOf(u: StoredUser): PublicUser {
  return {
    id: u.id,
    name: u.name,
    domains: u.domains,
    role: u.role,
    email: u.email,
    emailVerified: u.emailVerified,
    mustChangeCredentials: u.mustChangeCredentials,
    bootstrap: u.bootstrap,
    onboarded: u.onboarded,
  };
}

function err(message: string, status: number): Error {
  const e = new Error(message);
  (e as Error & { status?: number }).status = status;
  return e;
}

/** Visible (non-reserved, non-tombstone) users only. */
function visible(map: Map<string, StoredUser>): StoredUser[] {
  return [...map.values()].filter((u) => !isReserved(u.id));
}

export async function authenticate(username: string, password: string): Promise<PublicUser | null> {
  const map = await getCache();
  const u = findByHandle(map, username);
  if (!u || u.disabled) {
    // Run a dummy verify so an unknown/disabled handle takes the same time as a
    // real one — no response-time oracle for account enumeration.
    if (!dummyHash) dummyHash = await hashPassword('timing-equaliser');
    await verifyPassword(password, dummyHash);
    return null;
  }
  const ok = await verifyPassword(password, u.password);
  if (!ok) return null;
  return publicOf(u);
}

export async function listUsers(): Promise<PublicUser[]> {
  const map = await getCache();
  return visible(map).map(publicOf).sort((a, b) => a.id.localeCompare(b.id));
}

/** Account flags for the signed-in user (drives the bootstrap/onboarding gates). */
export async function getPublicUser(id: string): Promise<PublicUser | null> {
  const map = await getCache();
  const u = map.get(id);
  return u && !isReserved(u.id) ? publicOf(u) : null;
}

export async function createUser(input: {
  id: string;
  name?: string;
  password: string;
  domains: string[];
  role: Role;
  email?: string;
}): Promise<PublicUser> {
  const map = await getCache();
  const id = input.id.trim().toLowerCase();
  if (!id) throw err('A username is required', 400);
  if (isReserved(id)) throw err('That username is reserved', 400);
  if (map.has(id)) throw err('That username already exists', 409);
  if (!input.password) throw err('A password is required', 400);
  if (!input.domains?.length) throw err('At least one domain is required', 400);
  if (input.email && emailTaken(map, input.email)) throw err('That email is already in use', 409);
  const u: StoredUser = {
    id,
    name: input.name?.trim() || id,
    password: await hashPassword(input.password),
    domains: input.domains,
    role: input.role,
    email: input.email?.trim() || undefined,
    emailVerified: input.email ? false : undefined,
    onboarded: false,
    createdAt: Date.now(),
  };
  map.set(id, u);
  writeThrough(u);
  return publicOf(u);
}

export async function updateUser(
  id: string,
  patch: { name?: string; password?: string; domains?: string[]; role?: Role },
): Promise<PublicUser> {
  const map = await getCache();
  if (isReserved(id)) throw err('User not found', 404);
  const u = map.get(id);
  if (!u) throw err('User not found', 404);
  if (patch.name !== undefined) u.name = patch.name.trim() || u.id;
  if (patch.password) u.password = await hashPassword(patch.password);
  if (patch.domains?.length) u.domains = patch.domains;
  if (patch.role) u.role = patch.role;
  u.updatedAt = Date.now();
  map.set(id, u);
  writeThrough(u);
  return publicOf(u);
}

export async function deleteUser(id: string): Promise<void> {
  const map = await getCache();
  if (isReserved(id) || !map.has(id)) return;
  const target = map.get(id)!;
  // Never remove the last enabled admin — that would lock the deployment out
  // (only the master recovery key could restore it). Demote/rotate first.
  if (target.role === 'admin') {
    const admins = visible(map).filter((u) => u.role === 'admin' && !u.disabled);
    if (admins.length <= 1) throw err('Cannot delete the last admin', 400);
  }
  map.delete(id);
  if (osHealthy) void osFetch(`/os-users/_doc/${id}?refresh=true`, { method: 'DELETE' });
}

/** Distinct domains across all users — drives domain pickers. */
export async function knownDomains(): Promise<string[]> {
  const map = await getCache();
  const set = new Set<string>();
  for (const u of visible(map)) for (const d of u.domains) set.add(d);
  return [...set].sort();
}

// ---- First-run bootstrap ----------------------------------------------------

/**
 * Forced first-login setup of the bootstrap admin. Creates the REAL admin
 * account (chosen username, real email, strong password — strength is enforced
 * by the caller), neutralises the default `admin/admin` credential immediately,
 * and returns a single-use email-verification token (raw, shown once). The
 * bootstrap tombstone is deleted when that token is verified.
 */
export async function setupAdmin(input: {
  bootstrapId: string;
  username: string;
  name?: string;
  email: string;
  passwordHashReady: string; // already a scrypt hash (caller hashed it)
}): Promise<{ user: PublicUser; verifyToken: string }> {
  const map = await getCache();
  const boot = map.get(input.bootstrapId);
  if (!boot || !boot.bootstrap) throw err('Setup is not available', 409);
  if (!boot.mustChangeCredentials) throw err('Setup already completed', 409);

  const newId = input.username.trim().toLowerCase();
  if (!newId) throw err('A username is required', 400);
  if (isReserved(newId)) throw err('That username is reserved', 400);
  const email = input.email.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err('Enter a valid email address', 400);
  if (emailTaken(map, email, input.bootstrapId)) throw err('That email is already in use', 409);
  // A different existing user already holds this id.
  if (newId !== input.bootstrapId && map.has(newId)) throw err('That username already exists', 409);

  // Move the bootstrap row to a disabled tombstone so `admin/admin` cannot log in
  // anymore (default credential neutralised the instant setup completes). It is
  // physically deleted on email verification.
  map.delete(input.bootstrapId);
  const tombstone: StoredUser = {
    ...boot,
    id: BOOTSTRAP_TOMBSTONE_ID,
    disabled: true,
    mustChangeCredentials: false,
    password: await hashPassword(`disabled-${Date.now()}-${Math.random()}`),
    updatedAt: Date.now(),
  };
  map.set(BOOTSTRAP_TOMBSTONE_ID, tombstone);
  writeThrough(tombstone);
  // Drop the old bootstrap doc from the mirror — but ONLY when the operator chose
  // a different username. If they kept `admin`, the new admin's PUT below targets
  // the SAME doc id, so a DELETE here would race and could wipe the real account.
  if (osHealthy && newId !== input.bootstrapId) {
    void osFetch(`/os-users/_doc/${input.bootstrapId}?refresh=true`, { method: 'DELETE' });
  }

  const real: StoredUser = {
    id: newId,
    name: input.name?.trim() || newId,
    password: input.passwordHashReady,
    domains: boot.domains,
    role: 'admin',
    email,
    emailVerified: false,
    mustChangeCredentials: false,
    onboarded: false,
    createdAt: Date.now(),
  };
  map.set(newId, real);
  writeThrough(real);

  // Mint a single-use, expiring verification token (store only its hash). Held
  // both in-memory (fast) and in durable meta (survives a restart / 2nd replica).
  const token = `${newId}.${sha256(`${newId}:${Date.now()}:${Math.random()}`)}`;
  const tokenHash = sha256(token);
  const expiresAt = Date.now() + VERIFY_TTL_MS;
  verifyTokens.set(tokenHash, { userId: newId, expiresAt });
  meta.pendingVerify = { tokenHash, userId: newId, expiresAt };
  persistMeta();

  return { user: publicOf(real), verifyToken: token };
}

/**
 * Consume an email-verification token: marks the account verified and deletes
 * the bootstrap tombstone. Single-use + expiring. Returns the verified user id.
 */
export async function verifyEmailToken(token: string): Promise<{ ok: boolean; userId?: string }> {
  const key = sha256(token);
  const map = await getCache();
  let entry = verifyTokens.get(key);
  if (entry) verifyTokens.delete(key); // single-use (in-memory)
  // Durable fallback so a restart between setup and the click still verifies.
  if (!entry && meta.pendingVerify?.tokenHash === key) {
    entry = { userId: meta.pendingVerify.userId, expiresAt: meta.pendingVerify.expiresAt };
  }
  if (!entry) return { ok: false };
  if (Date.now() > entry.expiresAt) return { ok: false };
  const u = map.get(entry.userId);
  if (!u) return { ok: false };
  u.emailVerified = true;
  u.updatedAt = Date.now();
  map.set(u.id, u);
  writeThrough(u);
  // Single-use: clear the durable pending-verify record.
  if (meta.pendingVerify?.tokenHash === key) {
    meta.pendingVerify = undefined;
    persistMeta();
  }
  // Auto-delete the neutralised bootstrap tombstone — default identity is gone.
  if (map.has(BOOTSTRAP_TOMBSTONE_ID)) {
    map.delete(BOOTSTRAP_TOMBSTONE_ID);
    if (osHealthy) void osFetch(`/os-users/_doc/${BOOTSTRAP_TOMBSTONE_ID}?refresh=true`, { method: 'DELETE' });
  }
  return { ok: true, userId: u.id };
}

export async function markOnboarded(id: string): Promise<void> {
  const map = await getCache();
  const u = map.get(id);
  if (!u) return;
  u.onboarded = true;
  u.updatedAt = Date.now();
  map.set(id, u);
  writeThrough(u);
}

// ---- Master-key recovery ----------------------------------------------------

/** Store ONLY the hash of a freshly generated master key. */
export async function setRecoveryKey(plaintextKey: string): Promise<void> {
  await getCache();
  meta.recoveryHash = await hashPassword(plaintextKey);
  persistMeta();
}

export async function recoveryConfigured(): Promise<boolean> {
  await getCache();
  return Boolean(meta.recoveryHash);
}

export async function verifyRecoveryKey(plaintextKey: string): Promise<boolean> {
  await getCache();
  if (!meta.recoveryHash) return false;
  return verifyPassword(plaintextKey, meta.recoveryHash);
}

/**
 * Reset a user's password using the master recovery key. The new password's
 * strength is enforced by the caller; here we only re-check the key and write
 * the new hash. Also clears `disabled`/`mustChangeCredentials` so a locked-out
 * admin regains access.
 */
export async function resetPasswordWithRecovery(
  username: string,
  plaintextKey: string,
  newPassword: string,
): Promise<PublicUser> {
  const map = await getCache();
  const ok = await verifyRecoveryKey(plaintextKey);
  if (!ok) throw err('Invalid recovery key', 401);
  const u = findByHandle(map, username);
  if (!u) throw err('No such account', 404);
  u.password = await hashPassword(newPassword);
  u.disabled = false;
  u.mustChangeCredentials = false;
  u.updatedAt = Date.now();
  map.set(u.id, u);
  writeThrough(u);
  return publicOf(u);
}
