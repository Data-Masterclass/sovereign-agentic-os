/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type NotionConn,
  notionAuthHeaders,
  pageTitle,
  notionSearch,
  notionGetPage,
  notionCreatePage,
  NOTION_VERSION,
} from './notion.ts';

function fakeFetch(script: (url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const r = script(u, init ?? {});
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Headers(r.headers ?? {}),
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

const TOKEN = 'ntn_fake_oauth_token_xxx';
function conn(fetchImpl: typeof fetch): NotionConn {
  return { baseUrl: 'https://api.notion.com/v1', token: TOKEN, fetchImpl };
}

test('auth: token → Bearer + notion-version header; no token → no auth (honest fail)', () => {
  const h = notionAuthHeaders(TOKEN);
  assert.equal(h.authorization, `Bearer ${TOKEN}`);
  assert.equal(h['notion-version'], NOTION_VERSION);
  assert.equal(notionAuthHeaders(undefined).authorization, undefined);
});

test('pageTitle extracts the plain text of the title property', () => {
  const page = { properties: { Name: { type: 'title', title: [{ plain_text: 'Q3 ' }, { plain_text: 'Plan' }] } } };
  assert.equal(pageTitle(page), 'Q3 Plan');
  assert.equal(pageTitle({ properties: {} }), '(untitled)');
});

test('notion_search POSTs /search and shapes real hits (no fixtures)', async () => {
  const f = fakeFetch((url, init) => {
    assert.equal(init.method, 'POST');
    assert.ok(url.endsWith('/search'));
    return { status: 200, body: { results: [{ id: 'p1', object: 'page', url: 'https://n/p1', properties: { title: { type: 'title', title: [{ plain_text: 'Roadmap' }] } } }] } };
  });
  const r = await notionSearch(conn(f.impl), 'road');
  assert.ok(r.ok && r.data[0].id === 'p1' && r.data[0].title === 'Roadmap');
});

test('notion_get_page reads /pages/{id} and maps title/url; 404 → not_found', async () => {
  const ok = fakeFetch(() => ({ status: 200, body: { id: 'p9', url: 'https://n/p9', properties: { Name: { type: 'title', title: [{ plain_text: 'Notes' }] } } } }));
  const r = await notionGetPage(conn(ok.impl), 'p9');
  assert.ok(r.ok && r.data.title === 'Notes');
  const missing = fakeFetch(() => ({ status: 404 }));
  assert.deepEqual(await notionGetPage(conn(missing.impl), 'nope'), { ok: false, reason: 'not_found' });
});

test('notion_create_page POSTs /pages with a title property + a paragraph block', async () => {
  const f = fakeFetch((url, init) => {
    assert.equal(init.method, 'POST');
    const body = JSON.parse(String(init.body));
    assert.equal(body.parent.page_id, 'parent1');
    assert.equal(body.properties.title.title[0].text.content, 'New');
    assert.ok(Array.isArray(body.children) && body.children[0].type === 'paragraph');
    return { status: 200, body: { id: 'new1', url: 'https://n/new1' } };
  });
  const r = await notionCreatePage(conn(f.impl), { parentId: 'parent1', title: 'New', text: 'hello' });
  assert.ok(r.ok && r.data.id === 'new1');
});

test('create requires parentId + title (honest arg errors, no half-baked call)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  assert.ok(!(await notionCreatePage(conn(f.impl), { parentId: '', title: 'x' })).ok);
  assert.ok(!(await notionCreatePage(conn(f.impl), { parentId: 'p', title: '' })).ok);
  assert.equal(f.calls.length, 0);
});

test('401 → reconnect reason; network error → unreachable (never throws)', async () => {
  const bad = fakeFetch(() => ({ status: 401 }));
  const r1 = await notionSearch(conn(bad.impl), 'x');
  assert.ok(!r1.ok && /reconnect/.test(r1.reason));
  const boom = (async () => { throw new Error('x'); }) as typeof fetch;
  const r2 = await notionSearch({ baseUrl: 'https://api.notion.com/v1', token: TOKEN, fetchImpl: boom }, 'x');
  assert.ok(!r2.ok && r2.reason === 'unreachable');
});
