/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - workstream D MCP tools (Postgres per app, env and secrets, migrations)
 * USER STORY: As an MCP client I want every App Builder action of workstream D to have an MCP twin of its UI action,
 *             governed exactly like the UI.
 * ARCHITECTURE:
 *   - `dTools`: NEW tools, the twins of the Env and Database panels (`list_app_env`, `set_app_env`, `unset_app_env`,
 *     `get_app_database`, `create_app_database`). index.ts wraps each with the App Builder guard (flag off ⇒
 *     `app_builder_disabled` before anything else runs).
 *   - Same functions as the routes (`lib/appdb/*`): editor-only (`editableApp`), Prod writes need the go-live right
 *     (`assertEnvWrite`), every write first asks OPA (`authorize`, the creator-and-up software grant) and is audited by
 *     NAME. A value is never returned; the classifier/model never sees one (these tools take it as an argument and
 *     hand it straight to the Secret).
 *   - `dHandlers`: none. D changes no existing Platform MCP tool.
 */
import type { McpTool } from '@core/mcp/server';
import { authorize } from '@core/infra/governed';
import { record as recordAudit } from '@core/policy/audit';
import type { AppBuilderHandler } from '@tabs/software/mcp/app-builder/types';
import { assertEnvWrite, editableApp, parseEnv } from '@tabs/software/lib/appdb/access';
import { databaseRefusal, ensureAppDatabase, liveAppDbDeps, readAppDatabase } from '@tabs/software/lib/appdb/database';
import { listAppEnv, setAppEnv, unsetAppEnv } from '@tabs/software/lib/appdb/env-secrets';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const withStatus = (e: Error, status: number) => Object.assign(e, { status });

async function governed(userId: string, what: string) {
  const d = await authorize(`user:${userId}`, 'software_checks');
  if (!d.allowed) throw withStatus(new Error(`OPA refused ${what} (${d.policy}); nothing was changed`), 403);
  return d;
}

async function v2App(appId: unknown, user: Parameters<McpTool['call']>[0]) {
  const app = await editableApp(str(appId), user);
  const refusal = databaseRefusal(app, liveAppDbDeps().mode);
  if (refusal && refusal.status === 409) throw withStatus(new Error(refusal.reason), 409);
  return app;
}

const envArg = { type: 'string', enum: ['dev', 'prod'], description: 'dev or prod' } as const;

