/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    WP-54 — the deploy approval is THE gate for applying an app's committed k8s/ files
 * USER STORY: As a platform owner I want no app manifest to reach the cluster unless a Builder
 *             approved that exact commit, so a Creator alone can never deploy, preview included.
 * ARCHITECTURE: createApp + a git tree reader seam (records the ref each deploy reads) + a counting
 *             Kubernetes mock passed through `runner` opts. Every door that can call deployApp is
 *             exercised: start_preview, routine request_deploy, decide_deploy, the status self-heal.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { testUser } from '@core/testing/user';
import { createApp, getAppForUser, persistApp } from '@tabs/software/lib/apps';
import { startPreview, requestDeploy, decideDeploy, reconcileDeployStatus } from './review.ts';
import { appDeployFiles } from './native-deploy.ts';
import { __setAppProjectGitForTests, __setAppTreeReaderForTests } from './git-commit.ts';
import type { RunnerK8s } from './runner.ts';

const creator: CurrentUser = testUser({ id: 'wp54-cara', name: 'Cara', domains: ['sales'], role: 'creator' });
const builder: CurrentUser = testUser({ id: 'wp54-ben', name: 'Ben', domains: ['sales'], role: 'builder' });
const REGISTRY = 'registry.example.com/sovereign-os-apps';

let headSha = 'a'.repeat(40);
const refsRead: (string | undefined)[] = [];

function counting() {
  const calls: string[] = [];
  let created = false;
  const k8s: RunnerK8s = async (method, path) => {
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path.endsWith('/namespaces/agentic-apps')) return { status: 200, body: {} };
    if (method === 'POST') { if (path.endsWith('/deployments')) created = true; return { status: 201, body: {} }; }
    if (method === 'GET' && path.includes('/deployments/')) return created ? { status: 200, body: { spec: { replicas: 1 }, status: { readyReplicas: 1 } } } : { status: 404, body: {} };
    if (method === 'GET') return { status: 404, body: {} };
    return { status: 200, body: {} };
  };
  return { calls, runner: { k8s, namespace: 'agentic-apps', registry: REGISTRY, ingressClass: 'nginx', tlsIssuer: 'le' } };
}

async function imageApp(name: string) {
  const app = await createApp(creator, { name, template: 'website', kind: 'code', domain: 'sales' } as never);
  const a = await getAppForUser(app.id, creator);
  a.serveMode = 'image';
  await persistApp(a);
  const files = appDeployFiles({ slug: a.slug, host: `${a.slug}.${a.domain}.apps.local`, registry: REGISTRY, digest: `sha256:${'d'.repeat(64)}`, ingressClass: 'nginx', tlsIssuer: 'le' });
  __setAppProjectGitForTests(true);
  __setAppTreeReaderForTests(async (_d, _p, opts) => {
    refsRead.push(opts.ref);
    return { files, sha: headSha, truncated: false };
  });
  return a;
}

after(() => {
  __setAppTreeReaderForTests(null);
  __setAppProjectGitForTests(null);
});

test('start_preview of an image app with NO approved commit applies nothing (a Creator cannot deploy)', async () => {
  const app = await imageApp('Gate Preview');
  const { calls, runner } = counting();
  const { runnerNote } = await startPreview(app.id, creator, { runner });
  assert.equal(calls.length, 0, 'zero Kubernetes calls');
  assert.match(runnerNote ?? '', /approv/i, 'it says a Builder approval is required');
});

test('request_deploy pins the commit; decide_deploy by a Builder applies EXACTLY that commit', async () => {
  headSha = 'b'.repeat(40);
  const app = await imageApp('Gate Decide');
  const req = counting();
  const res = await requestDeploy(app.id, creator, { runner: req.runner });
  assert.equal(res.kind, 'review', 'a Creator\'s request opens a card');
  assert.equal(req.calls.length, 0, 'filing applies nothing');

  // A Creator cannot approve their own request.
  await assert.rejects(decideDeploy((res as { card: { id: string } }).card.id, creator, 'approve', undefined, { runner: req.runner }), /Builder|Administrator/);

  headSha = 'c'.repeat(40); // HEAD moves after the request: the approval still covers the requested commit only
  refsRead.length = 0;
  const dec = counting();
  await decideDeploy((res as { card: { id: string } }).card.id, builder, 'approve', undefined, { runner: dec.runner });
  assert.ok(dec.calls.some((c) => c.startsWith('POST') && c.endsWith('/deployments')), 'the approved commit is applied');
  assert.deepEqual([...new Set(refsRead)], ['b'.repeat(40)], 'the deploy read the pinned commit, not HEAD');
});

test('a routine request_deploy on a LIVE image app never auto-applies new manifests', async () => {
  headSha = 'e'.repeat(40);
  const app = await imageApp('Gate Routine');
  const first = await requestDeploy(app.id, creator, { runner: counting().runner });
  await decideDeploy((first as { card: { id: string } }).card.id, builder, 'approve', undefined, { runner: counting().runner });
  headSha = 'f'.repeat(40); // a new commit lands
  const again = counting();
  const res = await requestDeploy(app.id, creator, { runner: again.runner });
  assert.notEqual(res.kind, 'auto-deployed', 'the new commit needs its own approval');
  assert.equal(again.calls.length, 0, 'nothing applied');

  // start_preview and the status self-heal re-apply only the APPROVED commit, never HEAD.
  refsRead.length = 0;
  const prev = counting();
  await startPreview(app.id, creator, { runner: prev.runner });
  await reconcileDeployStatus(app.id, creator, prev.runner);
  assert.ok(refsRead.length > 0, 'the approved tree was read');
  assert.deepEqual([...new Set(refsRead)], ['e'.repeat(40)], 'only the approved commit');
});
