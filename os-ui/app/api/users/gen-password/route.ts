/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { requireAdmin } from '@/lib/core/auth';
import { generateTempPassword } from '@/lib/core/password';

export const dynamic = 'force-dynamic';

/** Admin: generate one strong candidate password (client calls this for the "Generate" button). */
export const GET = withRoute(async () => {
  return NextResponse.json({ password: generateTempPassword() });
}, { gate: requireAdmin, defaultStatus: 500 });
