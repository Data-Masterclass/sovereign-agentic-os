/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/core/auth';
import { generateTempPassword } from '@/lib/core/password';

export const dynamic = 'force-dynamic';

/** Admin: generate one strong candidate password (client calls this for the "Generate" button). */
export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json({ password: generateTempPassword() });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
