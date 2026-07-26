/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { requireAdmin } from '@/lib/core/auth';
import { createUser, knownDomains, listUsers } from '@/lib/platform-admin/users';
import { assessPasswordStrength } from '@/lib/core/password';
import { ROLES, type Role } from '@/lib/core/session';

export const dynamic = 'force-dynamic';

/** Admin: list users + the known domain set (for the create form). */
export const GET = withRoute(async () => {
  const [users, domains] = await Promise.all([listUsers(), knownDomains()]);
  return NextResponse.json({ users, domains });
}, { gate: requireAdmin, defaultStatus: 500 });

/** Admin: create a user assigned to one or more domains + a role. */
export const POST = withRoute(async ({ req }) => {
    // Bare body read on purpose: an unparseable body throws the SyntaxError to
    // the wrapper's catch → 500 with the parse-error message, exactly as before.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json();
    const role = (ROLES.includes(body?.role) ? body.role : 'creator') as Role;
    const domains = Array.isArray(body?.domains) ? body.domains.map(String).filter(Boolean) : [];
    const password = String(body?.password ?? '');
    if (!password) {
      return NextResponse.json({ error: 'A password is required' }, { status: 400 });
    }
    const strength = assessPasswordStrength(password, String(body?.id ?? ''));
    if (!strength.ok) {
      return NextResponse.json({ error: strength.reasons[0] ?? 'Password is too weak' }, { status: 400 });
    }
    const user = await createUser({
      id: String(body?.id ?? ''),
      name: body?.name ? String(body.name) : undefined,
      email: body?.email ? String(body.email) : undefined,
      password,
      domains,
      role,
    });
    return NextResponse.json({ user }, { status: 201 });
}, { gate: requireAdmin, defaultStatus: 500 });
