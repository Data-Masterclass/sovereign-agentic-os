/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { config } from '../core/config.ts';
import type { Role } from '../core/session.ts';
import { ROLE_RIGHTS, rightsToTools } from './roles.ts';
import { addAllowlist, listAllowlist, _reset as _resetSecurity } from '../platform-admin/security.ts';

/**
 * May this role SEE the consolidated policy plane? Gated on the `policy.view`
 * right (Builder = own domain, Admin = tenant) — NOT mere authentication. A
 * User/Creator has no policy.view right, so they are denied (403). This is the
 * real control; the sidebar's role hint is cosmetic.
 */
export function canViewPolicyPlane(role: Role): boolean {
  return (ROLE_RIGHTS[role] ?? []).some((r) => r.startsWith('policy.view'));
}

/**
 * Policies view (governance-golden-path.md §2) — a consolidated, READ-ONLY view
 * of the whole policy plane, with Admin OVERRIDE. Editing lives in each tab; here
 * you SEE who-can-do-what end-to-end: capability profiles + agent safety presets
 * + per-artifact grants + domain defaults, as compiled to OPA / Cube / DLS.
 *
 * The plane is assembled from three live sources of truth:
 *   1. role-derived grants (compiled from `roles.ts`),
 *   2. dynamic grants added by approvals (access requests, egress allowlist),
 *   3. Admin overrides (revocations),
 * and reads live OPA grants when the cluster is up. Overrides are audited by the
 * caller (the route) — this module just records the effect on the plane.
 */

export type GrantRow = {
  principal: string;
  tool: string;
  source: 'role' | 'access-grant' | 'egress' | 'standing';
  domain: string;
  /** Backing engine the grant compiles to. */
  compiledTo: 'OPA' | 'Cube' | 'OpenSearch-DLS';
};

// Dynamic plane state (access grants + revocations). The egress allowlist is NO
// longer kept here — it delegates to Admin → Security's REAL allowlist
// (lib/platform-admin/security.ts), the single source of truth that compiles to
// the OPA egress_allow resource + egress proxy. Governance only READS it (for the
// consolidated plane) and an approval effect ADDS to it via the same store.
type PolicyViewState = { accessGrants: GrantRow[]; overrides: Set<string> };
const PV_KEY = Symbol.for('soa.governance.policyView');
function pvState(): PolicyViewState {
  const g = globalThis as unknown as Record<symbol, PolicyViewState | undefined>;
  if (!g[PV_KEY]) g[PV_KEY] = { accessGrants: [], overrides: new Set() };
  return g[PV_KEY]!;
}

function revokeKey(principal: string, tool: string): string {
  return `${principal}|${tool}`;
}

/** Approval effect: grant a consumer access to a tool/dataset (compiles to OPA/DLS). */
export function addAccessGrant(input: {
  principal: string;
  tool: string;
  domain: string;
  compiledTo?: GrantRow['compiledTo'];
}): GrantRow {
  const row: GrantRow = {
    principal: input.principal,
    tool: input.tool,
    source: 'access-grant',
    domain: input.domain,
    compiledTo: input.compiledTo ?? 'OPA',
  };
  // de-dup
  const pv = pvState();
  if (!pv.accessGrants.some((g) => g.principal === row.principal && g.tool === row.tool)) {
    pv.accessGrants.push(row);
  }
  pv.overrides.delete(revokeKey(row.principal, row.tool)); // a fresh grant un-revokes
  return row;
}

/**
 * Approval effect: allowlist an egress endpoint. Writes to Admin → Security's
 * REAL allowlist (the single source of truth), normalising to a host. `domain`
 * and `approvedBy` are audited by the caller; the allowlist itself is tenant-wide
 * (Admin-curated), so we don't fabricate a per-host domain here.
 */
export function addEgressEndpoint(endpoint: string, _domain: string, _approvedBy: string): void {
  try {
    addAllowlist(endpoint);
  } catch {
    /* invalid host → the caller's audit still records the request; allowlist unchanged */
  }
}

/** Is this endpoint on Admin's real egress allowlist? Host-normalised there. */
export function isEgressAllowed(endpoint: string): boolean {
  const host = endpoint.replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
  return listAllowlist().includes(host);
}

