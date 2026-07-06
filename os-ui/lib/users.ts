/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import { config } from '@/lib/config';
import { osMirror } from '@/lib/os-mirror';
import { ROLES, type Role } from '@/lib/session';
import { createHash, timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword, isHashed } from '@/lib/password';
import { emailVerificationEnabled, sendVerificationEmail } from '@/lib/mailer';

/**
 * User directory — a pragmatic, self-hosted identity store (the seam Ory would
 * replace later). It is SECURE BY DEFAULT:
 *
 *  - Passwords are stored ONLY as scrypt hashes (lib/password.ts) — never
 *    plaintext, never logged, never returned to a client.
 *  - The shipped build seeds NO real/fake users. On an empty store a single
 *    first-run bootstrap admin (`admin`/`admin`) is created, flagged
 *    `mustChangeCredentials` + `bootstrap`. The forced setup (setupAdmin) gives
 *    it a real email + strong password, auto-verifies it (the operator who holds
 *    the bootstrap credential is trusted — NO email round-trip is required) and
 *    deletes the default `admin/admin` identity RIGHT THEN. So `admin/admin` is
 *    never usable past first-run, with no reliance on a mailer.
 *  - A single high-entropy master recovery key (hash only, server-side) can reset
 *    a locked-out account.
 *
 * Email verification is OPTIONAL and gated on a configured mailer (lib/mailer.ts):
 *  - No SMTP configured (the default) → accounts are active immediately; the flow
 *    NEVER dead-ends on a "check your email" that can never arrive.
 *  - SMTP configured (operator opt-in) → later/invited accounts get a real
 *    verification email; the single-use token's hash is stored on the user row so
 *    verification survives a restart / a second replica. Verification is
 *    non-blocking either way: an unverified account can still sign in — verifying
 *    only confirms the address.
 *
 * Persistence mirrors the artifact store: an authoritative in-process cache (so
 * it works with no cluster) plus a best-effort OpenSearch mirror ("os-users")
 * for durability in a real deploy. Only hashes ever reach the mirror, and every
 * runtime mutation (setup, create, verify, recovery) write-throughs, so
 * runtime-created accounts survive a pod restart when OpenSearch is reachable.
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
  /** SHA-256 of the pending single-use email-verification token (never the raw). */
  pendingVerifyHash?: string;
  /** Expiry (epoch ms) of the pending verification token. */
  pendingVerifyExpires?: number;
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
  /** Soft-deleted: account exists but cannot sign in. Restorable. */
  disabled?: boolean;
};

const META_ID = '__meta__';
const BOOTSTRAP_ID = 'admin';
const BOOTSTRAP_TOMBSTONE_ID = '__bootstrap_tombstone__';
const RESERVED_IDS = new Set([META_ID, BOOTSTRAP_TOMBSTONE_ID]);
const VERIFY_TTL_MS = 1000 * 60 * 60 * 24; // 24h single-use verification window

type Meta = { recoveryHash?: string; initialized?: boolean };

type UsersCacheState = { cache: Map<string, StoredUser> | null; meta: Meta; dummyHash: string | null };
const USERS_STATE_KEY = Symbol.for('soa.users.cache');
function usersState(): UsersCacheState {
  const g = globalThis as unknown as Record<symbol, UsersCacheState | undefined>;
  if (!g[USERS_STATE_KEY]) g[USERS_STATE_KEY] = { cache: null, meta: {}, dummyHash: null };
  return g[USERS_STATE_KEY]!;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Shared email-shape check (the sign-in label must be a real address). */
function isValidEmail(s: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim());
}

function isReserved(id: string): boolean {
  return RESERVED_IDS.has(id) || id.startsWith('__');
}

/**
 * Mint a single-use, expiring verification token and stamp its HASH onto the
 * user row (durable via the OpenSearch mirror → survives a restart / 2nd
 * replica). The raw token is returned ONCE for the caller to email; it is never
 * stored. Format `<id>.<hex>` so verification can locate the row by prefix and
 * then constant-time-compare the hash.
 */
function mintVerifyToken(u: StoredUser): string {
  const token = `${u.id}.${sha256(`${u.id}:${Date.now()}:${Math.random()}`)}`;
  u.pendingVerifyHash = sha256(token);
  u.pendingVerifyExpires = Date.now() + VERIFY_TTL_MS;
  return token;
}

/** Absolute verify URL when OS_PUBLIC_URL is set (needed for emailed links);
 * otherwise a same-origin relative path (fine for in-app surfacing). */
