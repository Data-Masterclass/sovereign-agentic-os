/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder B - approve, edit or reject one diff card
 * USER STORY: As anyone who can edit the app I want to approve a proposed story change (one commit with my name),
 *             correct it first, or reject it with a reason, and be told when someone else changed it meanwhile.
 * ARCHITECTURE:
 *   - Thin shell over `decideProposal` (the same function `decide_requirement` calls; commit source `chat`). The App
 *     Builder guard runs first; OPA `authorize()` (`software_checks`) before the effect; then the app's edit scope.
 *   - POST `{ decision: 'approve' | 'edit' | 'reject', rev, change?, classification?, reason? }`. A card that changed
 *     since `rev` or is no longer pending is 409; a change that would break the living spec is 422 with `issues`.
 *     Bodies over 128 KB are refused (413).
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { authorize } from '@core/infra/governed';
import { appBuilderDisabledResponse } from '@core/kernel/app-builder-flag';
import { decideProposal, type Decision } from '@tabs/software/lib/stories/proposals';
import { SpecValidationError } from '@tabs/software/lib/stories/store';
import type { Classification, SpecChange } from '@tabs/software/lib/app-builder-contracts';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 128 * 1024;

type Ctx = { params: Promise<{ id: string; pid: string }> };

const post = withRoute<{ id: string; pid: string }>(async ({ user, params, req }) => {
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return NextResponse.json({ error: `the request is larger than ${MAX_BODY_BYTES} bytes` }, { status: 413 });
  let body: { decision?: unknown; rev?: unknown; change?: unknown; classification?: unknown; reason?: unknown };
  try {
    body = JSON.parse(raw || '{}') as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || !['approve', 'edit', 'reject'].includes(String(body.decision))) {
    return NextResponse.json({ error: "decision must be 'approve', 'edit' or 'reject'" }, { status: 400 });
  }
  if (typeof body.rev !== 'string' || !body.rev) return NextResponse.json({ error: 'rev is required (the card version you decided on)' }, { status: 400 });
  const decision = await authorize(`user:${user.id}`, 'software_checks');
  if (!decision.allowed) return NextResponse.json({ error: `OPA refused deciding a requirement (${decision.policy})` }, { status: 403 });
  try {
    return NextResponse.json(
      await decideProposal(params.id, params.pid, user, body.decision as Decision, {
        rev: body.rev,
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        ...(body.change !== undefined ? { change: body.change as SpecChange } : {}),
        ...(typeof body.classification === 'string' ? { classification: body.classification as Classification } : {}),
        via: 'chat',
      }),
    );
  } catch (e) {
    if (e instanceof SpecValidationError) return NextResponse.json({ error: e.message, code: e.code, issues: e.issues }, { status: 422 });
    const issues = (e as { issues?: unknown }).issues;
    if (Array.isArray(issues)) return NextResponse.json({ error: (e as Error).message, code: 'spec_invalid', issues }, { status: 422 });
    throw e;
  }
}, { defaultStatus: 500 });

export async function POST(req: Request, ctx: Ctx) {
  return appBuilderDisabledResponse() ?? post(req, ctx);
}