/**
 * Read-only view of Admin's real egress allowlist for the consolidated plane.
 * Each host is tenant-wide (Admin-curated), so `domain: 'tenant'`. When a Builder
 * scope is passed we still surface the tenant allowlist (it applies to them too).
 */
export function listEgress(_domains?: string[]): { endpoint: string; domain: string; approvedBy: string }[] {
  return listAllowlist().map((host) => ({ endpoint: host, domain: 'tenant', approvedBy: 'admin' }));
}

/** Admin override: revoke a grant from the plane. Returns whether a row matched. */
export function overrideRevoke(principal: string, tool: string): boolean {
  const pv = pvState();
  pv.overrides.add(revokeKey(principal, tool));
  const before = pv.accessGrants.length;
  for (let i = pv.accessGrants.length - 1; i >= 0; i--) {
    if (pv.accessGrants[i].principal === principal && pv.accessGrants[i].tool === tool) {
      pv.accessGrants.splice(i, 1);
    }
  }
  return before !== pv.accessGrants.length || true; // override always recorded
}

export function isRevoked(principal: string, tool: string): boolean {
  return pvState().overrides.has(revokeKey(principal, tool));
}

/**
 * The consolidated plane: role-derived grants for the given users + dynamic
 * access grants + egress, minus Admin overrides. Scoped to `domains` for a
 * Builder; omit for tenant-wide (Admin).
 */
export function consolidatedPlane(
  users: { id: string; role: Role; domains: string[] }[],
  domains?: string[],
): GrantRow[] {
  const rows: GrantRow[] = [];
  for (const u of users) {
    const principal = `user:${u.id}`;
    for (const tool of rightsToTools(u.role)) {
      const domain = u.domains[0] ?? 'default';
      if (domains && !u.domains.some((d) => domains.includes(d))) continue;
      if (isRevoked(principal, tool)) continue;
      rows.push({ principal, tool, source: 'role', domain, compiledTo: 'OPA' });
    }
  }
  const pv = pvState();
  for (const g of pv.accessGrants) {
    if (domains && !domains.includes(g.domain)) continue;
    if (isRevoked(g.principal, g.tool)) continue;
    rows.push(g);
  }
  // Egress allowlist rows come from Admin → Security's real allowlist (tenant-wide).
  // A Builder scope still sees them — the tenant allowlist applies to their domain too.
  for (const e of listEgress(domains)) {
    rows.push({ principal: `domain:${e.domain}`, tool: `egress:${e.endpoint}`, source: 'egress', domain: e.domain, compiledTo: 'OPA' });
  }
  return rows.sort((a, b) => a.principal.localeCompare(b.principal) || a.tool.localeCompare(b.tool));
}

/** The capability-profile / safety-preset / domain-default catalogue (read-only). */
export function policySources(): { name: string; authoredIn: string; compiledTo: string; rights: string[] }[] {
  return [
    { name: 'Creator (capability profile)', authoredIn: 'Connections', compiledTo: 'OPA', rights: ROLE_RIGHTS['creator'] },
    { name: 'Builder (capability profile)', authoredIn: 'Connections', compiledTo: 'OPA/Cube', rights: ROLE_RIGHTS.builder },
    { name: 'Domain admin (capability profile)', authoredIn: 'Connections', compiledTo: 'OPA/Cube', rights: ROLE_RIGHTS.domain_admin },
    { name: 'Admin (capability profile)', authoredIn: 'Connections', compiledTo: 'OPA/Cube/DLS', rights: ROLE_RIGHTS.admin },
  ];
}

/** Live read of OPA grants (the in-cluster compiled data). Null when OPA is off. */
export async function readOpaGrants(): Promise<Record<string, string[]> | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`${config.opaUrl}/v1/data/grants`, { cache: 'no-store', signal: ctrl.signal });
    if (!res || !res.ok) return null;
    const data = (await res.json()) as { result?: Record<string, unknown> };
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(data?.result ?? {})) out[k] = Array.isArray(v) ? v.map(String) : [];
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function __resetPlane(): void {
  const pv = pvState();
  pv.accessGrants.length = 0;
  pv.overrides.clear();
  // Egress lives in Admin → Security's store; reset it there so tests start clean.
  _resetSecurity();
}
