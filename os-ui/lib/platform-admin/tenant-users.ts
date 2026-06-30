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
} from '@/lib/users';
import type { Role } from '@/lib/session';

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
const statusMap = new Map<string, Status>();

export type AccessUser = PublicUser & { status: Status; active: boolean };

function statusOf(id: string): Status {
  return statusMap.get(id) ?? 'active';
}

function randomSecret(): string {
  // Server-side only; never returned to a caller. Ory owns the real credential.
  return `ory-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export async function listAccess(): Promise<AccessUser[]> {
  const users = await listUsers();
  return users.map((u) => {
    const status = statusOf(u.id);
    return { ...u, status, active: status !== 'deactivated' };
  });
}

/** Invite a user via the Ory flow. The password is generated + retained by the
 * directory; it is NEVER returned, logged, or shown — only a PublicUser is. */
export async function inviteUser(input: {
  id: string;
  name?: string;
  domains: string[];
  role: Role;
}): Promise<PublicUser> {
  const user = await createUser({
    id: input.id,
    name: input.name,
    password: randomSecret(),
    domains: input.domains,
    role: input.role,
  });
  statusMap.set(user.id, 'invited');
  return user; // PublicUser — password is omitted by the directory
}

export async function deactivateUser(id: string): Promise<AccessUser> {
  const users = await listUsers();
  const u = users.find((x) => x.id === id);
  if (!u) {
    const e = new Error('User not found');
    (e as Error & { status?: number }).status = 404;
    throw e;
  }
  statusMap.set(id, 'deactivated');
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
  statusMap.set(id, 'active');
  return { ...u, status: 'active', active: true };
}

/** Assign / revoke the tenant Admin role (org-wide). */
export async function setTenantAdmin(id: string, isAdmin: boolean): Promise<PublicUser> {
  return updateUser(id, { role: isAdmin ? 'admin' : 'participant' });
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

export async function offboardUser(id: string): Promise<void> {
  await deleteUser(id);
  statusMap.delete(id);
}

/** Compiler input: only ACTIVE users grant rights. */
export async function compileUsers(): Promise<{ id: string; role: Role; domains: string[]; active: boolean }[]> {
  const access = await listAccess();
  return access.map((u) => ({ id: u.id, role: u.role, domains: u.domains, active: u.active }));
}
