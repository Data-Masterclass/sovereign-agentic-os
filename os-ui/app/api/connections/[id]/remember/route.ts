/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute, apiError } from '@core/kernel/route-server';
import { approveAndRemember } from '@tabs/connections/lib/index';

export const dynamic = 'force-dynamic';

/**
 * "Approve & remember" (Mode A) — approve a held write AND create a bounded
 * standing policy so identical calls stop prompting. The owner or a domain
 * Builder/Admin only. Body: { tool, args?, approvalId? } (`approvalId` names the requester on the trace).
 */
export const POST = withRoute<{ id: string }>(async ({ user, params, req }) => {
    const { id } = params;
    const body = await req.json();
    const tool = String(body?.tool ?? '').trim();
    if (!tool) return apiError(400, 'A tool name is required', 'connections.toolNameRequired');
    const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : undefined;
    const out = await approveAndRemember(id, user, { tool, args: body?.args ?? {}, approvalId });
    return NextResponse.json(out);
}, { defaultStatus: 500 });
