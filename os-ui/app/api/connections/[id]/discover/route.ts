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
  return discoverWarehouse(id, user, { schema });
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
