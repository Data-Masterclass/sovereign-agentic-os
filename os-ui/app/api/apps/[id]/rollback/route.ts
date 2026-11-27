/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    App Builder (C2) - roll Dev or Prod back to the previous release
 * USER STORY: As an app owner I see what a rollback does (target release, migrations that stay applied) and confirm it.
 * ARCHITECTURE: A SHELL over `lib/releases/rollback.ts` (the same function as the MCP tool `rollback_app`).
 *               `app_builder_disabled` first; editors only; Prod needs the go-live right of the app's scope (the same check
 *               as changing Prod env, spec 9). POST asks OPA (`authorize`) before the effect and is audited (rollout.ts).
 *               GET ?env=dev|prod → the plan (or null); POST { env } → the rollback.
 */
import { NextResponse } from 'next/server';
import { appBuilderDisabledResponse } from '@core/kernel/app-builder-flag';
import { withRoute } from '@core/kernel/route-server';
import { authorize } from '@core/infra/governed';
import { assertEnvWrite, editableApp, parseEnv } from '@tabs/software/lib/appdb/access';
import { isAppBuilderApp } from '@tabs/software/lib/review';
import { rollbackApp, rollbackPlan } from '@tabs/software/lib/releases/rollback';

export const dynamic = 'force-dynamic';

const plan = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const env = parseEnv(new URL(req.url).searchParams.get('env'));
  const app = await editableApp(params.id, user);
  if (!isAppBuilderApp(app)) return NextResponse.json({ error: 'only an App Builder app (nextjs-web@2) has releases' }, { status: 409 });
  return NextResponse.json({ env, plan: rollbackPlan(app, env) });
}, { defaultStatus: 500 });

const run = withRoute<{ id: string }, { env?: unknown }>(async ({ user, params, body }) => {
  const env = parseEnv(body?.env);
  const app = await editableApp(params.id, user);
  if (!isAppBuilderApp(app)) return NextResponse.json({ error: 'only an App Builder app (nextjs-web@2) has releases' }, { status: 409 });
  await assertEnvWrite(app, user, env);
  const d = await authorize(`user:${user.id}`, 'software_checks');
  if (!d.allowed) return NextResponse.json({ error: `OPA refused the rollback (${d.policy}); nothing was changed` }, { status: 403 });
  const r = await rollbackApp(app, env, { id: user.id, name: user.name });
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.status });
  return NextResponse.json({ env, release: r.rollout.release, url: r.rollout.url, migrationsSince: r.plan.migrationsSince, warning: r.plan.warning });
}, { defaultStatus: 500, parse: true });

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return appBuilderDisabledResponse() ?? plan(req, ctx);
}
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return appBuilderDisabledResponse() ?? run(req, ctx);
}
