/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder B - the Chat view's door: a typed requirement becomes a diff card
 * USER STORY: As a business user I want what I type in the App Builder chat to come back as a proposed story change I
 *             can approve, edit or reject, and nothing in git, code or tests to change before I approve it.
 * ARCHITECTURE:
 *   - Thin shell over `proposeRequirement` (tabs/software/lib/stories/proposals.ts), the same function
 *     `propose_requirement` calls. The App Builder guard runs FIRST (flag off ⇒ 403 `app_builder_disabled`).
 *   - POST `{ text, prefer? }`: OPA `authorize()` (`software_checks`) before the model call, then the app's visibility.
 *     Bodies over 16 KB are refused (413); the text is data for the classifier, never an instruction.
 *     `classifier_unavailable` / `classifier_invalid_output` are 503 with their code (the card says so; no guess).
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { authorize } from '@core/infra/governed';
import { appBuilderDisabledResponse } from '@core/kernel/app-builder-flag';
import { proposeRequirement } from '@tabs/software/lib/stories/proposals';
import { ClassifierUnavailable } from '@tabs/software/lib/stories/classify';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16 * 1024;

type Ctx = { params: Promise<{ id: string }> };

const post = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return NextResponse.json({ error: `the request is larger than ${MAX_BODY_BYTES} bytes` }, { status: 413 });
  let body: { text?: unknown; prefer?: unknown };
  try {
    body = JSON.parse(raw || '{}') as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || typeof body.text !== 'string' || !body.text.trim()) return NextResponse.json({ error: 'text is required' }, { status: 400 });
  if (body.prefer !== undefined && typeof body.prefer !== 'string') return NextResponse.json({ error: 'prefer must be a classification' }, { status: 400 });
  const decision = await authorize(`user:${user.id}`, 'software_checks');
  if (!decision.allowed) return NextResponse.json({ error: `OPA refused proposing a requirement (${decision.policy})` }, { status: 403 });
  try {
    return NextResponse.json(await proposeRequirement(user, params.id, { text: body.text, source: 'chat', ...(body.prefer ? { prefer: body.prefer as string } : {}) }));
  } catch (e) {
    if (e instanceof ClassifierUnavailable) return NextResponse.json({ error: e.message, code: e.code }, { status: 503 });
    throw e;
  }
}, { defaultStatus: 500 });

export async function POST(req: Request, ctx: Ctx) {
  return appBuilderDisabledResponse() ?? post(req, ctx);
}
