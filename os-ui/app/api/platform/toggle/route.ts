/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/core/auth';
import { toggleComponent } from '@/lib/platform';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Toggle a component on/off.
 *
 * NATIVE implementation (no proxy). Scales the component's workload 0<->1 via
 * the in-cluster Kubernetes API using the OS UI pod's scoped ServiceAccount,
 * with a core-guard (non-toggleable components are refused). The browser posts
 * { id } as JSON and gets back the { ok, msg } verdict.
 *
 * ADMIN-ONLY: scaling cluster workloads with the pod ServiceAccount is a
 * platform-admin action — middleware lets every /api/* through, so this route is
 * the only real gate. Non-admins (participant/creator/builder) get 403.
 */
export async function POST(req: Request) {
  try {
    await requireAdmin();
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 401;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }

  let id = '';
  try {
    const body = await req.json();
    id = (body?.id ?? '').toString().trim();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!id) {
    return NextResponse.json({ error: 'Missing component id' }, { status: 400 });
  }

  try {
    const result = await toggleComponent(id);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Toggle failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
