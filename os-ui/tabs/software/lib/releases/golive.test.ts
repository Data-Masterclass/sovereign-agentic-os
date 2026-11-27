/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (C2) - going live in Prod under the Platform go-live rule table, through the real doors
 *             (request_deploy / decide_deploy = review.ts), and the switch-off answers of every C2 door
 * USER STORY: As the owner I want My go-live without review, Domain go-live only after a domain admin (never myself)
 *             approved, an admin able to stand in, unreviewed pushes blocking Domain, and Prod refusing a digest that
 *             is not a Dev release — and nothing of it while the App Builder is off.
 * ARCHITECTURE: real app store + review cards + Governance queue; git, registry and cluster replaced by the rollout
 *               test seam (`__setRolloutDepsForTests`), so the rule table, the gates and the state are the real code.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CurrentUser } from '@core/kernel/auth';
import { testUser } from '@core/testing/user';
import { config as cfg } from '@core/kernel/config';
import { createApp, persistApp, getAppByIdInternal, type App } from '@tabs/software/lib/apps';
import type { AppRelease } from '@tabs/software/lib/app-builder-contracts';
import { REQUIRED_GATES } from '@tabs/software/lib/gates';
import { decideDeploy, requestDeploy } from '@tabs/software/lib/review';
import { appDeployFiles } from '@tabs/software/lib/native-deploy';
import { __setRolloutDepsForTests } from './rollout.ts';
import { appEnvHost } from './overlay.ts';
import { currentRelease } from './store.ts';
import { c2Tools } from '@tabs/software/mcp/app-builder/c2-tools';
import { guardAppBuilderTool } from '@tabs/software/mcp/app-builder/index';
import { __setGoLiveRulesMirror, type GoLiveRulesMirror } from '@core/policy/go-live-rules-store';

/** The rule store with nothing saved: the defaults of spec 9 (My: none, Domain: domain_admin, Company: admin). */
const emptyRules: GoLiveRulesMirror = { probe: async () => true, read: async () => ({ state: 'absent' }), writeConfirmed: async () => ({ ok: true }) };

const D1 = `sha256:${'1'.repeat(64)}`;
const SHA = 'c'.repeat(40);
let reposDir = '';
let priorRepos = '';
const applied: string[] = [];
/** H: every `live/app/<id>` move the rollout asked for (app id, release env, sha). */
const pinned: { appId: string; env: string; sha: string; releaseId: string }[] = [];

