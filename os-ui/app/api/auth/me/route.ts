/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { currentUser, roster } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** The signed-in user (or null) plus the seeded roster (for the sign-in helper). */
export async function GET() {
  const user = await currentUser();
  return NextResponse.json({ user, roster: await roster() });
}
