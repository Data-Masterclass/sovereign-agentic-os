/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
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
    const components = await listComponentsWithStatus();
    return NextResponse.json({ components });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not read component status: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
