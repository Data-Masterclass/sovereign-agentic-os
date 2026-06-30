/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { myImports, type Viewer } from '@/lib/marketplace';

export const dynamic = 'force-dynamic';

/** The caller's imports (their grants) for the "My imports" view. */
export async function GET() {
  try {
    const user = await requireUser();
    const viewer: Viewer = { id: user.id, domains: user.domains, role: user.role };
    return NextResponse.json({ grants: myImports(viewer) });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
