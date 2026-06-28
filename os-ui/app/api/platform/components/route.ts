/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * Components surface — live stack registry + status.
 *
 * Server-side proxy to the in-cluster Admin Console (GET /api/components). The
 * Admin Console holds the scoped Kubernetes RBAC + the single-source-of-truth
 * registry and answers with one object per component:
 *   { id, name, layer, status, svc, port, ns, lport, ui, url_path, login,
 *     summary, toggle }
 * The browser only ever talks to THIS route — the Admin Console URL (and the
 * pod's k8s ServiceAccount token behind it) never reach the client.
 */
export async function GET() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${config.adminConsoleUrl}/api/components`, {
      cache: 'no-store',
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { error: `Admin Console ${res.status}: ${text.slice(0, 200)}` },
        { status: 502 },
      );
    }
    let components: unknown;
    try {
      components = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: `Admin Console returned non-JSON: ${text.slice(0, 160)}` },
        { status: 502 },
      );
    }
    if (!Array.isArray(components)) {
      return NextResponse.json(
        { error: 'Admin Console returned an unexpected payload' },
        { status: 502 },
      );
    }
    return NextResponse.json({ components });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach the Admin Console: ${(e as Error).message}` },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
