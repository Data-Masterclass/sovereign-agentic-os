/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - workstream C2 MCP tools (releases, Dev/Prod deploy, previews, logs, rollback, needs-rebuild)
 * USER STORY: As an MCP client I want every App Builder action of workstream C2 to have an MCP twin of its UI action,
 *             governed exactly like the UI.
 * ARCHITECTURE:
 *   - `c2Tools`: NEW tools, the twins of the Code and runs view: reads `list_app_runs`, `get_app_run`,
 *     `list_app_releases`, `get_app_logs` (all listed in APP_BUILDER_READ_TOOL_NAMES and the kernel's READ_TOOLS);
 *     writes `rollback_app` (Prod: the go-live right of the app's scope) and `run_app_migration` (admin only, explicit).
 *     index.ts wraps each with the App Builder guard (flag off ⇒ `app_builder_disabled` before anything else runs).
 *   - Same functions as the routes (lib/releases/*, review.ts): the app's EDITORS only (`editableApp`: existence first,
 *     an invisible app is `not_found`), every write asks OPA (`authorize`) before its effect and is audited by the
 *     release flow. Logs are redacted and scoped to the app's own pods (logs.ts).
 *   - `c2Handlers` (v2 apps, switch on, via index.ts `routeToAppBuilder`): `start_preview` (Dev URL + slots, idle slots
 *     woken), `request_deploy` (go-live of the Dev release to Prod under the rule table), `decide_deploy` (when the client
 *     also names the app; review.ts routes a v2 card the same way without it), `get_software_status` (env URLs,
 *     releases, lights, needs-rebuild).
 */
import type { McpTool } from '@core/mcp/server';
import type { CurrentUser } from '@core/kernel/auth';
import { authorize } from '@core/infra/governed';
import type { AppBuilderHandler } from '@tabs/software/mcp/app-builder/types';
import { assertEnvWrite, editableApp, parseEnv } from '@tabs/software/lib/appdb/access';
import { recordFor } from '@tabs/software/lib/check-record';
import { decideDeploy, getReviewCard, isAppBuilderApp, requestProdGoLive, startPreview } from '@tabs/software/lib/review';
import { releasesView, runView } from '@tabs/software/lib/releases/view';
import { readAppLogs } from '@tabs/software/lib/releases/logs';
import { rollbackApp } from '@tabs/software/lib/releases/rollback';
import { runAppMigration } from '@tabs/software/lib/releases/needs-rebuild';
import { currentRelease } from '@tabs/software/lib/releases/store';
import { releaseUrl } from '@tabs/software/lib/releases/rollout';
import type { App } from '@tabs/software/lib/apps';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const withStatus = (e: Error, status: number) => Object.assign(e, { status });

async function governed(userId: string, what: string) {
  const d = await authorize(`user:${userId}`, 'software_checks');
  if (!d.allowed) throw withStatus(new Error(`OPA refused ${what} (${d.policy}); nothing was changed`), 403);
  return d;
}

/** The app (edit rights; invisible ⇒ 404) and it must be an App Builder app. */
async function v2App(appId: unknown, user: CurrentUser): Promise<App> {
  const app = await editableApp(str(appId), user);
  if (!isAppBuilderApp(app)) throw withStatus(new Error('only an App Builder app (nextjs-web@2) has releases, runs and app logs here'), 409);
  return app;
}

const envArg = { type: 'string', enum: ['dev', 'prod'], description: 'dev or prod' } as const;

export const c2Tools: McpTool[] = [
  {
    name: 'list_app_runs',
    description: 'The check runs of an App Builder app, newest first: commit, finished/running, green or not with the reason, every step (gates, tree scan, image build, push, image scan), the image digest, "change without a story", and per-criterion test counts.',
    minRole: 'creator',
    tab: 'software',
    inputSchema: { type: 'object', properties: { appId: { type: 'string' } }, required: ['appId'], examples: [{ appId: 'app_ab12cd' }] },
    call: async (user, args) => {
      const app = await v2App(args.appId, user);
      return { appId: app.id, runs: (app.checks ?? []).slice(0, 20).map(runView) };
    },
  },
  {
    name: 'get_app_run',
    description: 'One check run of an App Builder app by commit sha: the steps with their details (gate reports, scan results), the digest, criteria counts and whether it was released.',
    minRole: 'creator',
    tab: 'software',
    inputSchema: { type: 'object', properties: { appId: { type: 'string' }, sha: { type: 'string', description: 'the full commit sha' } }, required: ['appId', 'sha'], examples: [{ appId: 'app_ab12cd', sha: '0123456789abcdef0123456789abcdef01234567' }] },
    call: async (user, args) => {
      const app = await v2App(args.appId, user);
      const rec = recordFor(app.checks, str(args.sha));
      if (!rec) throw withStatus(new Error(`no run is recorded for ${str(args.sha).slice(0, 12)}`), 404);
      const released = (app.releases ?? []).filter((r) => r.sha === rec.sha).map((r) => ({ id: r.id, env: r.env, slot: r.slot ?? null, state: r.state }));
      return { appId: app.id, ...runView(rec), checks: rec.checks.map((c) => ({ id: c.id, status: c.status, detail: c.detail.slice(0, 1500) })), released };
    },
  },
  {
    name: 'list_app_releases',
    description: 'The releases of an App Builder app in one env (dev default): what serves now (sha, digest, URL), every release with its state and migrations, the two preview slots (Dev), whether Dev can go live in Prod and who must review, the rollback target, and whether a builder is configured.',
    minRole: 'creator',
    tab: 'software',
    inputSchema: { type: 'object', properties: { appId: { type: 'string' }, env: envArg }, required: ['appId'], examples: [{ appId: 'app_ab12cd' }, { appId: 'app_ab12cd', env: 'prod' }] },
    call: async (user, args) => {
      const app = await v2App(args.appId, user);
      return releasesView(app, user, args.env === undefined ? 'dev' : parseEnv(args.env));
    },
  },
  {
    name: 'get_app_logs',
    description: "The App Builder app's own logs in dev or prod (or a Dev preview slot p1/p2), newest pod first, with secrets and tokens redacted. Only the app's editors may read them; never another app's.",
    minRole: 'creator',
    tab: 'software',
    inputSchema: {
      type: 'object',
      properties: { appId: { type: 'string' }, env: envArg, preview: { type: 'string', enum: ['p1', 'p2'], description: 'a Dev preview slot' }, tail: { type: 'number', description: 'lines per pod, 1-1000 (default 200)' } },
      required: ['appId', 'env'],
      examples: [{ appId: 'app_ab12cd', env: 'dev', tail: 100 }, { appId: 'app_ab12cd', env: 'dev', preview: 'p1' }],
    },
    call: async (user, args) => {
      const app = await v2App(args.appId, user);
      const slot = args.preview === undefined ? undefined : args.preview === 'p1' || args.preview === 'p2' ? args.preview : (() => { throw withStatus(new Error('preview must be "p1" or "p2"'), 400); })();
      return { appId: app.id, ...(await readAppLogs(app, { env: parseEnv(args.env), slot, tail: Number(args.tail ?? 200) })) };
    },
  },
  {
    name: 'rollback_app',
    description: 'Roll an App Builder app back to its previous release in dev or prod (the previous digest; nothing is rebuilt; no migration runs and every applied migration stays). Prod needs the right to take the app live in Prod. Returns the migrations applied since, with the forward-only warning.',
    minRole: 'creator',
    tab: 'software',
    inputSchema: { type: 'object', properties: { appId: { type: 'string' }, env: envArg }, required: ['appId', 'env'], examples: [{ appId: 'app_ab12cd', env: 'prod' }] },
    call: async (user, args) => {
      const app = await v2App(args.appId, user);
      const env = parseEnv(args.env);
      await assertEnvWrite(app, user, env);
      await governed(user.id, 'the rollback');
      const r = await rollbackApp(app, env, { id: user.id, name: user.name });
      if (!r.ok) throw withStatus(new Error(r.reason), r.status);
      return { appId: app.id, env, release: r.rollout.release, url: r.rollout.url, migrationsSince: r.plan.migrationsSince, warning: r.plan.warning };
    },
  },
  {
    name: 'run_app_migration',
    description: 'Admin only, explicit: scale the legacy Deployment of an app marked "needs rebuild" (its image points at a registry that no longer exists) to 0 in the legacy app namespace, or back to 1 with undo. Recorded in the audit log; never automatic.',
    minRole: 'admin',
    tab: 'software',
    inputSchema: { type: 'object', properties: { appId: { type: 'string' }, undo: { type: 'boolean', description: 'scale back to 1' } }, required: ['appId'], examples: [{ appId: 'app_ab12cd' }, { appId: 'app_ab12cd', undo: true }] },
    call: async (user, args) => {
      const { getAppForUser } = await import('@tabs/software/lib/apps');
      const app = await getAppForUser(str(args.appId), user);
      await governed(user.id, 'the app migration');
      return runAppMigration(app, user, { undo: args.undo === true });
    },
  },
];

/** get_software_status for a v2 app: env URLs, what runs where, lights, needs-rebuild. */
const softwareStatus: AppBuilderHandler = async (user, _args, app) => {
  const dev = await releasesView(app, user, 'dev');
  const prod = currentRelease(app, 'prod');
  return {
    appId: app.id,
    name: app.name,
    templateVersion: 2,
    state: app.deploy.state,
    builder: dev.builder,
    urls: dev.urls,
    dev: dev.current,
    prod: prod ? { ...prod, url: releaseUrl(app, 'prod') } : null,
    previews: dev.previews.map((p) => ({ slot: p.slot, sha: p.sha, url: p.url, phase: p.status?.phase ?? null })),
    lights: app.stories?.lights ?? null,
    goLive: dev.goLive,
    needsRebuild: dev.needsRebuild,
    latestRun: dev.runs[0] ?? null,
  };
};

export const c2Handlers: Record<string, AppBuilderHandler> = {
  start_preview: async (user, _args, app) => {
    const r = await startPreview(app.id, user);
    const dev = currentRelease(r.app, 'dev');
    return { appId: app.id, devUrl: dev ? releaseUrl(app, 'dev') : null, previews: (await releasesView(r.app, user, 'dev')).previews.map((p) => ({ slot: p.slot, sha: p.sha, url: p.url })), runnerNote: r.runnerNote };
  },
  request_deploy: async (user, args, app) => {
    const r = await requestProdGoLive(app, user, { releaseId: typeof args.releaseId === 'string' ? args.releaseId : undefined });
    return r.kind === 'review'
      ? { kind: 'review', appId: app.id, cardId: r.card.id, approval: r.approval, note: 'Waiting for an eligible reviewer (Platform go-live rules); you cannot approve your own go-live.' }
      : { kind: 'auto-deployed', appId: app.id, prodUrl: releaseUrl(app, 'prod'), release: currentRelease(r.app, 'prod') };
  },
  decide_deploy: async (user, args, app) => {
    const card = await getReviewCard(str(args.cardId));
    if (!card || card.appId !== app.id) throw withStatus(new Error('no such go-live request for this app'), 404);
    const r = await decideDeploy(card.id, user, str(args.decision) === 'approve' ? 'approve' : 'deny', str(args.note) || undefined);
    return { appId: app.id, decision: r.card.decision, state: r.app.deploy.state, prodUrl: currentRelease(r.app, 'prod') ? releaseUrl(app, 'prod') : null };
  },
  get_software_status: softwareStatus,
};
