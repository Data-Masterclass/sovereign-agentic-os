/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/core/auth';
import { createUser, knownDomains, listUsers } from '@/lib/users';
import { ROLES, type Role } from '@/lib/core/session';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** Admin: list users + the known domain set (for the create form). */
export async function GET() {
  try {
    await requireAdmin();
    const [users, domains] = await Promise.all([listUsers(), knownDomains()]);
    return NextResponse.json({ users, domains });
  } catch (e) {
    return fail(e);
  }
}

/** Admin: create a user assigned to one or more domains + a role. */
export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = await req.json();
    const role = (ROLES.includes(body?.role) ? body.role : 'creator') as Role;
    const domains = Array.isArray(body?.domains) ? body.domains.map(String).filter(Boolean) : [];
    const user = await createUser({
      id: String(body?.id ?? ''),
      name: body?.name ? String(body.name) : undefined,
      email: body?.email ? String(body.email) : undefined,
      password: String(body?.password ?? ''),
      domains,
      role,
    });
    return NextResponse.json({ user }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}
