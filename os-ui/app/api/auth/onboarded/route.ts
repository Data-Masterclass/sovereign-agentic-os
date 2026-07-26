/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { markOnboarded } from '@/lib/platform-admin/users';

export const dynamic = 'force-dynamic';

/** Mark the signed-in user's first-login onboarding wizard as complete. */
export const POST = withRoute(async ({ user }) => {
  await markOnboarded(user.id);
  return NextResponse.json({ ok: true });
}, { defaultStatus: 500 });
