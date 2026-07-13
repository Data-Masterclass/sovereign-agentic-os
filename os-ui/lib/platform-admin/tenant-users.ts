/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import {
  createUser,
  deleteUser,
  listUsers,
  updateUser,
  type PublicUser,
} from '@/lib/platform-admin/users';
import type { Role } from '@/lib/core/session';
import { assessPasswordStrength, generateTempPassword } from '@/lib/core/password';
import { osMirror } from '../infra/os-mirror.ts';

/**
 * Tenant-user adapter (Ory seam) for Platform Admin → Users & Access.
 *
 * Org-wide lifecycle: INVITE (via Ory's flow — the inviter never sees or sets a
 * password; we generate a server-side secret that is never returned),
 * DEACTIVATE, assign the tenant Admin role, and set INITIAL domain memberships.
 * In-domain day-to-day role changes stay in Governance (Builders) — not here.
 *
 * This wraps `lib/users.ts` (the Ory-replaceable directory) and adds an
 * activation/invite status tracked in-process. Server-only (it touches the
 * credential store), so it is NOT in the unit-test path; its compiled output is
 * fed to the (tested) policy compiler.
 */

type Status = 'active' | 'invited' | 'deactivated';
type TenantUsersState = { statusMap: Map<string, Status>; hydration: Promise<void> | null };
const TENANT_USERS_KEY = Symbol.for('soa.platform.tenantUsers');
function tenantUsersState(): TenantUsersState {
  const g = globalThis as unknown as Record<symbol, TenantUsersState | undefined>;
  if (!g[TENANT_USERS_KEY]) g[TENANT_USERS_KEY] = { statusMap: new Map(), hydration: null };
  return g[TENANT_USERS_KEY]!;
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

export async function ensureHydrated(): Promise<void> {
  const s = tenantUsersState();
  if (!s.hydration) s.hydration = hydrate();
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = tenantUsersState();
  const docs = (await mirror.hydrate(2000)) ?? [];
  for (const doc of docs as { id?: string; status?: Status }[]) {
    if (doc && doc.id && doc.status && !s.statusMap.has(doc.id)) {
      s.statusMap.set(doc.id, doc.status);
    }
  }
}

export function _resetTenantUsers(): void {
  const s = tenantUsersState();
  s.statusMap.clear();
  s.hydration = null;
  mirror.__reset();
}

export type AccessUser = PublicUser & { status: Status; active: boolean };

function statusOf(id: string): Status {
  return tenantUsersState().statusMap.get(id) ?? 'active';
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
  const users = await listUsers();
  return users.map((u) => {
    const status = statusOf(u.id);
    return { ...u, status, active: status !== 'deactivated' };
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

export async function deactivateUser(id: string): Promise<AccessUser> {
  const users = await listUsers();
  const u = users.find((x) => x.id === id);
  if (!u) {
    const e = new Error('User not found');
    (e as Error & { status?: number }).status = 404;
    throw e;
  }
  tenantUsersState().statusMap.set(id, 'deactivated');
  writeThrough(id, 'deactivated');
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
  tenantUsersState().statusMap.set(id, 'active');
  writeThrough(id, 'active');
  return { ...u, status: 'active', active: true };
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
  await deleteUser(id);
  tenantUsersState().statusMap.delete(id);
  mirror.deleteThrough(id);
  return report;
}

/** Compiler input: only ACTIVE users grant rights. */
export async function compileUsers(): Promise<{ id: string; role: Role; domains: string[]; active: boolean }[]> {
  const access = await listAccess();
  return access.map((u) => ({ id: u.id, role: u.role, domains: u.domains, active: u.active }));
}
