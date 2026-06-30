/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { importAdapter, type Viewer, type ImportMode } from '@/lib/marketplace';

export const dynamic = 'force-dynamic';

/**
 * Import a product → a governed grant. Body: { mode?, as? }.
 *   - read-grant types: a per-viewer RLS grant (auto-granted if open, else held
 *     in Governance).
 *   - fork/template/instance: a derived owned artifact (+ grant record).
 * `as` is the domain to import INTO (for multi-domain users).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { mode?: ImportMode; as?: string };
    const viewer: Viewer = { id: user.id, domains: user.domains, role: user.role, activeDomain: body.as };
    const result = await importAdapter.import(id, viewer, body.mode);
    return NextResponse.json(result, { status: result.pending ? 202 : 201 });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
