/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Role } from '../session.ts';
import type { Approval } from '../approvals.ts';
import { config } from '../config.ts';

/**
 * Role → scope → OPA mapping — the Governance identity spine (governance-golden-
 * path.md §5, "Roles & scope"). A user's role-per-domain is the SOURCE; this
 * module is the COMPILER: it ranks roles, decides who may see/approve which
 * queue item (Builder = own domain, Admin = tenant, User = own requests), and
 * compiles a role into the OPA grants every tab enforces. Changing a role here
 * changes what that person can do everywhere — because it recompiles to OPA.
 *
 * Pure + dependency-light on purpose (no `server-only`): the rank/scope logic is
 * unit-tested directly. The only side-effectful piece — the best-effort OPA
 * write-through — is isolated in `writeGrantsToOpa` and fails open (marked),
 * mirroring the rest of the OS's live + offline-mock dual pattern.
 */

export type Scope = 'own' | 'domain' | 'tenant';
export type Actor = { id: string; domains: string[]; role: Role };

/** Lowest→highest privilege. `creator` is the base role (rank 0). */
const RANK: Record<Role, number> = { creator: 0, builder: 1, admin: 2 };
const LABEL: Record<Role, string> = {
  creator: 'Creator',
  builder: 'Builder',
  admin: 'Admin',
};

export function roleRank(role: Role): number {
  // Unknown/malformed roles compile to creator (rank 0 — the base role).
  return RANK[role] ?? 0;
}
/** Human label for a role (Agentic Leader Program · Builder · Admin). */
export function roleLabel(role: Role): string {
  return LABEL[role] ?? role;
}

/**
 * The rights each role carries, lowest→highest (cumulative). These compile to
 * the OPA tool grants below and drive the consolidated Policies view.
 */
export const ROLE_RIGHTS: Record<Role, string[]> = {
  creator: ['read.own', 'request.access', 'request.import', 'create.artifact', 'run.attended'],
  builder: [
    'read.own',
    'request.access',
    'request.import',
    'create.artifact',
    'run.attended',
    'policy.view.domain',
    'approve.domain',
    'deploy.review',
    'promote.shared',
    'manage.memberships.domain',
  ],
  admin: [
    'read.own',
    'request.access',
    'request.import',
    'create.artifact',
    'run.attended',
    'policy.view.tenant',
    'approve.domain',
    'approve.tenant',
    'deploy.review',
    'promote.shared',
    'promote.certify',
    'egress.approve',
    'override.policy',
    'cost.cap.set',
    'manage.users.tenant',
  ],
};

/** Representative OPA tools a role unlocks (what the grants matrix shows). */
const RIGHT_TO_TOOLS: Record<string, string[]> = {
  'read.own': ['metrics', 'query'],
  'create.artifact': ['knowledge_write'],
  'approve.domain': ['approve'],
  'approve.tenant': ['approve', 'egress'],
  'deploy.review': ['deploy'],
  'override.policy': ['policy_override'],
  'cost.cap.set': ['cost_cap'],
  'manage.users.tenant': ['user_admin'],
  'manage.memberships.domain': ['membership_admin'],
};

/** Compile a role into the deduped set of OPA tools it grants. */
export function rightsToTools(role: Role): string[] {
  const tools = new Set<string>();
  for (const right of ROLE_RIGHTS[role] ?? []) {
    for (const t of RIGHT_TO_TOOLS[right] ?? []) tools.add(t);
  }
  return [...tools].sort();
}

/** The OPA principal for a user — the seam every tab's authz keys on. */
export function principalFor(actor: Pick<Actor, 'id'>): string {
  return `user:${actor.id}`;
}

/** Does `actor` have at least `min` privilege? */
export function hasRole(actor: Actor, min: Role): boolean {
  return roleRank(actor.role) >= roleRank(min);
}

/** Builder/Admin may act within a domain; Admin spans the tenant. */
export function inScope(actor: Actor, domain: string, scope: Scope): boolean {
  if (actor.role === 'admin') return true;
  if (scope === 'tenant') return false; // tenant items are Admin-only
  if (scope === 'own') return false; // own requests aren't "approved" by self
  return actor.domains.includes(domain);
}

/** Can `actor` SEE this queue item? Admin = all, Builder = own domain, User = own. */
export function canSee(actor: Actor, a: Pick<Approval, 'domain' | 'requestedBy'>): boolean {
  if (actor.role === 'admin') return true;
  if (a.requestedBy === actor.id) return true;
  if (actor.role === 'builder') return actor.domains.includes(a.domain);
  return false;
}

/**
 * Can `actor` APPROVE this item? The control-plane gate: role rank ≥ the item's
 * required approver AND the item is in the actor's scope. Egress / tenant items
 * are Admin-only; domain items need a Builder (or Admin) of that domain.
 */
export function canApprove(
  actor: Actor,
  a: Pick<Approval, 'domain' | 'approverRole' | 'scope'>,
): boolean {
  if (roleRank(actor.role) < roleRank(a.approverRole)) return false;
  return inScope(actor, a.domain, a.scope);
}

/**
 * Can `actor` assign `targetRole` in `domain`? Admin = any role, tenant-wide.
 * Builder = within their own domain, UP TO Builder (never mints an Admin).
 */
export function canManageRole(actor: Actor, targetRole: Role, domain: string): boolean {
  if (actor.role === 'admin') return true;
  if (actor.role !== 'builder') return false;
  if (!actor.domains.includes(domain)) return false;
  return roleRank(targetRole) <= roleRank('builder');
}

/**
 * Best-effort compile of a user's role into OPA grants (live + offline-mock).
 * PUTs `{tools}` under `data.grants[principal]` so every tab's default-deny
 * authz reflects the new role immediately. If OPA is unreachable we return
 * `live:false` with the compiled tools so the teaching flow still proves the
 * mapping; a real deploy reconciles the same data into the OPA ConfigMap.
 */
export async function writeGrantsToOpa(
  principal: string,
  tools: string[],
): Promise<{ live: boolean; principal: string; tools: string[] }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`${config.opaUrl}/v1/data/grants/${encodeURIComponent(principal)}`, {
      method: 'PUT',
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tools),
    });
    return { live: Boolean(res && res.ok), principal, tools };
  } catch {
    return { live: false, principal, tools };
  } finally {
    clearTimeout(timer);
  }
}

/** Compile + push a user's whole role to OPA. Returns the compiled grant. */
export async function compileRoleToGrants(
  actor: Pick<Actor, 'id' | 'role'>,
): Promise<{ live: boolean; principal: string; tools: string[] }> {
  const principal = principalFor(actor);
  const tools = rightsToTools(actor.role);
  return writeGrantsToOpa(principal, tools);
}
