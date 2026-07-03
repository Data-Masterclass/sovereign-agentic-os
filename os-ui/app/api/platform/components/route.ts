/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { listComponentsWithStatus } from '@/lib/platform';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Components surface — live stack registry + status.
 *
 * NATIVE implementation (no proxy). The OS UI server reads each component's
 * workload straight from the in-cluster Kubernetes API using the pod's scoped
 * ServiceAccount, and answers with one object per component:
 *   { id, name, layer, status, svc, port, ns, lport, ui, url_path, login,
 *     summary, toggle }
 * The browser only ever talks to THIS route — the k8s token never reaches the
 * client. (Formerly this proxied the standalone admin-console service.)
 */
export async function GET() {
  try {
    await requireAdmin();
    const components = await listComponentsWithStatus();
    return NextResponse.json({ components });
  } catch (e) {
    // Honor an auth status (401/403) from requireAdmin; otherwise it's a 502.
    const status = (e as { status?: number })?.status;
    if (status === 401 || status === 403) {
      return NextResponse.json({ error: (e as Error).message }, { status });
    }
    return NextResponse.json(
      { error: `Could not read component status: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
