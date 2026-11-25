/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import { revokeUserEverywhere } from '@core/kernel/user-revocation';
import {
  archiveUser,
  createUser,
  deleteUser,
  listUsers,
  restoreUser,
  updateUser,
  userDirectoryAuthoritative,
  userDirectoryIsOfflineSeed,
  type PublicUser,
} from '@tabs/admin/lib/users';
import type { Role } from '@core/kernel/session';
import { assessPasswordStrength, generateTempPassword } from '@core/kernel/password';
import { osMirror } from '@core/infra/os-mirror';

/**
 * Tenant-user adapter (Ory seam) for Platform Admin → Users & Access.
 *
 * Org-wide lifecycle: INVITE (via Ory's flow — the inviter never sees or sets a
 * password; we generate a server-side secret that is never returned),
 * DEACTIVATE, assign the tenant Admin role, and set INITIAL domain memberships.
 * In-domain day-to-day role changes stay in Governance (Builders) — not here.
 *
 * This wraps `lib/users.ts` (the Ory-replaceable directory) and adds an
 * activation/invite status tracked in-process, mirrored durably. Its compiled
 * output is fed to the policy compiler.
 *
 * ONE definition of an active account (`accountActive`): not `disabled` in the user directory AND
 * not "deactivated" here. A deactivation writes BOTH (the directory flag is what sign-in, the
 * session cookie and the headless doors read); a deactivation an older release recorded only here
 * is carried to the directory the first time this store loads. The store must be LOADED before
 * anything decides on it: a load that failed is not cached and is never read as "nobody is
 * deactivated" — the compile refuses instead (`TenantStatusUnavailableError`).
 */

type Status = 'active' | 'invited' | 'deactivated';
type TenantUsersState = { statusMap: Map<string, Status>; hydration: Promise<void> | null; loaded: boolean };
const TENANT_USERS_KEY = Symbol.for('soa.platform.tenantUsers');
function tenantUsersState(): TenantUsersState {
  const g = globalThis as unknown as Record<symbol, TenantUsersState | undefined>;
  if (!g[TENANT_USERS_KEY]) g[TENANT_USERS_KEY] = { statusMap: new Map(), hydration: null, loaded: false };
  return g[TENANT_USERS_KEY]!;
}

/** The durable status store could not be read — callers fail CLOSED (HTTP 503), never "all active". */
export class TenantStatusUnavailableError extends Error {
  status = 503;
  constructor() {
    super('Tenant status not loaded (the status store is unreachable) — refusing to decide who is active');
    this.name = 'TenantStatusUnavailableError';
  }
}

// ---------------------------------------------------- durable mirror (best-effort) --
const mirror = osMirror({
  index: 'os-tenant-user-status',
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        status: { type: 'keyword' },
      },
    },
  },
});

function writeThrough(userId: string, status: Status): void {
  mirror.writeThrough(userId, { id: userId, status });
}

/**
 * Load the status store from its durable mirror (once per process). A failed load is NOT cached —
 * the next call retries — and throws `TenantStatusUnavailableError`, except on a no-cluster dev
 * install whose user directory is itself the offline seed (there the in-memory map is all there is).
 */
export async function ensureHydrated(): Promise<void> {
  const s = tenantUsersState();
  if (s.loaded) return;
  if (!s.hydration) {
    s.hydration = hydrate().finally(() => {
      s.hydration = null;
    });
  }
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = tenantUsersState();
  const docs = await mirror.hydrate(2000);
  if (docs === null) {
    if (!(await userDirectoryAuthoritative()) && userDirectoryIsOfflineSeed()) return;
    throw new TenantStatusUnavailableError();
  }
  for (const doc of docs as { id?: string; status?: Status }[]) {
    if (doc && doc.id && doc.status && !s.statusMap.has(doc.id)) {
      s.statusMap.set(doc.id, doc.status);
    }
  }
  s.loaded = true;
  await carryDeactivationsToDirectory();
}

/**
 * A deactivation recorded here by an older release never set the directory's `disabled` flag, so
 * sign-in still let the user in. Set it now. Best-effort per user: a refusal (the last active
 * admin) is logged, and the compile still treats the user as inactive through `accountActive`.
 */
async function carryDeactivationsToDirectory(): Promise<void> {
  const s = tenantUsersState();
  const deactivated = [...s.statusMap.entries()].filter(([, st]) => st === 'deactivated').map(([id]) => id);
  if (deactivated.length === 0) return;
  for (const u of await listUsers()) {
    if (u.disabled || !deactivated.includes(u.id)) continue;
    try {
      await archiveUser(u.id);
    } catch (e) {
      console.error(`[tenant-users] ${u.id} is deactivated but could not be disabled in the directory: ${(e as Error).message}`);
    }
  }
}

