/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type NotionConn,
  notionAuthHeaders,
  notionHealth,
  pageTitle,
  notionSearch,
  notionGetPage,
  notionCreatePage,
  NOTION_VERSION,
  NOTION_MAX_PAGES,
  NOTION_PAGE_SIZE,
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

// ------------------------------------------------------------ auth ---------------

test('auth: token → Bearer + notion-version header; no token → no auth (honest fail)', () => {
  const h = notionAuthHeaders(TOKEN);
  assert.equal(h.authorization, `Bearer ${TOKEN}`);
  assert.equal(h['notion-version'], NOTION_VERSION);
  assert.equal(notionAuthHeaders(undefined).authorization, undefined);
});

// ----------------------------------------------------------- health ---------------

test('health: GET /users/me 2xx → connected with name; 401 → honest not-connected (never fake green)', async () => {
  const up = fakeFetch(() => ({ status: 200, body: { name: 'My Integration', type: 'bot' } }));
  const h = await notionHealth(conn(up.impl));
  assert.equal(h.connected, true);
  assert.ok(h.detail?.includes('My Integration'));
  assert.ok(up.calls[0].url.endsWith('/users/me'));

  const bad = fakeFetch(() => ({ status: 401 }));
  const h2 = await notionHealth(conn(bad.impl));
  assert.ok(!h2.connected && /unauthorized/.test(h2.reason ?? ''));
});

test('health: rate-limited 429 → honest not-connected with retry hint', async () => {
  const f = fakeFetch(() => ({ status: 429, headers: { 'retry-after': '30' } }));
  const h = await notionHealth(conn(f.impl));
  assert.ok(!h.connected && /rate-limited/.test(h.reason ?? '') && /30/.test(h.reason ?? ''));
});

test('health: network error → unreachable (never throws)', async () => {
  const boom = (async () => { throw new Error('net'); }) as typeof fetch;
  const h = await notionHealth({ baseUrl: 'https://api.notion.com/v1', token: TOKEN, fetchImpl: boom });
  assert.ok(!h.connected && h.reason === 'unreachable');
});

// ----------------------------------------------------------- pageTitle -----------

test('pageTitle extracts the plain text of the title property', () => {
  const page = { properties: { Name: { type: 'title', title: [{ plain_text: 'Q3 ' }, { plain_text: 'Plan' }] } } };
  assert.equal(pageTitle(page), 'Q3 Plan');
  assert.equal(pageTitle({ properties: {} }), '(untitled)');
});

// ----------------------------------------------------------- search ---------------

test('notion_search POSTs /search and shapes real hits (no fixtures)', async () => {
  const f = fakeFetch((url, init) => {
    assert.equal(init.method, 'POST');
    assert.ok(url.endsWith('/search'));
    return { status: 200, body: { results: [{ id: 'p1', object: 'page', url: 'https://n/p1', properties: { title: { type: 'title', title: [{ plain_text: 'Roadmap' }] } } }], has_more: false } };
  });
  const r = await notionSearch(conn(f.impl), 'road');
  assert.ok(r.ok && r.data[0].id === 'p1' && r.data[0].title === 'Roadmap');
  assert.equal(r.ok && r.truncated, false);
});

test('pagination: follows next_cursor and flags truncated at page bound', async () => {
  let page = 0;
  const f = fakeFetch((_url, init) => {
    page += 1;
    const body = JSON.parse(String(init.body)) as { start_cursor?: string; page_size?: number };
    // All pages except the last claim has_more=true with a cursor.
    const has_more = page < NOTION_MAX_PAGES + 2; // ensure we always have more
    return {
      status: 200,
      body: {
        results: [{ id: `p${page}`, object: 'page', url: `https://n/p${page}`, properties: {} }],
        has_more,
        next_cursor: has_more ? `cursor-${page}` : null,
        // The first page has no start_cursor in the request body.
        _reqPage: body.start_cursor,
      },
    };
  });
  const r = await notionSearch(conn(f.impl), 'q');
  assert.ok(r.ok);
  // Should have followed exactly NOTION_MAX_PAGES pages and stopped.
  assert.equal(f.calls.length, NOTION_MAX_PAGES);
  assert.equal(r.ok && r.truncated, true);
  // First request has no start_cursor, second onwards does.
  const firstBody = JSON.parse(String(f.calls[0].init.body)) as { start_cursor?: string; page_size?: number };
  assert.equal(firstBody.start_cursor, undefined);
  assert.equal(firstBody.page_size, NOTION_PAGE_SIZE);
  const secondBody = JSON.parse(String(f.calls[1].init.body)) as { start_cursor?: string };
  assert.equal(secondBody.start_cursor, 'cursor-1');
});

