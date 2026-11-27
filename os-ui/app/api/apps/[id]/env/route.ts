/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    App Builder (D) - the Env panel's door: an app's env variables and secrets per env (write-only)
 * USER STORY: As an app builder I list, set and remove my app's env and secrets in Dev or Prod; a value is never shown
 *             again.
 * ARCHITECTURE: A SHELL over `lib/appdb/env-secrets.ts`, the same functions as the MCP tools `list_app_env` /
 *               `set_app_env` / `unset_app_env`. `app_builder_disabled` first; editors only (`editableApp`); Prod writes
 *               need the go-live right (`assertEnvWrite`); every write asks OPA (`authorize`) before the effect and is
 *               audited by NAME. GET ?env=dev|prod; PUT { env, name, value, secret }; DELETE ?env=…&name=….
 */
import { NextResponse } from 'next/server';
import { appBuilderDisabledResponse } from '@core/kernel/app-builder-flag';
import { withRoute } from '@core/kernel/route-server';
import { authorize } from '@core/infra/governed';
import { record as recordAudit } from '@core/policy/audit';
import { assertEnvWrite, editableApp, parseEnv } from '@tabs/software/lib/appdb/access';
import { databaseRefusal, liveAppDbDeps } from '@tabs/software/lib/appdb/database';
import { listAppEnv, setAppEnv, unsetAppEnv } from '@tabs/software/lib/appdb/env-secrets';

export const dynamic = 'force-dynamic';

async function v2App(id: string, user: Parameters<typeof editableApp>[1]) {
  const app = await editableApp(id, user);
  const refusal = databaseRefusal(app, liveAppDbDeps().mode);
  if (refusal && refusal.status === 409) throw Object.assign(new Error(refusal.reason), { status: 409 });
  return app;
}

const list = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const env = parseEnv(new URL(req.url).searchParams.get('env'));
  const app = await v2App(params.id, user);
  return NextResponse.json({ env, entries: await listAppEnv(app.domain, app.slug, env) });
}, { defaultStatus: 500 });

const put = withRoute<{ id: string }, { env?: unknown; name?: unknown; value?: unknown; secret?: unknown }>(async ({ user, params, body }) => {
  const env = parseEnv(body?.env);
  const app = await v2App(params.id, user);
  await assertEnvWrite(app, user, env);
  const d = await authorize(`user:${user.id}`, 'software_checks');
  if (!d.allowed) return NextResponse.json({ error: `OPA refused this change (${d.policy}); nothing was changed` }, { status: 403 });
  const name = typeof body?.name === 'string' ? body.name : '';
  const r = await setAppEnv(app.domain, app.slug, env, user.id, { name, value: typeof body?.value === 'string' ? body.value : '', secret: body?.secret !== false });
  recordAudit({ actor: user.id, action: 'deploy', subject: app.id, domain: app.domain, reason: `app env ${env}: set ${name}`, detail: { kind: 'app.env.set', env, name, secret: r.entry.kind === 'secret', via: 'ui' }, decisionId: d.decisionId, policyRev: d.policyRev });
  return NextResponse.json({ env, entry: r.entry, rolled: r.rolled });
}, { defaultStatus: 500, parse: true, invalidJsonStatus: 400 });

const del = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const q = new URL(req.url).searchParams;
  const env = parseEnv(q.get('env'));
  const app = await v2App(params.id, user);
  await assertEnvWrite(app, user, env);
  const d = await authorize(`user:${user.id}`, 'software_checks');
  if (!d.allowed) return NextResponse.json({ error: `OPA refused this change (${d.policy}); nothing was changed` }, { status: 403 });
  const name = q.get('name') ?? '';
  const r = await unsetAppEnv(app.domain, app.slug, env, user.id, name);
  recordAudit({ actor: user.id, action: 'deploy', subject: app.id, domain: app.domain, reason: `app env ${env}: removed ${name}`, detail: { kind: 'app.env.unset', env, name, via: 'ui' }, decisionId: d.decisionId, policyRev: d.policyRev });
  return NextResponse.json({ env, removed: r.removed, rolled: r.rolled });
}, { defaultStatus: 500 });

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return appBuilderDisabledResponse() ?? list(req, ctx);
}
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return appBuilderDisabledResponse() ?? put(req, ctx);
}
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return appBuilderDisabledResponse() ?? del(req, ctx);
}
