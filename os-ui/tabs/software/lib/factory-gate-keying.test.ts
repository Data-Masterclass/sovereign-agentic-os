/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory - whether the gates run is decided by what the OS stored, never by the tree
 * USER STORY: As the platform owner I want an author to be unable to switch the quality gates off by
 *             editing a line in their own app.yaml, so a deploy request on a container app always runs them.
 * ARCHITECTURE: createApp + commitToApp + requestDeploy/runAppTests with a recording gates runner. The key
 *             is the stored `app.template` plus `serveMode`; the tree's `template:` line is never read.
 *             Each block has its negative twin (a non-container app is not gated).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as cfg } from '@core/kernel/config';
import type { CurrentUser } from '@core/kernel/auth';
import { createApp } from '@tabs/software/lib/apps';
import { commitToApp } from '@tabs/software/lib/server';
import { requestDeploy, runAppTests, __resetReviewCards } from './review.ts';
import { gatePolicyFor } from './gate-policy.ts';
import { REQUIRED_GATES, type GatesOutcome } from './gates.ts';
import { recordFromOutcome } from './check-record.ts';
import type { ChecksRunner } from './tekton-checks.ts';

let reposDir = '';
let prior = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-gk-'));
  prior = cfg.reposDir;
  (cfg as { reposDir: string }).reposDir = reposDir;
});
after(() => {
  (cfg as { reposDir: string }).reposDir = prior;
  rmSync(reposDir, { recursive: true, force: true });
});

const creator: CurrentUser = { id: 'gk-alice', name: 'Alice', domains: ['sales'], role: 'creator' };
const outcome = (status: 'pass' | 'fail'): GatesOutcome => ({
  ok: true,
  report: { schema: 'os-gates/v1', template: 'nextjs-web', ok: status === 'pass', gates: REQUIRED_GATES.map((id) => ({ id, status, detail: 'x' })) },
});
function recorder(status: 'pass' | 'fail') {
  const calls: string[] = [];
  const gates: ChecksRunner = async (i) => {
    calls.push(i.slug);
    return { record: recordFromOutcome({ sha: i.sha, trigger: i.trigger, engine: 'fake', startedAt: 't0', finishedAt: 't1', outcome: outcome(status) }), superseded: [] };
  };
  return { calls, gates };
}

test('gatePolicyFor: a golden-path app and ANY container app require the gates; a spec app does not', () => {
  assert.equal(gatePolicyFor({ template: 'nextjs-web', serveMode: 'image' }).required, true);
  assert.equal(gatePolicyFor({ template: 'nextjs-supabase', serveMode: 'image' }).required, true);
  assert.equal(gatePolicyFor({ template: 'empty', serveMode: 'image' }).required, true);
  assert.equal(gatePolicyFor({ template: 'nextjs-supabase', serveMode: 'spec' }).required, false);
  assert.equal(gatePolicyFor({ template: 'nextjs-web', serveMode: 'image' }).profile, 'nextjs-web');
  assert.equal(gatePolicyFor({ template: 'vite-os', serveMode: 'image' }).profile, 'nextjs-web');
  assert.match(gatePolicyFor({ template: 'vite-os', serveMode: 'image' }).reason, /container/i);
});

test('deleting `template:` from app.yaml does not skip the gates (HIGH)', async () => {
  __resetReviewCards();
  const app = await createApp(creator, { name: 'Gate Key One', template: 'nextjs-web' });
  await commitToApp(app.id, creator, [{ path: 'app.yaml', content: "apiVersion: software.sovereign-os/v1\nkind: App\nname: 'Gate Key One'\nsurface: both\n" }], 'drop the template line');
  const r = recorder('fail');
  await assert.rejects(
    requestDeploy(app.id, creator, { scanMode: 'offline-mock', checks: r.gates }),
    (e: Error & { status?: number }) => { assert.equal(e.status, 422); return true; },
  );
  assert.equal(r.calls.length, 1, 'the gates must have run');
});

test('app.yaml naming a different template does not skip the gates (HIGH)', async () => {
  __resetReviewCards();
  const app = await createApp(creator, { name: 'Gate Key Two', template: 'nextjs-web' });
  await commitToApp(app.id, creator, [{ path: 'app.yaml', content: "name: 'Gate Key Two'\ntemplate: something-else\nsurface: both\n" }], 'rename the template');
  const r = recorder('fail');
  await assert.rejects(requestDeploy(app.id, creator, { scanMode: 'offline-mock', checks: r.gates }), /./);
  assert.equal(r.calls.length, 1);
});

test('the same edit with passing gates still opens the review (the gate is a gate, not a wall)', async () => {
  __resetReviewCards();
  const app = await createApp(creator, { name: 'Gate Key Three', template: 'nextjs-web' });
  await commitToApp(app.id, creator, [{ path: 'app.yaml', content: "name: 'Gate Key Three'\nsurface: both\n" }], 'drop the template line');
  const r = recorder('pass');
  const out = await requestDeploy(app.id, creator, { scanMode: 'offline-mock', checks: r.gates });
  assert.equal(out.kind, 'review');
  assert.equal(r.calls.length, 1);
});

test('a legacy-template CONTAINER app is gated too: the default is to require the gates (HIGH)', async () => {
  __resetReviewCards();
  const app = await createApp(creator, { name: 'Gate Key Legacy', template: 'nextjs-supabase' });
  const r = recorder('fail');
  await assert.rejects(requestDeploy(app.id, creator, { scanMode: 'offline-mock', checks: r.gates }), (e: Error & { status?: number }) => { assert.equal(e.status, 422); return true; });
  assert.equal(r.calls.length, 1);
});

test('NEGATIVE TWIN: an app the OS serves itself (spec) has no container, so no gates run', async () => {
  __resetReviewCards();
  const app = await createApp(creator, { name: 'Gate Key Spec', template: 'nextjs-supabase', kind: 'spec' } as never);
  const r = recorder('fail');
  await requestDeploy(app.id, creator, { scanMode: 'offline-mock', checks: r.gates }).catch(() => undefined);
  assert.equal(r.calls.length, 0, 'a non-container app must not start a sandbox');
});

test('verify_app_gates (runAppTests) keys on the stored template too, even with no `template:` line', async () => {
  const app = await createApp(creator, { name: 'Gate Key Verify', template: 'nextjs-web' });
  await commitToApp(app.id, creator, [{ path: 'app.yaml', content: "name: 'Gate Key Verify'\nsurface: both\n" }], 'drop the template line');
  const r = recorder('pass');
  const out = await runAppTests(app.id, creator, { checks: r.gates });
  assert.equal(out.verdict.passed, true);
  assert.equal(r.calls.length, 1);
});
