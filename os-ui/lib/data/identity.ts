/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Role } from '../core/session.ts';
import { privatePrefix } from './personal-lane.ts';

/**
 * Delegated identity — the linchpin of data governance (data-policy-compiler.md).
 * Three hard requirements made concrete here:
 *
 *   R2 — agents run UNDER THE USER's delegated identity, never a service account.
 *        `delegate()` mints a DOWNSCOPED token bound to the user's `sub`; passing a
 *        service account is refused. If a superuser identity reached OPA/Cube, RLS
 *        would collapse — so this is a platform invariant, not an option.
 *   R3 — that ONE identity propagates Superset -> Cube -> Trino. `propagate()`
 *        derives all three consumer identities from the SAME claims: Trino gets the
 *        coarse `user` + `groups` (low-card attributes encoded as groups, R1), Cube
 *        gets the full claims as `securityContext`. No shared service identity for reads.
 *   Personal lane — the agent's `personal` scope can reach ONLY the user's own
 *        private prefix (`privatePrefix`) / `personal_<uid>` Iceberg schema, never
 *        another user's data. Its queries run through the SAME governed Trino path.
 *
 * Pure module (a mock of the Ory adapter) so the invariants are unit-tested without
 * a live IdP; the real token signing is wired at deploy. Mock-from-session per the
 * locked decision.
 */

export type AgentScope = 'personal' | 'domain' | 'marketplace';

/** The user's identity claims (Ory JWT, modelled). */
export type Claims = {
  sub: string;
  domains: string[];
  role: Role;
  /** Low-cardinality attributes that become Trino groups (region:DE …). */
  attributes: Record<string, string>;
};

/** A downscoped, user-bound token — the only thing a governed tool ever runs under. */
export type DelegatedToken = {
  sub: string;
  /** Delegation marker: the principal a tool acts on behalf of == the user (R2). */
  onBehalfOf: string;
  scope: AgentScope;
  domains: string[];
  role: Role;
  attributes: Record<string, string>;
  /** Marketplace product FQNs the user has imported (only populated for that scope). */
  imported: string[];
};

export class IdentityError extends Error {
  status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.name = 'IdentityError';
    this.status = status;
  }
}

/** Service-account principals are refused as delegated identities (R2). */
const SERVICE_ACCOUNT = /^(svc[-_]|service[-_]|system$|root$|trino$|cube$|superset$)/i;

export function isServiceAccount(sub: string): boolean {
  return SERVICE_ACCOUNT.test(sub);
}

/** Build claims from the signed-in user (mock-from-session per locked decision). */
export function claimsFromUser(user: { id: string; domains: string[]; role: Role; attributes?: Record<string, string> }): Claims {
  return { sub: user.id, domains: user.domains, role: user.role, attributes: user.attributes ?? {} };
}

/**
 * R2 — mint a downscoped token the user's agent runs under. Refuses a service
 * account. Domains/imports are narrowed to the requested scope so the token can
 * never reach beyond the agent's lane.
 */
export function delegate(claims: Claims, scope: AgentScope, opts: { imported?: string[] } = {}): DelegatedToken {
  if (!claims.sub) throw new IdentityError('cannot delegate without a user subject');
  if (isServiceAccount(claims.sub)) {
    throw new IdentityError(`refusing to delegate to a service account '${claims.sub}' — agents run as the user (R2)`);
  }
  return {
    sub: claims.sub,
    onBehalfOf: claims.sub,
    scope,
    // personal scope needs no domain grants (sandbox is bound to the subject);
    // domain scope carries the user's domains; marketplace carries neither.
    domains: scope === 'domain' ? [...claims.domains] : [],
    role: claims.role,
    attributes: { ...claims.attributes },
    imported: scope === 'marketplace' ? (opts.imported ?? []) : [],
  };
}

/** Guard a tool call: the running identity must be a user-delegated token (R2). */
export function assertDelegated(token: DelegatedToken): void {
  if (token.onBehalfOf !== token.sub || isServiceAccount(token.sub)) {
    throw new IdentityError('tool call is not running under the user delegated identity (R2)');
  }
}

/**
 * R1 — encode low-cardinality attributes (+ domain + role) as Trino groups, since
 * Trino's OPA input identity is only `user` + `groups`. High-cardinality
 * entitlements are NOT groups (they resolve via an entitlement-table join in the
 * compiler) and so are excluded here.
 */
export function trinoGroups(claims: Claims): string[] {
  const groups = [`role:${claims.role}`, ...claims.domains.map((d) => `domain:${d}`)];
  for (const [k, v] of Object.entries(claims.attributes)) groups.push(`${k}:${v}`);
  return groups.sort();
}

export type TrinoIdentity = { user: string; groups: string[] };
export type CubeIdentity = { securityContext: Record<string, unknown> };
export type ConsumerIdentities = {
  trino: TrinoIdentity;
  cube: CubeIdentity;
  /** Present ONLY for the personal scope: the user's own sandbox prefix. */
  sandboxPrefix: string | null;
};

/**
 * R3 — derive the Superset->Cube->Trino identities from one delegated token, so the
 * SAME user identity is enforced at every hop (no shared service identity). The
 * personal sandbox prefix is exposed only for the `personal` scope, and only ever the
 * caller's own prefix.
 */
export function propagate(token: DelegatedToken): ConsumerIdentities {
  assertDelegated(token);
  const claims: Claims = { sub: token.sub, domains: token.domains, role: token.role, attributes: token.attributes };
  return {
    trino: { user: token.sub, groups: trinoGroups(claims) },
    cube: {
      securityContext: {
        sub: token.sub,
        domains: token.domains,
        role: token.role,
        scope: token.scope,
        imported: token.imported,
        ...token.attributes,
      },
    },
    sandboxPrefix: token.scope === 'personal' ? privatePrefix(token.sub) : null,
  };
}

/** Personal-lane guard: a prefix the agent may read must be the caller's own (never
 *  another user's private lane). The hard per-user isolation the personal scope rests on. */
export function assertOwnSandbox(token: DelegatedToken, prefix: string): void {
  if (prefix !== privatePrefix(token.sub)) {
    throw new IdentityError('personal scope may only read the user’s own private prefix');
  }
}
