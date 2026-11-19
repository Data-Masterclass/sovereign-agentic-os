/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       software
 * FEATURE:    The deploy status says what is really served, for the app's serve mode
 * USER STORY: As an app owner I want "Live" only when a runner really serves my app,
 *             "Published" (not "Draft") for my published declarative app, and no image-build
 *             talk or lost link for an app that has no image, so the status I read and share
 *             matches the app people can open.
 * ARCHITECTURE:
 *   - The badge rule is `deployStatusOf` (deploy-status.ts), shared by the builder UI and the
 *     `get_software_status` MCP card, which is called here through the real dispatcher.
 *   - `reconcileDeployStatus` runs against a recording Kubernetes stub: a declarative app must
 *     never get a runner Deployment from a status poll, and must keep its same-origin URL.
 *   - Imports `@core/*` and this tab only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { handleRpc } from '@core/mcp/server';
import { createApp, getAppForUser, persistApp } from '@tabs/software/lib/apps';
import { reconcileDeployStatus } from '@tabs/software/lib/review';
import type { RunnerK8s } from '@tabs/software/lib/runner';

const creator: CurrentUser = { id: 'alice', name: 'Alice', domains: ['sales'], role: 'creator' };
const OPTS = { namespace: 'agentic-apps', ingressClass: 'nginx', tlsIssuer: 'letsencrypt-prod' };

/** A reachable cluster where the app's runner is ABSENT; records every call. */
function absentRunnerK8s() {
  const calls: { method: string; path: string }[] = [];
  const client: RunnerK8s = async (method, path) => {
    calls.push({ method, path });
    if (method === 'POST' || method === 'PUT') return { status: 201, body: {} };
    if (method === 'GET' && path === `/api/v1/namespaces/${OPTS.namespace}`) return { status: 200, body: {} };
    return { status: 404, body: {} };
  };
  return { client, calls };
}

async function statusCard(user: CurrentUser, appId: string): Promise<Record<string, any>> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_software_status', arguments: { appId } } }) as
    { result?: { structuredContent?: unknown; content?: { text?: string }[] } };
  const r = res.result!;
  return (r.structuredContent ?? JSON.parse((r.content ?? []).map((c) => c.text ?? '').join(''))) as Record<string, any>;
}

test('STATUS POLL: a declarative app in preview is never given a runner Deployment, and keeps its URL', async () => {
  const app = await createApp(creator, { name: 'Spec Poll', kind: 'spec' } as Parameters<typeof createApp>[1]);
  app.serveMode = 'spec';
  app.spec = { tabs: [] } as unknown as typeof app.spec;
  app.runImage = 'registry.example.com/apps/anything:1'; // an image exists — the mode must still decide
  app.deploy.state = 'preview';
  app.deploy.previewUrl = `/apps/${app.slug}`;
  await persistApp(app);

  const { client, calls } = absentRunnerK8s();
  await reconcileDeployStatus(app.id, creator, { ...OPTS, k8s: client });

  assert.ok(!calls.some((c) => c.method === 'POST' && c.path.endsWith('/deployments')), 'no Deployment is created for a declarative app');
  const after = await getAppForUser(app.id, creator);
  assert.equal(after.deploy.previewUrl, `/apps/${app.slug}`, 'the same-origin URL is not dropped');
});

test('STATUS CARD: a published declarative app reports its served URL, not "image build" or "runner unreachable"', async () => {
  const app = await createApp(creator, { name: 'Spec Card', kind: 'spec' } as Parameters<typeof createApp>[1]);
  app.serveMode = 'spec';
  app.spec = { tabs: [] } as unknown as typeof app.spec;
  app.deploy.releases = 1;
  await persistApp(app);

  const card = await statusCard(creator, app.id);
  assert.equal(card.preview.url, `/apps/${app.slug}`);
  assert.equal(card.preview.note, undefined);
  assert.doesNotMatch(JSON.stringify(card), /Image build in progress|runner unreachable/i);
  assert.equal(card.preview.label, 'Published');
});

test('BADGE: an approved image app whose runner is not serving reads "Approved · not serving yet", never "Live"', async () => {
  const { deployStatusOf } = await import('@tabs/software/lib/deploy-status');
  const notServing = deployStatusOf({ slug: 'a', serveMode: 'image', deploy: { state: 'live', previewUrl: null } });
  assert.notEqual(notServing.label, 'Live');
  assert.equal(notServing.servedUrl, null);
  const serving = deployStatusOf({ slug: 'a', serveMode: 'image', deploy: { state: 'live', previewUrl: 'https://a.apps.example' } });
  assert.equal(serving.label, 'Live');
});

test('BADGE: a published declarative app reads "Published", not "Draft"', async () => {
  const { deployStatusOf } = await import('@tabs/software/lib/deploy-status');
  const published = deployStatusOf({ slug: 's', serveMode: 'spec', spec: { tabs: [] }, deploy: { state: 'building', previewUrl: null } });
  assert.equal(published.label, 'Published');
  assert.equal(published.servedUrl, '/apps/s');
  const unpublished = deployStatusOf({ slug: 's', serveMode: 'spec', deploy: { state: 'building', previewUrl: null } });
  assert.equal(unpublished.label, 'Draft');
});

test('APPROVAL: approving a declarative app does not provision a runner', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('./review.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function applyDeployDecisionToApp'), src.indexOf('export type ScanGate'));
  assert.match(body, /serveModeOf\(app\) === 'image'/, 'the runner is only provisioned for an image app');
});