function verifyLink(token: string): string {
  const base = (process.env.OS_PUBLIC_URL ?? '').replace(/\/+$/, '');
  const path = `/api/auth/verify?token=${encodeURIComponent(token)}`;
  return base ? `${base}${path}` : path;
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
        // Every seed user carries a valid email — its human sign-in label
        // (login-by-email). Where the entry only gives an email-shaped id, that
        // doubles as the email. An entry with no usable email is skipped rather
        // than seeded loginless.
        const email = (String(u.email ?? '').trim() || (isValidEmail(id) ? id : '')).toLowerCase();
        if (!isValidEmail(email)) continue;
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
          // Migrate legacy roles on read: participant (and any unknown) → the base
          // role `creator`; builder/domain_admin/admin pass through unchanged.
          // domain_admin here is an operator's EXPLICIT seed — never inferred.
          role: (['builder', 'domain_admin', 'admin'].includes(String(u.role)) ? u.role : 'creator') as Role,
          email,
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

// Shared durable-mirror core (probe → bootstrap-on-404 → hydrate/write-through):
// lib/os-mirror.ts. A missing index is CREATED, never mistaken for a dead mirror.
const mirror = osMirror({ index: 'os-users' });

function writeThrough(u: StoredUser): void {
  mirror.writeThrough(u.id, u);
}

function persistMeta(): void {
  const s = usersState();
  mirror.writeThrough(META_ID, { id: META_ID, ...s.meta });
}

async function getCache(): Promise<Map<string, StoredUser>> {
  const s = usersState();
  if (s.cache) return s.cache;
  const map = new Map<string, StoredUser>();
  const docs = await mirror.hydrate(1000);
  if (docs !== null) {
    for (const src of docs as (StoredUser & Meta)[]) {
      if (src.id === META_ID) {
        s.meta = { recoveryHash: src.recoveryHash, initialized: src.initialized };
        continue;
      }
      // Migrate legacy roles on read: anything outside the 4 canonical roles
      // (agentic-leader, participant, …) → creator. Nobody is ever auto-promoted
      // — domain_admin is only ever assigned explicitly by a platform admin.
      if (!ROLES.includes(src.role as Role)) {
        src.role = 'creator';
      }
      map.set(src.id, src);
    }
    // Seed the first-run bootstrap admin ONLY on a never-initialised store. Once
    // a deployment has been set up (s.meta.initialized), an empty user map means
    // every account was removed — we must NOT silently resurrect admin/admin;
    // recovery is via the master key. This closes the default-credential
    // resurrection path.
    if (map.size === 0 && !s.meta.initialized) {
      for (const u of await loadSeed()) { map.set(u.id, u); writeThrough(u); }
      s.meta.initialized = true;
      persistMeta();
    }
  } else {
    // Mirror unreachable → offline/in-memory mode (no durability): seed only
    // when nothing is loaded.
    if (map.size === 0 && !s.meta.initialized) {
      for (const u of await loadSeed()) map.set(u.id, u);
      s.meta.initialized = true;
    }
  }
  s.cache = map;
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
    disabled: u.disabled,
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
    const s = usersState();
    if (!s.dummyHash) s.dummyHash = await hashPassword('timing-equaliser');
    await verifyPassword(password, s.dummyHash!);
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
  /** Force the first-login email+password setup (admin-issued invite). */
  mustChangeCredentials?: boolean;
}): Promise<PublicUser> {
  const map = await getCache();
  const id = input.id.trim().toLowerCase();
  if (!id) throw err('A username is required', 400);
  if (isReserved(id)) throw err('That username is reserved', 400);
  if (map.has(id)) throw err('That username already exists', 409);
  if (!input.password) throw err('A password is required', 400);
  if (!input.domains?.length) throw err('At least one domain is required', 400);
  // Email is REQUIRED and validated — it is the human-facing sign-in label
  // (login-by-email). `id` stays the internal principal/owner/DLS key. Where a
  // caller only carries one handle (the invite UIs whose field is labelled
  // "email / login"), an email-shaped id doubles as the email so those flows keep
  // working without a second field.
  const email = (input.email?.trim() || (isValidEmail(id) ? id : '')).toLowerCase();
  if (!email) throw err('A valid email is required', 400);
  if (!isValidEmail(email)) throw err('Enter a valid email address', 400);
  if (emailTaken(map, email)) throw err('That email is already in use', 409);
  // Email verification is OPTIONAL and gated on a configured mailer. With no
  // mailer (the default) a new account is ACTIVE immediately (emailVerified=true)
  // so the flow never dead-ends. With a mailer the account starts unverified and
  // we send a real verification email — but it can still sign in meanwhile, so
  // verification is confirmation, not a gate.
  const verify = emailVerificationEnabled();
  const u: StoredUser = {
    id,
    name: input.name?.trim() || id,
    password: await hashPassword(input.password),
    domains: input.domains,
    role: input.role,
    email,
    emailVerified: !verify,
    // An invited account carries a one-time temp password (hash only) and is
    // forced through the first-login setup to replace it with its own.
    mustChangeCredentials: input.mustChangeCredentials ? true : undefined,
    onboarded: false,
    createdAt: Date.now(),
  };
  let token: string | null = null;
  if (verify) token = mintVerifyToken(u);
  map.set(id, u);
  writeThrough(u);
  // Fire-and-forget: a delivery failure must not fail account creation (the
  // account is usable regardless). No secret is ever logged by the mailer.
  if (verify && token && email) void sendVerificationEmail(email, verifyLink(token));
  return publicOf(u);
}

