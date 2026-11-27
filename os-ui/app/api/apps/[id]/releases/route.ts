/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    App Builder (C2) - the Code and runs view's door: runs, releases per env, previews, go-live to Prod
 * USER STORY: As an app builder I see which commit runs where and take a Dev release live in Prod under the go-live rules.
 * ARCHITECTURE: A SHELL over `lib/releases/view.ts` and review.ts (the same functions as the MCP tools
 *               `list_app_releases` / `list_app_runs` and `request_deploy` / `decide_deploy`). `app_builder_disabled`
 *               first; the app's editors only (`editableApp`, fail closed; an app token is refused). POST asks OPA
 *               (`authorize`) before the effect; the go-live path audits its decision.
 *               GET ?env=dev|prod; POST { action: 'go-live', releaseId? } | { action: 'decide', cardId, decision, note? }
 *               | { action: 'dismiss-posthoc', proposalId, reason } (admin only, audited).
 */
import { NextResponse } from 'next/server';
import { appBuilderDisabledResponse } from '@core/kernel/app-builder-flag';
import { withRoute } from '@core/kernel/route-server';
import { authorize } from '@core/infra/governed';
import { editableApp, parseEnv } from '@tabs/software/lib/appdb/access';
import { releasesView } from '@tabs/software/lib/releases/view';
import { dismissRejectedPosthoc } from '@tabs/software/lib/releases/dismiss';
import { decideDeploy, getReviewCard, isAppBuilderApp, requestProdGoLive } from '@tabs/software/lib/review';

export const dynamic = 'force-dynamic';

const notV2 = () => Object.assign(new Error('only an App Builder app (nextjs-web@2) has releases'), { status: 409 });

const read = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const env = parseEnv(new URL(req.url).searchParams.get('env') ?? 'dev');
  const app = await editableApp(params.id, user);
  if (!isAppBuilderApp(app)) throw notV2();
  return NextResponse.json(await releasesView(app, user, env));
}, { defaultStatus: 500 });

type Body = { action?: unknown; releaseId?: unknown; cardId?: unknown; decision?: unknown; note?: unknown; proposalId?: unknown; reason?: unknown };

const act = withRoute<{ id: string }, Body>(async ({ user, params, body }) => {
  const app = await editableApp(params.id, user);
  if (!isAppBuilderApp(app)) throw notV2();
  const d = await authorize(`user:${user.id}`, 'software_checks');
  if (!d.allowed) return NextResponse.json({ error: `OPA refused the release action (${d.policy}); nothing was changed` }, { status: 403 });
  if (body?.action === 'go-live') {
    const r = await requestProdGoLive(app, user, { releaseId: typeof body.releaseId === 'string' ? body.releaseId : undefined });
    return NextResponse.json(r.kind === 'review' ? { kind: r.kind, cardId: r.card.id, approval: r.approval } : { kind: r.kind });
  }
  if (body?.action === 'decide') {
    const decision = body.decision === 'approve' ? 'approve' : body.decision === 'deny' ? 'deny' : null;
    if (!decision || typeof body.cardId !== 'string') return NextResponse.json({ error: 'decide needs cardId and decision approve|deny' }, { status: 400 });
    const card = await getReviewCard(body.cardId);
    if (!card || card.appId !== app.id) return NextResponse.json({ error: 'no such go-live request for this app' }, { status: 404 });
    const r = await decideDeploy(body.cardId, user, decision, typeof body.note === 'string' ? body.note.slice(0, 500) : undefined);
    return NextResponse.json({ decision: r.card.decision, state: r.app.deploy.state });
  }
  if (body?.action === 'dismiss-posthoc') {
    // Admin only (checked inside), audited with the reason: a rejected post-hoc card whose change was already undone.
    const r = await dismissRejectedPosthoc(app.id, typeof body.proposalId === 'string' ? body.proposalId : '', user, typeof body.reason === 'string' ? body.reason.slice(0, 500) : '');
    return NextResponse.json(r);
  }
  return NextResponse.json({ error: "action must be 'go-live', 'decide' or 'dismiss-posthoc'" }, { status: 400 });
}, { defaultStatus: 500, parse: true });

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return appBuilderDisabledResponse() ?? read(req, ctx);
}
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return appBuilderDisabledResponse() ?? act(req, ctx);
}
