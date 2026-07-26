/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { approveOnce } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * "Approve once" (Mode A) — the connection owner or a domain Builder/Admin approves
 * a held Write-approval call inline and resumes the run, executing it exactly once
 * (no standing policy). The capability profile is re-checked server-side, so an
 * Off / Blocked / over-bound call is refused even by an approver. Body: { tool, args? }.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params, req }) => {
    const { id } = params;
    const body = await req.json();
    const tool = String(body?.tool ?? '').trim();
    if (!tool) return NextResponse.json({ error: 'A tool name is required' }, { status: 400 });
    const out = await approveOnce(id, user, { tool, args: body?.args ?? {} });
    // executed→200, refused-by-profile→403.
    const status = out.decision === 'allow' ? 200 : 403;
    return NextResponse.json(out, { status });
}, { defaultStatus: 500 });