/** True only when the status store is loaded from its durable mirror (the OPA sources refuse otherwise). */
export async function tenantStatusAuthoritative(): Promise<boolean> {
  try {
    await ensureHydrated();
  } catch {
    return false;
  }
  return tenantUsersState().loaded;
}

export function _resetTenantUsers(): void {
  const s = tenantUsersState();
  s.statusMap.clear();
  s.hydration = null;
  s.loaded = false;
  mirror.__reset();
}

export type AccessUser = PublicUser & { status: Status; active: boolean };

function statusOf(id: string): Status {
  return tenantUsersState().statusMap.get(id) ?? 'active';
}

/**
 * THE definition of an active account — the one every compile from the directory uses. Call only
 * after `ensureHydrated()` (or `tenantStatusAuthoritative()`) has resolved.
 */
export function accountActive(u: { id: string; disabled?: boolean }): boolean {
  return !u.disabled && statusOf(u.id) !== 'deactivated';
}

/** Validate a candidate password server-side (empty/weak → 400). Shared by
 *  invite + reset so the API can never store an unvalidated credential. */
function requireStrong(password: string, username: string): void {
  const strength = assessPasswordStrength(password, username);
  if (!strength.ok) {
    const e = new Error(strength.reasons[0] ?? 'Password is too weak');
    (e as Error & { status?: number }).status = 400;
    throw e;
  }
}

export async function listAccess(): Promise<AccessUser[]> {
  await ensureHydrated();
  const users = await listUsers();
  return users.map((u) => {
    const active = accountActive(u);
    return { ...u, status: active ? statusOf(u.id) : 'deactivated', active };
  });
}

/**
 * Invite a user with a REAL, hashed password so the created account can
 * `authenticate()` and sign in immediately (this deployment uses OS-native
 * password auth, not a live Ory credential delivery).
 *
 * The admin may SUPPLY a password (validated server-side for strength; empty/weak
 * → 400) — otherwise the server generates a strong one. Either way only the scrypt
 * hash is stored; the plaintext is returned ONCE (`tempPassword`) so the admin can
 * relay it, and the account is flagged `mustChangeCredentials` so the invitee sets
 * their own on first login. `generated` tells the caller whether it must surface
 * the password (i.e. the admin left it blank).
 */
export async function inviteUser(input: {
  id: string;
  name?: string;
  email?: string;
  domains: string[];
  role: Role;
  password?: string;
}): Promise<{ user: PublicUser; tempPassword: string; generated: boolean }> {
  const supplied = input.password?.trim() ?? '';
  const generated = !supplied;
  const password = supplied || generateTempPassword();
  if (supplied) requireStrong(supplied, input.id);
  const user = await createUser({
    id: input.id,
    name: input.name,
    email: input.email,
    password,
    domains: input.domains,
    role: input.role,
    mustChangeCredentials: true,
  });
  tenantUsersState().statusMap.set(user.id, 'invited');
  writeThrough(user.id, 'invited');
  return { user, tempPassword: password, generated };
}

/**
 * Admin-set password reset for an existing user. Validates strength server-side,
 * hashes + stores it (never plaintext), and returns the new password ONCE so the
 * admin can relay it. If `password` is omitted a strong one is generated.
 */
export async function resetPassword(id: string, password?: string): Promise<{ user: PublicUser; tempPassword: string }> {
  const supplied = password?.trim() ?? '';
  const next = supplied || generateTempPassword();
  requireStrong(next, id);
  const user = await updateUser(id, { password: next });
  return { user, tempPassword: next };
}

/**
 * WP-15: a deactivated or removed owner's Dagster run grants end now (and an open activation
 * window with them). Only when run grants are on. A failure is raised: a deactivation that left the
 * owner's grants alive must not look like a success.
 */
let endRunGrants: ((id: string) => Promise<unknown>) | null = null;
export function __setRunGrantEnderForTests(fn: ((id: string) => Promise<unknown>) | null): void {
  endRunGrants = fn;
}
async function endOwnerRunGrants(id: string): Promise<void> {
  if (endRunGrants) {
    await endRunGrants(id);
    return;
  }
  const { config } = await import('@core/kernel/config');
  if (!config.dagsterRunGrants) return;
  const [{ endRunGrantsOf }, { governanceRuntimePool }] = await Promise.all([
    import('@core/policy/run-grants'),
    import('@core/adapters/postgres/pool'),
  ]);
  await endRunGrantsOf(governanceRuntimePool(), id);
}