export async function updateUser(
  id: string,
  patch: { name?: string; email?: string; password?: string; domains?: string[]; role?: Role },
): Promise<PublicUser> {
  const map = await getCache();
  if (isReserved(id)) throw err('User not found', 404);
  const u = map.get(id);
  if (!u) throw err('User not found', 404);
  if (patch.name !== undefined) u.name = patch.name.trim() || u.id;
  if (patch.email !== undefined) {
    const e = patch.email.trim().toLowerCase();
    if (e && !isValidEmail(e)) throw err('Enter a valid email address', 400);
    if (e && emailTaken(map, e, id)) throw err('That email is already in use', 409);
    u.email = e || undefined;
    // If the email changed, clear the verified flag so it can be re-verified.
    if (u.email && u.email !== e) u.emailVerified = false;
  }
  if (patch.password) u.password = await hashPassword(patch.password);
  if (patch.domains?.length) u.domains = patch.domains;
  if (patch.role) u.role = patch.role;
  u.updatedAt = Date.now();
  map.set(id, u);
  writeThrough(u);
  return publicOf(u);
}

/** Soft-delete: mark disabled so the account cannot sign in. Restorable. */
export async function archiveUser(id: string): Promise<PublicUser> {
  const map = await getCache();
  if (isReserved(id)) throw err('User not found', 404);
  const u = map.get(id);
  if (!u) throw err('User not found', 404);
  if (u.role === 'admin') {
    const activeAdmins = visible(map).filter((x) => x.role === 'admin' && !x.disabled);
    if (activeAdmins.length <= 1) throw err('Cannot archive the last active admin', 400);
  }
  u.disabled = true;
  u.updatedAt = Date.now();
  map.set(id, u);
  writeThrough(u);
  return publicOf(u);
}

/** Restore a previously archived user — clears the disabled flag. */
export async function restoreUser(id: string): Promise<PublicUser> {
  const map = await getCache();
  if (isReserved(id)) throw err('User not found', 404);
  const u = map.get(id);
  if (!u) throw err('User not found', 404);
  u.disabled = false;
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
  mirror.deleteThrough(id);
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
 * by the caller) and AUTO-VERIFIES it: the operator who holds the bootstrap
 * credential is trusted, so no email round-trip is required and the account is
 * active immediately. The default `admin/admin` identity is DELETED right then —
 * with no reliance on a mailer, this is what makes clone-and-run work offline.
 *
 * (When a mailer is configured the new admin is still auto-verified — bootstrap
 * is the one path we never gate on email; per-user invite verification is the
 * SMTP-on path, handled in createUser.)
 */
