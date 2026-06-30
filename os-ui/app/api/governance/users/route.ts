/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { createUser, deleteUser, knownDomains, listUsers, updateUser } from '@/lib/users';
import { ROLES, type Role } from '@/lib/session';
import { canManageRole, compileRoleToGrants, roleLabel } from '@/lib/governance/roles';
import { record as audit } from '@/lib/governance/audit';

export const dynamic = 'force-dynamic';

/**
 * Users & access (§5). Manage WHO is on the platform and WHAT they may do:
 * invite/deactivate, assign a role-per-domain, manage memberships. Roles compile
 * (via roles.ts) into the OPA rights every tab enforces, so changing a role here
 * changes what that person can do everywhere. Admins act tenant-wide; Builders
 * within their OWN domain, UP TO Builder (never minting an Admin).
 *
 * NEVER handle raw credentials: account creation / passwords / SSO use Ory's
 * secure flow. The invite below assigns role + membership and hands the
 * credential to Ory (here a server-side placeholder seam) — the tab never sees,
 * accepts, or returns a password.
 */
function asActor(u: { id: string; domains: string[]; role: Role }) {
  return { id: u.id, domains: u.domains, role: u.role };
}

function inActorScope(actor: { role: Role; domains: string[] }, targetDomains: string[]): boolean {
  if (actor.role === 'admin') return true;
  return targetDomains.every((d) => actor.domains.includes(d));
}

export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'admin' && user.role !== 'builder') {
    return NextResponse.json({ error: 'Managing users needs a Builder or Admin' }, { status: 403 });
  }
  const all = await listUsers();
  const scoped = user.role === 'admin' ? all : all.filter((u) => u.domains.some((d) => user.domains.includes(d)));
  const domains = user.role === 'admin' ? await knownDomains() : user.domains;
  return NextResponse.json({
    users: scoped.map((u) => ({ ...u, roleLabel: roleLabel(u.role) })),
    domains,
    roles: ROLES.map((r) => ({ value: r, label: roleLabel(r) })),
    assignableRoles: ROLES.filter((r) => canManageRole(asActor(user), r, user.domains[0] ?? '')).map((r) => ({ value: r, label: roleLabel(r) })),
  });
}

/** Invite a user (Ory owns the credential) + assign role-per-domain. */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'admin' && user.role !== 'builder') {
    return NextResponse.json({ error: 'Inviting users needs a Builder or Admin' }, { status: 403 });
  }
  let body: { id?: string; name?: string; domains?: unknown; role?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const id = String(body?.id ?? '').trim().toLowerCase();
  const role = (ROLES.includes(body?.role as Role) ? body!.role : 'participant') as Role;
  const domains = Array.isArray(body?.domains) ? body!.domains.map(String).filter(Boolean) : [];
  if (!id) return NextResponse.json({ error: 'A username is required' }, { status: 400 });
  if (domains.length === 0) return NextResponse.json({ error: 'At least one domain is required' }, { status: 400 });
  if ('password' in (body as object)) {
    return NextResponse.json({ error: 'This tab never handles passwords — Ory owns credentials' }, { status: 400 });
  }
  if (!inActorScope(user, domains) || domains.some((d) => !canManageRole(asActor(user), role, d))) {
    return NextResponse.json({ error: `You may not assign ${roleLabel(role)} in those domains` }, { status: 403 });
  }

  try {
    // Ory seam: the credential is created in Ory's secure flow; locally we mint a
    // server-only placeholder the tab never sees. Swap createUser for the Ory
    // identity API later; role + memberships (below) stay in the app tier.
    const oryPlaceholder = `ory:${crypto.randomUUID()}`;
    const created = await createUser({ id, name: body?.name ? String(body.name) : undefined, password: oryPlaceholder, domains, role });
    const grant = await compileRoleToGrants({ id: created.id, role: created.role });
    audit({
      actor: user.id,
      action: 'role.change',
      subject: created.id,
      domain: domains[0],
      reason: `Invited ${created.id} as ${roleLabel(role)} in ${domains.join(', ')} (Ory credential)`,
      detail: { role, domains, principal: grant.principal, tools: grant.tools, opaLive: grant.live },
    });
    return NextResponse.json({ user: { ...created, roleLabel: roleLabel(created.role) }, grant }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 500 });
  }
}

/** Change a role / memberships, or deactivate. Recompiles OPA + audits. */
export async function PATCH(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'admin' && user.role !== 'builder') {
    return NextResponse.json({ error: 'Managing users needs a Builder or Admin' }, { status: 403 });
  }
  let body: { id?: string; role?: string; domains?: unknown; deactivate?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const id = String(body?.id ?? '').trim().toLowerCase();
  if (!id) return NextResponse.json({ error: 'A user id is required' }, { status: 400 });
  const target = (await listUsers()).find((u) => u.id === id);
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 });
  if (!inActorScope(user, target.domains)) {
    return NextResponse.json({ error: 'That user is outside your domain scope' }, { status: 403 });
  }

  if (body?.deactivate) {
    await deleteUser(id);
    audit({ actor: user.id, action: 'role.change', subject: id, domain: target.domains[0] ?? 'tenant', reason: `Deactivated ${id}`, detail: { deactivated: true } });
    return NextResponse.json({ deactivated: id });
  }

  const role = (ROLES.includes(body?.role as Role) ? body!.role : target.role) as Role;
  const domains = Array.isArray(body?.domains) && body.domains.length ? body.domains.map(String).filter(Boolean) : target.domains;
  if (!inActorScope(user, domains) || domains.some((d) => !canManageRole(asActor(user), role, d))) {
    return NextResponse.json({ error: `You may not assign ${roleLabel(role)} in those domains` }, { status: 403 });
  }
  try {
    const updated = await updateUser(id, { role, domains });
    const grant = await compileRoleToGrants({ id: updated.id, role: updated.role });
    audit({
      actor: user.id,
      action: 'role.change',
      subject: updated.id,
      domain: domains[0],
      reason: `Set ${updated.id} → ${roleLabel(role)} in ${domains.join(', ')}; recompiled to OPA`,
      detail: { role, domains, principal: grant.principal, tools: grant.tools, opaLive: grant.live },
    });
    return NextResponse.json({ user: { ...updated, roleLabel: roleLabel(updated.role) }, grant });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 500 });
  }
}