before(() => {
  __setGoLiveRulesMirror(emptyRules);
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-c2-'));
  priorRepos = cfg.reposDir;
  (cfg as { reposDir: string }).reposDir = reposDir;
  __setRolloutDepsForTests({
    registry: 'zot.platform.svc:5000',
    pullRegistry: 'registry.example',
    appsDomain: 'apps.example',
    ingressClass: 'nginx',
    tlsIssuer: 'le',
    readTree: async (app) => ({ kind: 'tree', sha: SHA, files: appDeployFiles({ slug: app.slug, host: appEnvHost(app.domain, app.slug, 'prod', 'apps.example')!, registry: 'zot.platform.svc:5000', ingressClass: 'nginx', tlsIssuer: 'le', domain: app.domain, templateVersion: 2 }) }),
    digestExists: async () => ({ ok: true, value: true, at: '' }),
    runHooks: async () => ({ ok: true, applied: [] }),
    apply: async (objs, ns) => (applied.push(ns), { ok: true, applied: objs.map((o) => String(o.kind)) }),
    commitFile: async () => ({ ok: true, recorded: false }),
    audit: () => undefined,
    pinLive: async (app, release) => (pinned.push({ appId: app.id, env: release.env, sha: release.sha, releaseId: release.id }), { ok: true, tag: `live/app/${app.id}` }),
  });
});
after(() => {
  __setGoLiveRulesMirror(null);
  __setRolloutDepsForTests(null);
  (cfg as { reposDir: string }).reposDir = priorRepos;
  rmSync(reposDir, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env.SOFTWARE_APP_BUILDER;
});
const on = () => {
  process.env.SOFTWARE_APP_BUILDER = 'on';
};

const alice: CurrentUser = testUser({ id: 'alice', domains: ['sales'], role: 'creator' });
const carol: CurrentUser = testUser({ id: 'carol', domains: ['sales'], role: 'creator' });
const dana: CurrentUser = testUser({ id: 'dana', domains: ['sales'], role: 'domain_admin' });
const otherAdmin: CurrentUser = testUser({ id: 'hana', domains: ['hr'], role: 'domain_admin' });
const root: CurrentUser = testUser({ id: 'root', domains: ['hr'], role: 'admin' });

const greenChecks = () => [...REQUIRED_GATES.map((id) => ({ id, status: 'pass' as const, detail: 'ok' })), { id: 'scan', status: 'pass' as const, detail: 'ok' }, { id: 'scan-image', status: 'pass' as const, detail: 'ok' }];

async function v2WithDevRelease(name: string, visibility: App['visibility'] = 'Personal', over: Partial<AppRelease> = {}): Promise<App> {
  on();
  const app = await createApp(alice, { name, template: 'nextjs-web', templateVersion: 2 });
  app.visibility = visibility;
  app.checks = [{ sha: SHA, status: 'finished', trigger: 'push', engine: 'tekton', runRef: 'chk', startedAt: '1', finishedAt: '2', error: null, digest: D1, checks: greenChecks() }];
  app.releases = [{ id: 'rdev1', slug: app.slug, env: 'dev', sha: SHA, digest: D1, at: '2026-11-27T00:00:00Z', by: 'auto-dev', previous: null, migrations: { applied: [], status: 'none' }, state: 'running', ...over }];
  await persistApp(app);
  return app;
}

async function rejectsWith(p: Promise<unknown>, status: number, re?: RegExp) {
  await assert.rejects(p, (e: Error & { status?: number }) => {
    assert.equal(e.status, status, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
}

test('My scope: the owner takes the Dev release live in Prod alone (reviewer none); the same digest, nothing rebuilt', async () => {
  const app = await v2WithDevRelease('C2 Mine');
  const r = await requestDeploy(app.id, alice);
  assert.equal(r.kind, 'auto-deployed');
  const after = (await getAppByIdInternal(app.id))!;
  const prod = currentRelease(after, 'prod')!;
  assert.equal(prod.digest, D1);
  assert.equal(prod.sha, SHA);
  assert.equal(after.deploy.state, 'live');
  assert.ok(applied.includes('apps-prod'));
});

test('Domain scope: a review card; the requester cannot approve, a creator cannot, a domain admin of ANOTHER domain cannot; the domain admin can', async () => {
  const app = await v2WithDevRelease('C2 Shared', 'Shared');
  const r = await requestDeploy(app.id, alice);
  assert.equal(r.kind, 'review');
  if (r.kind !== 'review') return;
  assert.equal(r.approval.approverRole, 'domain_admin');
  await rejectsWith(decideDeploy(r.card.id, alice, 'approve'), 403, /cannot decide/);
  await rejectsWith(decideDeploy(r.card.id, carol, 'approve'), 403);
  await rejectsWith(decideDeploy(r.card.id, otherAdmin, 'approve'), 403);
  assert.equal(currentRelease((await getAppByIdInternal(app.id))!, 'prod'), null, 'nothing went live');
  const d = await decideDeploy(r.card.id, dana, 'approve');
  assert.equal(d.card.decision, 'approved');
  assert.equal(currentRelease((await getAppByIdInternal(app.id))!, 'prod')?.digest, D1);
});

test('an admin satisfies a domain_admin row in any domain; the requester may withdraw their own request', async () => {
  const a = await v2WithDevRelease('C2 Admin', 'Shared');
  const r = await requestDeploy(a.id, alice);
  assert.equal(r.kind, 'review');
  if (r.kind === 'review') assert.equal((await decideDeploy(r.card.id, root, 'approve')).card.decision, 'approved');
  const b = await v2WithDevRelease('C2 Withdraw', 'Shared');
  const w = await requestDeploy(b.id, alice);
  if (w.kind === 'review') assert.equal((await decideDeploy(w.card.id, alice, 'deny')).card.decision, 'denied');
});

test('unreviewed pushed changes block a Domain go-live (not My); Prod refuses a release that is not a running Dev release of a green, scanned build', async () => {
  const shared = await v2WithDevRelease('C2 Unreviewed', 'Shared');
  shared.unreviewed = ['prop_1'];
  await persistApp(shared);
  await rejectsWith(requestDeploy(shared.id, alice), 409, /unreviewed changes/);
  const mine = await v2WithDevRelease('C2 Unreviewed Mine');
  mine.unreviewed = ['prop_1'];
  await persistApp(mine);
  assert.equal((await requestDeploy(mine.id, alice)).kind, 'auto-deployed');
  const wrongDigest = await v2WithDevRelease('C2 Digest', 'Personal', { digest: `sha256:${'9'.repeat(64)}` });
  await rejectsWith(requestDeploy(wrongDigest.id, alice), 422, /refuses/);
  const failed = await v2WithDevRelease('C2 Failed', 'Personal', { state: 'failed' });
  await rejectsWith(requestDeploy(failed.id, alice), 422, /no running Dev release/);
});

test('switch off: every C2 MCP tool answers app_builder_disabled before reading anything', async () => {
  process.env.SOFTWARE_APP_BUILDER = 'off';
  for (const t of c2Tools.map(guardAppBuilderTool)) {
    await assert.rejects(t.call(alice, { appId: 'app_nope', env: 'dev', sha: SHA }), (e: Error & { code?: string }) => e.code === 'app_builder_disabled', t.name);
  }
});

test('switch off: the releases, logs and rollback routes answer 403 app_builder_disabled', async () => {
  process.env.SOFTWARE_APP_BUILDER = 'off';
  const ctx = { params: Promise.resolve({ id: 'app_x' }) };
  for (const [route, methods] of [['releases', ['GET', 'POST']], ['logs', ['GET']], ['rollback', ['GET', 'POST']]] as const) {
    const mod = (await import(`../../../../app/api/apps/[id]/${route}/route.ts`)) as Record<string, (req: Request, c: typeof ctx) => Promise<Response>>;
    for (const m of methods) {
      const res = await mod[m](new Request(`http://x/api/apps/app_x/${route}?env=dev`, { method: m, ...(m === 'POST' ? { body: '{}' } : {}) }), ctx);
      assert.equal(res.status, 403, `${m} ${route}`);
      assert.equal(((await res.json()) as { code?: string }).code, 'app_builder_disabled');
    }
  }
});

test('two approvals of one go-live at once: exactly one rolls out, the other is refused', async () => {
  const app = await v2WithDevRelease('C2 Race', 'Shared');
  const r = await requestDeploy(app.id, alice);
  assert.equal(r.kind, 'review');
  if (r.kind !== 'review') return;
  const before = applied.filter((n) => n === 'apps-prod').length;
  const out = await Promise.allSettled([decideDeploy(r.card.id, dana, 'approve'), decideDeploy(r.card.id, root, 'approve')]);
  assert.equal(out.filter((o) => o.status === 'fulfilled').length, 1);
  assert.equal(out.filter((o) => o.status === 'rejected' && (o.reason as { status?: number }).status === 409).length, 1);
  assert.equal(applied.filter((n) => n === 'apps-prod').length - before, 1, 'one Prod rollout');
});

test('owner decision: an agent run may not roll back Prod (refused); its Dev rollback is held for a person', async () => {
  on();
  const { runWithRunId } = await import('@core/infra/request-surface');
  const app = await v2WithDevRelease('C2 Agent Rollback');
  const tool = c2Tools.find((t) => t.name === 'rollback_app')!;
  await assert.rejects(runWithRunId('run_1', () => tool.call(alice, { appId: app.id, env: 'prod' })), (e: Error & { status?: number }) => e.status === 403 && /agent run may not roll back Prod/.test(e.message));
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('../../../agents/lib/build/hold.ts', import.meta.url), 'utf8'), /ALWAYS_CONFIRMED_TOOLS = new Set\(\[[^\]]*'rollback_app'/s);
});

test('agent doors: rollback_app is refused on Prod (or no / unknown env) before any hold, Dev passes to the hold', async () => {
  const { agentForbiddenCallReason } = await import('@core/mcp/write-tool-meta');
  for (const args of [{ env: 'prod' }, {}, { env: 'PROD' }, { env: 1 }]) assert.match(agentForbiddenCallReason('rollback_app', args) ?? '', /nor roll Prod back/, JSON.stringify(args));
  assert.equal(agentForbiddenCallReason('rollback_app', { env: 'dev' }), null);
});

test('an admin dismisses a REJECTED post-hoc card (reason required, audited); nobody else, and never a pending card', async () => {
  const { dismissRejectedPosthoc } = await import('./dismiss.ts');
  const admin = testUser({ id: 'ada', domains: ['sales'], role: 'admin' });
  const app = await v2WithDevRelease('C2 Dismiss', 'Shared');
  const card = (id: string, status: 'pending' | 'rejected') => ({ id, appId: app.id, classification: 'code-change' as const, rationale: 'r', confidence: 1, alternatives: [], change: { writes: [], deletes: [], summary: 's' }, source: 'git' as const, posthoc: true, commitShas: [SHA], requestedBy: 'alice', status, createdAt: '2026-11-27T00:00:00Z' });
  app.proposals = [card('prop_rej', 'rejected'), card('prop_pen', 'pending')];
  app.unreviewed = ['prop_rej', 'prop_pen'];
  await persistApp(app);
  const why = 'reverted by an OS commit that restored the agreed story text';
  await rejectsWith(dismissRejectedPosthoc(app.id, 'prop_rej', dana, why), 403);
  await rejectsWith(dismissRejectedPosthoc(app.id, 'prop_rej', admin, 'too short'), 400);
  await rejectsWith(dismissRejectedPosthoc(app.id, 'prop_pen', admin, why), 409, /only a REJECTED post-hoc card/);
  const r = await dismissRejectedPosthoc(app.id, 'prop_rej', admin, why);
  assert.deepEqual(r.unreviewed, ['prop_pen']);
  await rejectsWith(dismissRejectedPosthoc(app.id, 'prop_rej', admin, why), 409, /no longer blocks/);
  assert.equal((await getAppByIdInternal(app.id))!.proposals!.find((p) => p.id === 'prop_rej')!.status, 'rejected', 'the card itself is kept');
});


test('H: the live pin follows Prod - a go-live moves live/app/<id> to the release commit; a rollback moves it back; Dev never', async () => {
  const app = await v2WithDevRelease('H Pin');
  const before = pinned.length;
  const r = await requestDeploy(app.id, alice);
  assert.equal(r.kind, 'auto-deployed');
  const mine = pinned.slice(before).filter((p) => p.appId === app.id);
  assert.equal(mine.length, 1, 'one pin move for one Prod release');
  assert.equal(mine[0].env, 'prod');
  assert.equal(mine[0].sha, SHA);
  assert.equal(mine[0].releaseId, currentRelease((await getAppByIdInternal(app.id))!, 'prod')!.id);
  const { rolloutRelease } = await import('./rollout.ts');
  const dev = await rolloutRelease((await getAppByIdInternal(app.id))!, { env: 'dev', sha: SHA, digest: D1, by: { id: 'auto-dev' }, reason: 'auto-dev' });
  assert.equal(dev.ok, true);
  assert.equal(dev.ok && dev.pin, undefined, 'a Dev release moves no pin');
  assert.equal(pinned.filter((p) => p.appId === app.id).length, 1);
});

test('H: a pin that cannot be written does not undo the running Prod release; the result says so', async () => {
  const app = await v2WithDevRelease('H Pin Fails');
  const { rolloutRelease } = await import('./rollout.ts');
  const out = await rolloutRelease(app, { env: 'prod', sha: SHA, digest: D1, by: { id: 'alice' }, reason: 'go-live' }, { pinLive: async () => ({ ok: false, reason: 'repo offline' }) });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.release.state, 'running');
  assert.deepEqual(out.pin, { ok: false, reason: 'repo offline' });
});

test('H: the lifecycle go-live refuses an App Builder app (its pin follows the Prod release); v1 apps unchanged', async () => {
  const app = await v2WithDevRelease('H Lifecycle');
  const { appLifecycleAdapter, V2_GO_LIVE_REASON } = await import('@tabs/software/lib/lifecycle-adapter');
  const actor = { id: 'alice', name: 'alice', role: 'creator', domains: ['sales'] };
  const v = await appLifecycleAdapter.canGoLive(actor as never, { kind: 'app', id: app.id, name: app.name, domain: app.domain, head: 'x', tier: app.visibility } as never);
  assert.deepEqual(v, { ok: false, reason: V2_GO_LIVE_REASON(app.name) });
});

test('H: "no other eligible reviewer" - the Runs view and the filed request say so when nobody but the requester may approve', async () => {
  const { registerGoLiveCandidates } = await import('@core/policy/go-live-reviewers');
  const { releasesView } = await import('./view.ts');
  const app = await v2WithDevRelease('H Nobody', 'Shared');
  try {
    // Unchecked (no directory): never an all-clear.
    registerGoLiveCandidates(null);
    let v = await releasesView((await getAppByIdInternal(app.id))!, alice, 'dev');
    assert.equal(v.goLive.noReviewer, null);
    assert.match(v.goLive.reviewersUnchecked ?? '', /directory/);
    // Only the requester and a creator in sales: nobody may approve a Domain go-live.
    registerGoLiveCandidates(async () => [{ id: 'alice', role: 'creator', domains: ['sales'] }, { id: 'carol', role: 'creator', domains: ['sales'] }]);
    v = await releasesView((await getAppByIdInternal(app.id))!, alice, 'dev');
    assert.match(v.goLive.noReviewer ?? '', /no other eligible reviewer/);
    const r = await requestDeploy(app.id, alice);
    assert.equal(r.kind, 'review');
    assert.match(r.kind === 'review' ? r.noReviewer ?? '' : '', /no other eligible reviewer/);
    // A domain admin of sales exists: no notice.
    registerGoLiveCandidates(async () => [{ id: 'alice', role: 'creator', domains: ['sales'] }, { id: 'dana', role: 'domain_admin', domains: ['sales'] }]);
    v = await releasesView((await getAppByIdInternal(app.id))!, alice, 'dev');
    assert.equal(v.goLive.noReviewer, null);
    assert.equal(v.goLive.reviewersUnchecked, null);
  } finally {
    registerGoLiveCandidates(null);
  }
});

test('H: an unreadable reviewer directory is said to the requester ("could not check"), never silent', async () => {
  const { registerGoLiveCandidates } = await import('@core/policy/go-live-reviewers');
  const app = await v2WithDevRelease('H Unchecked', 'Shared');
  registerGoLiveCandidates(async () => {
    throw new Error('mirror offline');
  });
  try {
    const r = await requestDeploy(app.id, alice);
    assert.equal(r.kind, 'review');
    assert.match(r.kind === 'review' ? r.reviewersUnchecked ?? '' : '', /mirror offline/);
    assert.equal(r.kind === 'review' ? r.noReviewer : 'x', undefined);
  } finally {
    registerGoLiveCandidates(null);
  }
});
