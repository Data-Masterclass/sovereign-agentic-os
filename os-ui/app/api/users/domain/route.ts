/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { roleAtLeast } from '@/lib/core/session';
import { directoryVisibleTo, listUsers } from '@/lib/platform-admin/users';

export const dynamic = 'force-dynamic';

/**
 * The READ-ONLY domain user directory — who can access apps in the caller's
 * domain(s), with their OS roles. Domain admins see their own domain(s); a
 * platform admin sees everyone; everyone else is refused (403). This backs the
 * Sovereign standard app's in-app Admin → "Who can access this app" list; user
 * MANAGEMENT stays in the OS (Admin → Users). No email or account flags leave
 * this route — only id, name, role and domains.
 */
export const GET = withRoute(async ({ user }) => {
  if (!roleAtLeast(user.role, 'domain_admin')) {
    return NextResponse.json(
      { error: 'The user directory is available to domain admins and administrators.' },
      { status: 403 },
    );
  }
  const users = directoryVisibleTo({ role: user.role, domains: user.domains }, await listUsers());
  return NextResponse.json({ users });
}, { defaultStatus: 500 });
