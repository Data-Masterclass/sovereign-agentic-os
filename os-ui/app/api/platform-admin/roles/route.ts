/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import {
  getMatrix,
  setCapability,
  COMPONENTS,
  CAPABILITIES,
  isApplicable,
  type Component,
  type Capability,
} from '@core/policy/role-config';
import { compileRoleToGrants } from '@core/policy/roles';
// The role DEFINITION vocabulary (order, blurbs, the definition projection) is
// owned by Governance — defining what a role may do is policy. This route is
// only the adminCtx()-gated write path.
import { roleDefinitions } from '@tabs/governance/lib/roles';
import { audit } from '@tabs/admin/lib/audit';
import { listUsers } from '@tabs/admin/lib/users';
import { ROLES, type Role } from '@core/kernel/session';

export const dynamic = 'force-dynamic';


/** The full matrix + everything the editor needs to render + a live rights/tools read. */
async function view() {
  const matrix = await getMatrix();
  const applicable: Record<string, Capability[]> = {};
  for (const c of COMPONENTS) applicable[c.id] = CAPABILITIES.map((k) => k.id).filter((k) => isApplicable(c.id, k));
  return { components: COMPONENTS, capabilities: CAPABILITIES, applicable, matrix, roles: roleDefinitions() };
}

export async function GET() {
  try {
    await adminCtx();
    return NextResponse.json(await view());
  } catch (e) {
    return fail(e);
  }
}

/**
 * Toggle one capability for one role on one component. Admin-only (adminCtx),
 * validated + fail-safe in the store (non-applicable rejected, admin can never
 * lose platform-management), audited, and the OPA grants of every user in that
 * role are recompiled so the change takes effect platform-wide.
 */
export async function PATCH(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    const body = await req.json();
    const role = body?.role as Role;
    const component = body?.component as Component;
    const capability = body?.capability as Capability;
    const enabled = Boolean(body?.enabled);
    if (!ROLES.includes(role)) return NextResponse.json({ error: 'Unknown role' }, { status: 400 });

    await setCapability(role, component, capability, enabled);

    // Recompile OPA grants for every user holding this role (best-effort, honest
    // when OPA is offline — the compiled tools still return).
    const users = await listUsers();
    const affected = users.filter((u) => u.role === role);
    const grants = await Promise.all(affected.map((u) => compileRoleToGrants({ id: u.id, role })));
    const live = grants.some((g) => g.live);

    audit({
      tenant: tenant.id,
      actor: user.id,
      role: user.role,
      action: 'role.capability.set',
      target: `role:${role}`,
      detail: `${enabled ? 'Granted' : 'Revoked'} ${capability} on ${component} for ${role}; recompiled ${affected.length} user grant(s)${live ? ' (published to OPA)' : ' (OPA offline)'}`,
      result: 'ok',
    });

    return NextResponse.json({ ...(await view()), recompiled: affected.length, live });
  } catch (e) {
    return fail(e);
  }
}