export async function setupAdmin(input: {
  bootstrapId: string;
  username: string;
  name?: string;
  email: string;
  passwordHashReady: string; // already a scrypt hash (caller hashed it)
}): Promise<{ user: PublicUser }> {
  const map = await getCache();
  const boot = map.get(input.bootstrapId);
  if (!boot || !boot.bootstrap) throw err('Setup is not available', 409);
  if (!boot.mustChangeCredentials) throw err('Setup already completed', 409);

  const newId = input.username.trim().toLowerCase();
  if (!newId) throw err('A username is required', 400);
  if (isReserved(newId)) throw err('That username is reserved', 400);
  const email = input.email.trim();
  if (!isValidEmail(email)) throw err('Enter a valid email address', 400);
  if (emailTaken(map, email, input.bootstrapId)) throw err('That email is already in use', 409);
  // A different existing user already holds this id.
  if (newId !== input.bootstrapId && map.has(newId)) throw err('That username already exists', 409);

  // Delete the default `admin/admin` identity immediately — it is gone the
  // instant setup completes (no disabled tombstone left lingering, no mailer
  // dependency). The re-seed guard is `meta.initialized` (already true), so this
  // can never silently resurrect. Any stale tombstone from an older build is
  // swept too.
  map.delete(input.bootstrapId);
  if (map.has(BOOTSTRAP_TOMBSTONE_ID)) {
    map.delete(BOOTSTRAP_TOMBSTONE_ID);
    mirror.deleteThrough(BOOTSTRAP_TOMBSTONE_ID);
  }
  // Drop the old bootstrap doc from the mirror — but ONLY when the operator chose
  // a different username. If they kept `admin`, the new admin's PUT below targets
  // the SAME doc id, so a DELETE here would race and could wipe the real account.
  if (newId !== input.bootstrapId) {
    mirror.deleteThrough(input.bootstrapId);
  }

  const real: StoredUser = {
    id: newId,
    name: input.name?.trim() || newId,
    password: input.passwordHashReady,
    domains: boot.domains,
    role: 'admin',
    email,
    emailVerified: true, // trusted bootstrap operator → active immediately
    mustChangeCredentials: false,
    onboarded: false,
    createdAt: Date.now(),
  };
  map.set(newId, real);
  writeThrough(real);

  return { user: publicOf(real) };
}

/**
 * Complete the forced first-login setup for an INVITED (non-bootstrap) user.
 * The invitee signed in with the admin-issued one-time temp password; here they
 * replace it with their own strong password (strength enforced by the caller —
 * we only take the ready scrypt hash) which CLEARS `mustChangeCredentials`, so
 * the temp credential is now dead. The bootstrap admin uses `setupAdmin`
 * instead; this path never touches username/email/role/domains.
 */
export async function completeFirstLogin(
  id: string,
  passwordHashReady: string,
  opts?: { name?: string },
): Promise<PublicUser> {
  const map = await getCache();
  const u = map.get(id);
  if (!u || isReserved(u.id) || u.disabled) throw err('Account not found', 404);
  if (u.bootstrap) throw err('Use the bootstrap setup for this account', 409);
  if (!u.mustChangeCredentials) throw err('First-login setup already completed', 409);
  u.password = passwordHashReady;
  u.mustChangeCredentials = false;
  if (opts?.name?.trim()) u.name = opts.name.trim();
  u.updatedAt = Date.now();
  map.set(u.id, u);
  writeThrough(u);
  return publicOf(u);
}

/**
 * Consume a single-use, expiring email-verification token (the SMTP-on invite
 * path). Locates the row by the token's `<id>.` prefix, constant-time-compares
 * the stored hash, marks the account verified and clears the pending fields
 * (single-use). Durable: the hash lives on the user row, so a restart between
 * issue and click still verifies. Returns the verified user id.
 */
export async function verifyEmailToken(token: string): Promise<{ ok: boolean; userId?: string }> {
  const map = await getCache();
  const id = token.split('.')[0]?.trim().toLowerCase();
  if (!id) return { ok: false };
  const u = map.get(id);
  if (!u || isReserved(u.id) || !u.pendingVerifyHash || !u.pendingVerifyExpires) return { ok: false };
  if (Date.now() > u.pendingVerifyExpires) return { ok: false };
  // Constant-time compare (both are fixed-length sha256 hex).
  const a = Buffer.from(sha256(token));
  const b = Buffer.from(u.pendingVerifyHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
  u.emailVerified = true;
  u.pendingVerifyHash = undefined; // single-use
  u.pendingVerifyExpires = undefined;
  u.updatedAt = Date.now();
  map.set(u.id, u);
  writeThrough(u);
  // Defensive: sweep any stale bootstrap tombstone from an older build.
  if (map.has(BOOTSTRAP_TOMBSTONE_ID)) {
    map.delete(BOOTSTRAP_TOMBSTONE_ID);
    mirror.deleteThrough(BOOTSTRAP_TOMBSTONE_ID);
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
  usersState().meta.recoveryHash = await hashPassword(plaintextKey);
  persistMeta();
}

export async function recoveryConfigured(): Promise<boolean> {
  await getCache();
  return Boolean(usersState().meta.recoveryHash);
}

export async function verifyRecoveryKey(plaintextKey: string): Promise<boolean> {
  await getCache();
  const { recoveryHash } = usersState().meta;
  if (!recoveryHash) return false;
  return verifyPassword(plaintextKey, recoveryHash);
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

export function __resetUsers(): void {
  const s = usersState();
  s.cache = null;
  s.meta = {};
  s.dummyHash = null;
  mirror.__reset();
}
