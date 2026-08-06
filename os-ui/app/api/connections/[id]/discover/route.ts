/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { discoverWarehouse } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * Discover a warehouse catalog's schemas (GET) — and, with `?schema=<s>` (GET) or a
 * `{ schema }` body (POST), its tables — through the governed query path AS the caller.
 * Read-only; the credential is never touched here. Both verbs share the same logic so
 * the UI can browse with a plain GET and drill into a schema either way.
 */
async function discover(id: string, schema: string | undefined) {
  const user = await requireUser();
  try {
    return await discoverWarehouse(id, user, { schema });
  } catch (e) {
    // Not a warehouse catalog -> an api-batch sync source discovers its resources instead
    // (same response shape, read-only). Dispatch through the OPERATIONAL REGISTRY (M11) so
    // sap-odata / odata-v4 / workday-raas resolve to their real discover — the old inline
    // kajabi-vs-salesforce fork mis-dispatched every non-kajabi operational template to the
    // Salesforce describe. The registry is the ONE source of truth for per-template discovery.
    if ((e as { status?: number }).status === 400 && /Not a warehouse connection/i.test((e as Error).message)) {
      const { getConnectionForUser } = await import('@/lib/connections/store');
      const c = await getConnectionForUser(id, user); // DLS-scoped read (404 if unseeable)
      const { discoverOperational } = await import('@/lib/connections/operational-registry');
      return discoverOperational(c.template, id, user);
    }
    throw e;
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const schema = new URL(req.url).searchParams.get('schema') ?? undefined;
    return NextResponse.json(await discover(id, schema || undefined));
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { schema?: string };
    const schema = typeof body.schema === 'string' ? body.schema : undefined;
    return NextResponse.json(await discover(id, schema || undefined));
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
