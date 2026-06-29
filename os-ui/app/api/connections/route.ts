/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { createConnection, listConnectionsForUser } from '@/lib/connections';
import { CONNECTION_TEMPLATES, type ConnectionTemplateKey } from '@/lib/connection-model';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** Governed connections visible to the caller (Personal + domain Shared + Marketplace). */
export async function GET() {
  try {
    const user = await requireUser();
    const connections = await listConnectionsForUser(user);
    const templates = CONNECTION_TEMPLATES.map((t) => ({
      key: t.key,
      label: t.label,
      type: t.type,
      endpointHint: t.endpointHint,
    }));
    const canCreate = user.role === 'builder' || user.role === 'admin';
    return NextResponse.json({ user, connections, templates, canCreate });
  } catch (e) {
    return fail(e);
  }
}

/**
 * New connection (Builder/Admin only). Writes the credential to Secrets Manager
 * (record keeps only a ref), checks the egress allowlist for external endpoints,
 * compiles the safe-preset capability profile into the connection's OPA policy.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = await req.json();
    const name = String(body?.name ?? '').trim();
    const template = String(body?.template ?? '') as ConnectionTemplateKey;
    if (!name) return NextResponse.json({ error: 'A connection name is required' }, { status: 400 });
    if (!template) return NextResponse.json({ error: 'A connection template/type is required' }, { status: 400 });
    const conn = await createConnection(user, {
      name,
      template,
      endpoint: String(body?.endpoint ?? ''),
      credential: String(body?.credential ?? ''),
      domain: body?.domain ? String(body.domain) : undefined,
    });
    return NextResponse.json({ connection: conn }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}
