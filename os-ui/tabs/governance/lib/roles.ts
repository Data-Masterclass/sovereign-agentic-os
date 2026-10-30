/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * TAB:        governance
 * FEATURE:    Role DEFINITIONS — what each role type may do, as a governed, auditable policy surface
 * USER STORY: As a platform admin I want to define what a role may do beside approvals, the OPA
 *             policy view and the audit log, because that is a rare, high-stakes, auditable policy
 *             decision; assigning a person a role stays routine administration in Platform →
 *             Users & Access, one click away.
 * ARCHITECTURE:
 *   - Data + pure functions only, so it is unit-testable: a .tsx cannot be imported from a test in
 *     this harness, so everything testable lives here and tabs/governance/ui/RolesView.tsx renders it.
 *   - The MATRIX itself is kernel state (@core/policy/role-config): shared by the OPA compiler, the
 *     gates and /api/platform-admin/roles. This module owns only the governance-side vocabulary
 *     (role order, the one-line blurbs, the definition projection) and the pure diffing the editor
 *     needs. Nothing here writes; the write path is PATCH /api/platform-admin/roles, adminCtx()-gated.
 *   - Moved out of app/(govern)/platform/roles/page.tsx on 2026-10-30 (whole surface, not a split).
 */
import { ROLES, type Role } from '@core/kernel/session';
import {
  CAPABILITIES,
  COMPONENTS,
  resolveRoleRights,
  type Capability,
  type Component,
} from '@core/policy/role-config';
import { rightsToTools, roleLabel } from '@core/policy/roles';

export type { Capability, Component };

/** Matrix columns, lowest → highest privilege. The kernel's order, not a second one. */
export const ROLE_ORDER: readonly Role[] = ROLES;

/** One line per role, so the editor says what the role IS before saying what it may do. */
export const ROLE_BLURB: Record<Role, string> = {
  creator: 'Base role — create & run their own work and consume shared assets. Cannot promote, approve, or reach admin.',
  builder: 'Domain approver — creator rights plus review/approve domain promotions, deploys, knowledge and connections. Not a people-admin.',
  domain_admin: 'Builder rights plus administering users in their own domain(s) — invite, edit, deactivate, assign roles up to Builder. Never mints another domain admin.',
  admin: 'Tenant control — everything, plus users, policy, certification, egress and cost caps. The only role that assigns Domain admin.',
};

/** A role as the Governance roles tab shows it: identity + what it currently resolves to. */
export type RoleDefinition = {
  id: Role;
  label: string;
  blurb: string;
  /** Abstract rights the live matrix compiles to for this role. Never empty. */
  rights: string[];
  /** OPA tool grants those rights expand to. */
  tools: string[];
};

/**
 * The live role definitions. Reads the pinned matrix synchronously via
 * `resolveRoleRights`, so it reflects an Admin's edits and falls back to the safe
 * DEFAULT_MATRIX before hydration — never an empty grant.
 */
export function roleDefinitions(): RoleDefinition[] {
  return ROLE_ORDER.map((r) => ({
    id: r,
    label: roleLabel(r),
    blurb: ROLE_BLURB[r],
    rights: resolveRoleRights(r),
    tools: rightsToTools(r),
  }));
}

/** The matrix as it travels over the wire (component ids are plain keys there). */
export type RoleMatrixWire = Record<Role, Record<string, Capability[]>>;

/** Everything the editor renders: the matrix plus its vocabulary. */
export type RolesView = {
  components: typeof COMPONENTS;
  capabilities: typeof CAPABILITIES;
  applicable: Record<string, Capability[]>;
  matrix: RoleMatrixWire;
  roles: RoleDefinition[];
};

/** Does `role` hold `cap` on `comp` in this matrix? Tolerant of a missing row. */
export function hasCapability(
  matrix: RoleMatrixWire,
  role: Role,
  comp: string,
  cap: Capability,
): boolean {
  return (matrix[role]?.[comp] ?? []).includes(cap);
}

/** One cell an admin has changed but not yet saved. */
export type PendingChange = {
  role: Role;
  comp: string;
  compLabel: string;
  cap: Capability;
  capLabel: string;
  enabled: boolean;
};

/**
 * Every difference between the saved matrix and the admin's working copy, in a
 * stable order (role → component → capability) so the "what changes" bar reads
 * the same way twice. Only APPLICABLE cells are compared, so a non-applicable
 * cell can never produce a phantom change.
 */
export function pendingChanges(view: RolesView, local: RoleMatrixWire): PendingChange[] {
  const out: PendingChange[] = [];
  for (const role of ROLE_ORDER) {
    for (const c of view.components) {
      for (const cap of view.applicable[c.id] ?? []) {
        const before = hasCapability(view.matrix, role, c.id, cap);
        const after = hasCapability(local, role, c.id, cap);
        if (before !== after) {
          const capLabel = view.capabilities.find((k) => k.id === cap)?.label ?? cap;
          out.push({ role, comp: c.id, compLabel: c.label, cap, capLabel, enabled: after });
        }
      }
    }
  }
  return out;
}

/** Toggle one cell in a COPY of the matrix — the editor never mutates what it fetched. */
export function toggleCapability(
  matrix: RoleMatrixWire,
  role: Role,
  comp: string,
  cap: Capability,
): RoleMatrixWire {
  const next = JSON.parse(JSON.stringify(matrix)) as RoleMatrixWire;
  const row = next[role] ?? (next[role] = {});
  const set = new Set(row[comp] ?? []);
  if (set.has(cap)) set.delete(cap);
  else set.add(cap);
  row[comp] = [...set];
  return next;
}
