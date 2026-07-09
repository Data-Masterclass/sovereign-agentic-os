/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/core/auth';
import { listUsers } from '@/lib/users';
import { canViewPolicyPlane, consolidatedPlane, listEgress, overrideRevoke, policySources, readOpaGrants } from '@/lib/governance/policy-view';
import { listStanding, ensureHydrated } from '@/lib/governance/standing';
import { record as audit } from '@/lib/governance/audit';

export const dynamic = 'force-dynamic';

/**
 * Policies view (§2). GET = the consolidated, read-only plane (role-derived
 * grants + access grants + egress + standing), scoped to the caller (Admin =
 * tenant, Builder = own domains). POST = an Admin OVERRIDE (revoke a grant),
 * which is audited.
 */
export async function GET() {
  await ensureHydrated();
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  // Gate on the policy.view right (Builder+), not mere authentication — a
  // User/Creator must not read the whole tenant's grant plane.
  if (!canViewPolicyPlane(user.role)) {
    return NextResponse.json({ error: 'Viewing the policy plane requires the policy.view right (Builder or Admin)' }, { status: 403 });
  }
  const scope = user.role === 'admin' ? undefined : user.domains;
  const users = await listUsers();
  const plane = consolidatedPlane(users, scope);
  const opa = await readOpaGrants();
  return NextResponse.json({
    plane,
    sources: policySources(),
    egress: listEgress(scope),
    standing: listStanding(scope),
    opaLive: opa !== null,
    canOverride: user.role === 'admin',
  });
}

export async function POST(req: Request) {
  await ensureHydrated();
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  if (user.role !== 'admin') {
    return NextResponse.json({ error: 'Overriding policy requires an Administrator' }, { status: 403 });
  }
  let body: { principal?: string; tool?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const principal = String(body?.principal ?? '');
  const tool = String(body?.tool ?? '');
  if (!principal || !tool) return NextResponse.json({ error: 'principal + tool required' }, { status: 400 });
  overrideRevoke(principal, tool);
  audit({
    actor: user.id,
    action: 'policy.override',
    subject: `${principal}→${tool}`,
    domain: 'tenant',
    reason: `Admin override: revoked ${tool} from ${principal}`,
    detail: { principal, tool },
  });
  return NextResponse.json({ revoked: { principal, tool } });
}
