/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * Toggle a component on/off.
 *
 * Server-side proxy to the Admin Console (POST /api/toggle?id=<id>), which
 * scales the component's workload 0<->1 via the k8s API using its scoped RBAC.
 * The OS UI deliberately does NOT hold any Kubernetes credentials — it forwards
 * the intent and relays the Admin Console's { ok, msg } verdict. The browser
 * posts { id } as JSON.
 */
export async function POST(req: Request) {
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

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(
      `${config.adminConsoleUrl}/api/toggle?id=${encodeURIComponent(id)}`,
      { method: 'POST', cache: 'no-store', signal: ctrl.signal, headers: { accept: 'application/json' } },
    );
    const text = await res.text();
    let data: { ok?: boolean; msg?: string; error?: string } = {};
    try {
      data = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { ok: false, error: `Admin Console returned non-JSON: ${text.slice(0, 160)}` },
        { status: 502 },
      );
    }
    return NextResponse.json(data, { status: res.ok ? 200 : res.status });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Could not reach the Admin Console: ${(e as Error).message}` },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