test('pagination: no cursor on last page → no truncated flag', async () => {
  let call = 0;
  const f = fakeFetch(() => {
    call += 1;
    return {
      status: 200,
      body: {
        results: [{ id: `r${call}`, object: 'page', url: 'u', properties: {} }],
        has_more: false,
        next_cursor: null,
      },
    };
  });
  const r = await notionSearch(conn(f.impl), 'q');
  assert.ok(r.ok && !r.truncated);
  assert.equal(f.calls.length, 1);
});

// ----------------------------------------------------------- get_page ------------

test('notion_get_page reads /pages/{id} and maps title/url; 404 → not_found', async () => {
  const ok = fakeFetch(() => ({ status: 200, body: { id: 'p9', url: 'https://n/p9', properties: { Name: { type: 'title', title: [{ plain_text: 'Notes' }] } } } }));
  const r = await notionGetPage(conn(ok.impl), 'p9');
  assert.ok(r.ok && r.data.title === 'Notes');
  const missing = fakeFetch(() => ({ status: 404 }));
  assert.deepEqual(await notionGetPage(conn(missing.impl), 'nope'), { ok: false, reason: 'not_found' });
});

// ----------------------------------------------------------- create_page ---------

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

test('create_page: 429 on first attempt triggers one backoff retry (never hammer)', async () => {
  let calls = 0;
  const f = fakeFetch(() => {
    calls += 1;
    // First call → 429; second → 200. The retry is the backoff jitter path.
    if (calls === 1) return { status: 429, headers: { 'retry-after': '0' } };
    return { status: 200, body: { id: 'new2', url: 'https://n/new2' } };
  });
  const r = await notionCreatePage(conn(f.impl), { parentId: 'par', title: 'T' });
  assert.ok(r.ok && r.data.id === 'new2', 'should succeed after one backoff retry');
  assert.equal(calls, 2, 'exactly one retry, never hammered');
});

test('create_page: 429 on both attempts → honest rate-limited reason (no throw)', async () => {
  const f = fakeFetch(() => ({ status: 429, headers: { 'retry-after': '0' } }));
  const r = await notionCreatePage(conn(f.impl), { parentId: 'par', title: 'T' });
  assert.ok(!r.ok && /rate-limited/.test(r.reason));
  assert.equal(f.calls.length, 2, 'exactly two attempts, then gives up');
});

// ----------------------------------------------------------- failure paths -------

test('401 → reconnect reason; network error → unreachable (never throws)', async () => {
  const bad = fakeFetch(() => ({ status: 401 }));
  const r1 = await notionSearch(conn(bad.impl), 'x');
  assert.ok(!r1.ok && /reconnect/.test(r1.reason));
  const boom = (async () => { throw new Error('x'); }) as typeof fetch;
  const r2 = await notionSearch({ baseUrl: 'https://api.notion.com/v1', token: TOKEN, fetchImpl: boom }, 'x');
  assert.ok(!r2.ok && r2.reason === 'unreachable');
});

test('no token ⇒ no Authorization header sent (honest auth failure, not a broken header)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { results: [], has_more: false } }));
  await notionSearch({ baseUrl: 'https://api.notion.com/v1', fetchImpl: f.impl }, 'q');
  const sent = f.calls[0].init.headers as Record<string, string>;
  assert.equal(sent.authorization, undefined);
});
