/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { requireAdmin } from '@/lib/core/auth';
import { toggleComponent } from '@/lib/platform-admin/platform';

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
export const POST = withRoute<Record<string, string>, { id?: unknown }>(async ({ body }) => {
  const id = (body?.id ?? '').toString().trim();
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
}, { gate: requireAdmin, parse: true, invalidJsonStatus: 400, invalidJsonMessage: 'Invalid JSON body', defaultStatus: 401 });
