/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    An app's file list and knowledge feed show exactly what the app was granted
 * USER STORY: As the owner of an app I grant it one knowledge workflow and one file in Choose
 *             Context. When the app lists knowledge it sees that workflow's passages (not an
 *             empty list), and when it lists files the folder and tag rail names only the
 *             files it was granted, not the rest of my drive.
 * ARCHITECTURE:
 *   - Drives the REAL `GET /api/knowledge/docs` and `GET /api/files` routes with a request that
 *     carries a deployed app's Origin, so `appSlugFromRequest` attributes it exactly as in
 *     production. The apps store and the files store are the real in-memory stores; the session
 *     is mocked at the auth seam and OpenSearch is answered by a stubbed `fetch`.
 *   - A knowledge passage is indexed under `<workflowId>:step:<stepId>` (`chunk.ts`) while a
 *     knowledge grant names the workflow id, so the feed must match on the passage's workflow.
 *   - The OS UI's own request (no app Origin) is unchanged.
 */
process.env.OS_APPS_DOMAIN = 'apps.example.com';
process.env.OS_PUBLIC_URL = 'https://os.example.com';

import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const HITS = [
  { _id: 'wf_granted:step:s1', _source: { title: 'Refund policy', text: 'Refunds within 30 days.', workflow_id: 'wf_granted', source: 'knowledge' } },
  { _id: 'wf_other:step:s1', _source: { title: 'Board notes', text: 'Not for this app.', workflow_id: 'wf_other', source: 'knowledge' } },
];
globalThis.fetch = (async (url: string | URL | Request) => {
  const u = String(url instanceof Request ? url.url : url);
  if (u.includes('/_search')) {
    return new Response(JSON.stringify({ hits: { total: { value: HITS.length }, hits: HITS } }), { status: 200 });
  }
  throw new Error('offline-stub');
}) as typeof fetch;

const USER = { id: 'own', name: 'Owner', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'builder' };
mock.module('@core/kernel/auth', {
  namedExports: { requireUser: async () => USER, currentUser: async () => USER },
});

const { createApp, writeThroughApp, __resetAppsCache } = await import('./apps.ts');
const { createFile } = await import('@tabs/files/lib/store');
const knowledgeDocs = await import('../../../app/api/knowledge/docs/route.ts');
const filesRoute = await import('../../../app/api/files/route.ts');

let slug = '';
let grantedFileId = '';

beforeEach(async () => {
  __resetAppsCache();
  const granted = createFile(USER as never, { name: 'price-list.csv', folder: '/shared-with-app', tags: ['pricing'], text: 'a,b' });
  createFile(USER as never, { name: 'acquisition-memo.md', folder: '/board-only', tags: ['acquisition'], text: 'secret' });
  grantedFileId = granted.id;
  const app = await createApp(USER as never, { name: 'Support Desk', template: 'sovereign-app' });
  app.grants.knowledge = [{ id: 'wf_granted', access: 'read-only' }];
  app.grants.files = [{ id: grantedFileId, access: 'read-only' }];
  writeThroughApp(app);
  slug = app.slug;
});

const fromApp = (path: string) =>
  new Request(`https://os.example.com${path}`, { headers: { origin: `https://${slug}.sales.apps.example.com` } });

test('an app granted a knowledge workflow sees that workflow’s passages in its feed, and no others', async () => {
  const res = await knowledgeDocs.GET(fromApp('/api/knowledge/docs'));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { total: number; docs: { id: string; title: string }[] };
  assert.deepEqual(body.docs.map((d) => d.title), ['Refund policy']);
  assert.equal(body.total, 1);
});

test('the OS UI’s own knowledge feed is unchanged', async () => {
  const res = await knowledgeDocs.GET(new Request('https://os.example.com/api/knowledge/docs'));
  const body = (await res.json()) as { docs: { title: string }[] };
  assert.deepEqual(body.docs.map((d) => d.title).sort(), ['Board notes', 'Refund policy']);
});

test('an app’s file list names only the folders and tags of the files it was granted', async () => {
  const res = await filesRoute.GET(fromApp('/api/files'), { params: Promise.resolve({}) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    mine: { id: string }[]; domain: { id: string }[]; marketplace: { id: string }[];
    facets: { folders: { path: string }[]; tags: { tag: string }[] };
  };
  assert.deepEqual([...body.mine, ...body.domain, ...body.marketplace].map((f) => f.id), [grantedFileId]);
  assert.deepEqual(body.facets.folders.map((f) => f.path), ['/shared-with-app']);
  assert.deepEqual(body.facets.tags.map((t) => t.tag), ['pricing']);
});

test('the OS UI’s own file list still shows the whole drive in its folder rail', async () => {
  const res = await filesRoute.GET(new Request('https://os.example.com/api/files'), { params: Promise.resolve({}) });
  const body = (await res.json()) as { facets: { folders: { path: string }[] } };
  const paths = body.facets.folders.map((f) => f.path);
  assert.ok(paths.includes('/board-only') && paths.includes('/shared-with-app'));
});
