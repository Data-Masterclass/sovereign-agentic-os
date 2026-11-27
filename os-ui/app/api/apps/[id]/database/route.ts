/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    App Builder (D) - the Database panel's door: an app's own Postgres database per env
 * USER STORY: As an app builder I see my app's database (names, isolation, migrations, backup state) and create it with
 *             one click; I never see a password.
 * ARCHITECTURE: A SHELL over `lib/appdb/database.ts`, the same functions as the MCP tools `get_app_database` /
 *               `create_app_database`. `app_builder_disabled` first; editors only; creating Prod needs the go-live right;
 *               POST asks OPA (`authorize`) before the effect and is audited. GET ?env=dev|prod; POST { env? } (dev default).
 */
import { NextResponse } from 'next/server';
import { appBuilderDisabledResponse } from '@core/kernel/app-builder-flag';
import { withRoute } from '@core/kernel/route-server';
import { authorize } from '@core/infra/governed';
import { record as recordAudit } from '@core/policy/audit';
import { assertEnvWrite, editableApp, parseEnv } from '@tabs/software/lib/appdb/access';
import { ensureAppDatabase, readAppDatabase } from '@tabs/software/lib/appdb/database';

export const dynamic = 'force-dynamic';

const read = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const env = parseEnv(new URL(req.url).searchParams.get('env'));
  const app = await editableApp(params.id, user);
  return NextResponse.json(await readAppDatabase(app, env));
}, { defaultStatus: 500 });

const create = withRoute<{ id: string }, { env?: unknown }>(async ({ user, params, body }) => {
  const env = body?.env === undefined ? 'dev' : parseEnv(body.env);
  const app = await editableApp(params.id, user);
  await assertEnvWrite(app, user, env);
  const d = await authorize(`user:${user.id}`, 'software_checks');
  if (!d.allowed) return NextResponse.json({ error: `OPA refused creating the database (${d.policy}); nothing was changed` }, { status: 403 });
  const view = await ensureAppDatabase(app, env);
  recordAudit({ actor: user.id, action: 'deploy', subject: app.id, domain: app.domain, reason: `app database ${env}: ensured ${view.record?.name ?? ''}`, detail: { kind: 'app.database.ensure', env, database: view.record?.name, via: 'ui' }, decisionId: d.decisionId, policyRev: d.policyRev });
  return NextResponse.json(view);
}, { defaultStatus: 500, parse: true });

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return appBuilderDisabledResponse() ?? read(req, ctx);
}
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return appBuilderDisabledResponse() ?? create(req, ctx);
}