export const dTools: McpTool[] = [
  {
    name: 'list_app_env',
    description: 'List the env variables and secrets of an App Builder app in one env: name, kind (plain, secret, platform), who changed it and when. Values are never returned.',
    minRole: 'creator',
    tab: 'software',
    inputSchema: { type: 'object', properties: { appId: { type: 'string' }, env: envArg }, required: ['appId', 'env'], examples: [{ appId: 'app_ab12cd', env: 'dev' }] },
    call: async (user, args) => {
      const app = await v2App(args.appId, user);
      const env = parseEnv(args.env);
      return { appId: app.id, env, entries: await listAppEnv(app.domain, app.slug, env) };
    },
  },
  {
    name: 'set_app_env',
    description:
      'Set one env variable or secret of an App Builder app in dev or prod. The value is stored only in the app\'s Kubernetes Secret, is never shown again and never logged; the app sees it after the rollout this starts. Names: upper case, digits and _; PG*, OS_*, APP_* are the platform\'s. Prod needs the right to take the app live in Prod.',
    minRole: 'creator',
    tab: 'software',
    inputSchema: {
      type: 'object',
      properties: { appId: { type: 'string' }, env: envArg, name: { type: 'string' }, value: { type: 'string' }, secret: { type: 'boolean', description: 'true (default) = secret, false = plain variable' } },
      required: ['appId', 'env', 'name', 'value'],
      examples: [{ appId: 'app_ab12cd', env: 'dev', name: 'PAYMENT_API_KEY', value: '<the value>', secret: true }],
    },
    call: async (user, args) => {
      const app = await v2App(args.appId, user);
      const env = parseEnv(args.env);
      await assertEnvWrite(app, user, env);
      const d = await governed(user.id, 'setting an app env entry');
      const name = str(args.name);
      const r = await setAppEnv(app.domain, app.slug, env, user.id, { name, value: str(args.value), secret: args.secret !== false });
      recordAudit({ actor: user.id, action: 'deploy', subject: app.id, domain: app.domain, reason: `app env ${env}: set ${name}`, detail: { kind: 'app.env.set', env, name, secret: r.entry.kind === 'secret', via: 'mcp' }, decisionId: d.decisionId, policyRev: d.policyRev });
      return { appId: app.id, env, entry: r.entry, rolled: r.rolled };
    },
  },
  {
    name: 'unset_app_env',
    description: 'Remove one env variable or secret of an App Builder app in dev or prod (starts a rollout). Platform keys cannot be removed. Prod needs the right to take the app live in Prod.',
    minRole: 'creator',
    tab: 'software',
    inputSchema: { type: 'object', properties: { appId: { type: 'string' }, env: envArg, name: { type: 'string' } }, required: ['appId', 'env', 'name'], examples: [{ appId: 'app_ab12cd', env: 'prod', name: 'PAYMENT_API_KEY' }] },
    call: async (user, args) => {
      const app = await v2App(args.appId, user);
      const env = parseEnv(args.env);
      await assertEnvWrite(app, user, env);
      const d = await governed(user.id, 'removing an app env entry');
      const name = str(args.name);
      const r = await unsetAppEnv(app.domain, app.slug, env, user.id, name);
      recordAudit({ actor: user.id, action: 'deploy', subject: app.id, domain: app.domain, reason: `app env ${env}: removed ${name}`, detail: { kind: 'app.env.unset', env, name, via: 'mcp' }, decisionId: d.decisionId, policyRev: d.policyRev });
      return { appId: app.id, env, removed: r.removed, rolled: r.rolled };
    },
  },
  {
    name: 'get_app_database',
    description: 'The App Builder app\'s own Postgres database in one env: database and role name, the Secret that holds the credential (never the credential), isolation, migrations applied, backup state.',
    minRole: 'creator',
    tab: 'software',
    inputSchema: { type: 'object', properties: { appId: { type: 'string' }, env: envArg }, required: ['appId', 'env'], examples: [{ appId: 'app_ab12cd', env: 'prod' }] },
    call: async (user, args) => {
      const app = await v2App(args.appId, user);
      const env = parseEnv(args.env);
      return { appId: app.id, ...(await readAppDatabase(app, env)) };
    },
  },
  {
    name: 'create_app_database',
    description: 'Give an App Builder app its own Postgres database and role in dev (default) or prod: a random password in a Kubernetes Secret, no other app can connect. Idempotent. Prod is also created by the first Prod release.',
    minRole: 'creator',
    tab: 'software',
    inputSchema: { type: 'object', properties: { appId: { type: 'string' }, env: envArg }, required: ['appId'], examples: [{ appId: 'app_ab12cd' }, { appId: 'app_ab12cd', env: 'prod' }] },
    call: async (user, args) => {
      const app = await v2App(args.appId, user);
      const env = args.env === undefined ? 'dev' : parseEnv(args.env);
      await assertEnvWrite(app, user, env);
      const d = await governed(user.id, 'creating an app database');
      const view = await ensureAppDatabase(app, env);
      recordAudit({ actor: user.id, action: 'deploy', subject: app.id, domain: app.domain, reason: `app database ${env}: ensured ${view.record?.name ?? ''}`, detail: { kind: 'app.database.ensure', env, database: view.record?.name, via: 'mcp' }, decisionId: d.decisionId, policyRev: d.policyRev });
      return { appId: app.id, ...view };
    },
  },
];

export const dHandlers: Record<string, AppBuilderHandler> = {};