export async function deactivateUser(id: string): Promise<AccessUser> {
  const users = await listUsers();
  const u = users.find((x) => x.id === id);
  if (!u) {
    const e = new Error('User not found');
    (e as Error & { status?: number }).status = 404;
    throw e;
  }
  await endOwnerRunGrants(id);
  // The directory flag first: it is what sign-in, the session cookie and the headless doors read.
  // A refusal there (the last active admin) leaves nothing half-done.
  if (!u.disabled) await archiveUser(id);
  tenantUsersState().statusMap.set(id, 'deactivated');
  writeThrough(id, 'deactivated');
  // Every path that deactivates (Access page, offboarding, domain delete) revokes the user's
  // connected-account sign-ins here; a failed revoke is raised to the caller — and says plainly that
  // the deactivation itself stands (the user can no longer sign in).
  try {
    await revokeUserEverywhere(id);
  } catch (e) {
    const err = new Error(`${id} is deactivated (they can no longer sign in), but revoking their connected accounts failed — retry the deactivation to revoke them: ${(e as Error).message}`);
    (err as Error & { status?: number; deactivationStands?: boolean }).status = 502;
    // The status write above already happened: callers must still audit and recompile.
    (err as Error & { deactivationStands?: boolean }).deactivationStands = true;
    throw err;
  }
  return { ...u, status: 'deactivated', active: false };
}

export async function reactivateUser(id: string): Promise<AccessUser> {
  const users = await listUsers();
  const u = users.find((x) => x.id === id);
  if (!u) {
    const e = new Error('User not found');
    (e as Error & { status?: number }).status = 404;
    throw e;
  }
  if (u.domains.length === 0) {
    // A domain delete left them without any domain: an active account must belong somewhere.
    const e = new Error(`${id} has no domain — give them a domain before reactivating`);
    (e as Error & { status?: number }).status = 409;
    throw e;
  }
  if (u.disabled) await restoreUser(id);
  tenantUsersState().statusMap.set(id, 'active');
  writeThrough(id, 'active');
  return { ...u, disabled: false, status: 'active', active: true };
}

/** Assign / revoke the tenant Admin role (org-wide). */
export async function setTenantAdmin(id: string, isAdmin: boolean): Promise<PublicUser> {
  return updateUser(id, { role: isAdmin ? 'admin' : 'creator' });
}

/**
 * Edit a user's profile fields (name, email) and/or role + domain memberships.
 * Platform-Admin surface (tenant-wide, Admin only). Validates domains non-empty
 * and delegates to the user directory's updateUser which handles email dedup and
 * hash-write-through. Omitted fields are passed as undefined so updateUser leaves
 * them untouched.
 */
export async function editUser(
  id: string,
  patch: { name?: string; email?: string; role?: Role; domains?: string[] },
): Promise<PublicUser> {
  if (patch.domains !== undefined) {
    const clean = [...new Set((patch.domains).map((d) => d.trim()).filter(Boolean))];
    if (clean.length === 0) {
      const e = new Error('At least one domain membership is required');
      (e as Error & { status?: number }).status = 400;
      throw e;
    }
    patch = { ...patch, domains: clean };
  }
  return updateUser(id, patch);
}

/** Set a user's INITIAL domain memberships (org-wide). In-domain role changes
 * stay in Governance. */
export async function setMemberships(id: string, domains: string[]): Promise<PublicUser> {
  const clean = [...new Set(domains.map((d) => d.trim()).filter(Boolean))];
  if (clean.length === 0) {
    const e = new Error('At least one domain membership is required');
    (e as Error & { status?: number }).status = 400;
    throw e;
  }
  return updateUser(id, { domains: clean });
}

/**
 * Permanently offboard a user. When `reassignTo` is given, the user's PERSONAL-
 * lane "My artifacts" are transferred to that owner FIRST (governed, via
 * offboard.reassignOwner) so nothing is orphaned; otherwise those artifacts are
 * deleted with the account. The deletion itself is guarded by the user directory
 * (never the last active admin). Returns the reassignment report (empty when no
 * reassignment was requested) so the caller can surface what moved / what failed.
 */
export async function offboardUser(
  id: string,
  reassignTo?: string,
): Promise<import('./offboard').ReassignReport | null> {
  let report: import('./offboard').ReassignReport | null = null;
  if (reassignTo && reassignTo !== id) {
    const { reassignOwner } = await import('./offboard');
    report = await reassignOwner(id, reassignTo);
  }
  await endOwnerRunGrants(id);
  await revokeUserEverywhere(id); // connected-account sign-ins go with the account
  await deleteUser(id);
  tenantUsersState().statusMap.delete(id);
  mirror.deleteThrough(id);
  return report;
}

/**
 * Compiler input: only ACTIVE users grant rights. Loads the status store first (a boot compile runs
 * before anything else has) and REFUSES — throws `TenantStatusUnavailableError` — when it cannot be
 * read, so a restart during a mirror outage never re-grants a deactivated user.
 */
export async function compileUsers(): Promise<{ id: string; role: Role; domains: string[]; active: boolean }[]> {
  const access = await listAccess();
  return access.map((u) => ({ id: u.id, role: u.role, domains: u.domains, active: u.active }));
}
