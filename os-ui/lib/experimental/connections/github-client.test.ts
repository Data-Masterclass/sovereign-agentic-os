/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type GithubConn,
  githubAuthHeaders,
  githubHealth,
  isValidRepoSlug,
  nextLink,
  listRepos,
  getRepo,
  listIssues,
  getIssue,
  searchCode,
  listPulls,
  listCommits,
  createIssue,
  addIssueComment,
  createPullRequest,
  GITHUB_MAX_PAGES,
} from './github.ts';

/** A recording fake fetch: captures every request and returns a scripted response. */
function fakeFetch(
  script: (url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> },
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const r = script(u, init ?? {});
    const headers = new Headers(r.headers ?? {});
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers,
      json: async () => r.body ?? {},
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})),
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

const TOKEN = 'ghp_fake_token_value_xxx';
function conn(fetchImpl: typeof fetch): GithubConn {
  return { baseUrl: 'https://api.github.com', token: TOKEN, fetchImpl };
}

test('auth: a token yields a Bearer header; no token yields none (honest fail)', () => {
  assert.equal(githubAuthHeaders(TOKEN).authorization, `Bearer ${TOKEN}`);
  assert.equal(githubAuthHeaders(undefined).authorization, undefined);
});

test('repo-slug validation rejects path traversal / bad shapes before we path with it', () => {
  assert.ok(isValidRepoSlug('acme/repo'));
  assert.ok(!isValidRepoSlug('acme'));
  assert.ok(!isValidRepoSlug('acme/repo/extra'));
  assert.ok(!isValidRepoSlug('../etc/passwd'));
});

test('nextLink parses the Link header rel="next" (and returns null when absent)', () => {
  assert.equal(nextLink('<https://api.github.com/x?page=2>; rel="next", <...>; rel="last"'), 'https://api.github.com/x?page=2');
  assert.equal(nextLink('<...>; rel="prev"'), null);
  assert.equal(nextLink(null), null);
});

test('listRepos builds /user/repos, injects the Bearer, and shapes rows', async () => {
  const f = fakeFetch(() => ({ status: 200, body: [{ full_name: 'acme/api', private: true, description: 'd', default_branch: 'main' }] }));
  const r = await listRepos(conn(f.impl));
  assert.ok(r.ok && r.data[0].fullName === 'acme/api' && r.data[0].private === true);
  assert.ok(f.calls[0].url.startsWith('https://api.github.com/user/repos'));
  assert.equal((f.calls[0].init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
});

test('getRepo validates the slug BEFORE pathing (bad slug never hits the network)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  const r = await getRepo(conn(f.impl), 'not-a-slug');
  assert.ok(!r.ok && /owner\/repo/.test(r.reason));
  assert.equal(f.calls.length, 0);
});

test('listIssues filters out PRs (GitHub returns PRs under /issues)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: [
    { number: 1, title: 'bug', state: 'open', user: { login: 'ada' } },
    { number: 2, title: 'a pr', state: 'open', user: { login: 'ada' }, pull_request: { url: 'x' } },
  ] }));
  const r = await listIssues(conn(f.impl), 'acme/api');
  assert.ok(r.ok && r.data.length === 1 && r.data[0].number === 1);
});

test('read: an unseeable id → not_found (404 mapped honestly, never fabricated)', async () => {
  const f = fakeFetch(() => ({ status: 404 }));
  const r = await getIssue(conn(f.impl), 'acme/api', 999);
  assert.ok(!r.ok && r.reason === 'not_found');
});

test('secondary rate limit: 403 + x-ratelimit-remaining:0 → honest rate-limited reason (no hammer)', async () => {
  const f = fakeFetch(() => ({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '30' } }));
  const r = await searchCode(conn(f.impl), 'foo');
  assert.ok(!r.ok && /rate-limited/.test(r.reason) && /30/.test(r.reason));
});

test('pagination: follows rel=next and flags truncated past the page bound', async () => {
  let page = 0;
  const f = fakeFetch((url) => {
    page += 1;
    // Always advertise a next page → we hit the bound and must set truncated.
    return { status: 200, body: [{ full_name: `acme/r${page}`, private: false }], headers: { link: `<${url}&page=${page + 1}>; rel="next"` } };
  });
  const r = await listRepos(conn(f.impl));
  assert.ok(r.ok && r.truncated === true);
  assert.equal(f.calls.length, GITHUB_MAX_PAGES);
});

test('create_issue: gate-held write path executes and shapes the created issue', async () => {
  const f = fakeFetch((url, init) => {
    if (init.method === 'POST') return { status: 201, body: { number: 7, title: 'new', state: 'open', user: { login: 'me' }, html_url: 'u' } };
    return { status: 200, body: [] }; // dedupe pre-check: no open issues
  });
  const r = await createIssue(conn(f.impl), 'acme/api', { title: 'new', body: 'b' });
  assert.ok(r.ok && r.data.number === 7 && !r.data.deduped);
});

test('create_issue idempotency guard: an existing OPEN issue with the same title is returned, not re-created', async () => {
  const f = fakeFetch((url, init) => {
    assert.notEqual(init.method, 'POST', 'must NOT POST a duplicate');
    return { status: 200, body: [{ number: 3, title: 'dup', state: 'open', user: { login: 'x' } }] };
  });
  const r = await createIssue(conn(f.impl), 'acme/api', { title: 'dup', body: 'b' });
  assert.ok(r.ok && r.data.number === 3 && r.data.deduped === true);
});

test('create_pull_request dedupes on title+head+base', async () => {
  const f = fakeFetch((url, init) => {
    assert.notEqual(init.method, 'POST', 'must NOT POST a duplicate PR');
    return { status: 200, body: [{ number: 5, title: 'feat', state: 'open', head: { ref: 'f' }, base: { ref: 'main' } }] };
  });
  const r = await createPullRequest(conn(f.impl), 'acme/api', { title: 'feat', head: 'f', base: 'main' });
  assert.ok(r.ok && r.data.deduped === true);
});

test('add_issue_comment posts to the comments path', async () => {
  const f = fakeFetch(() => ({ status: 201, body: { id: 11, html_url: 'u' } }));
  const r = await addIssueComment(conn(f.impl), 'acme/api', 7, 'hi');
  assert.ok(r.ok && r.data.id === 11);
  assert.ok(f.calls[0].url.endsWith('/repos/acme/api/issues/7/comments'));
});

test('listCommits shapes sha/message/author from the nested commit object', async () => {
  const f = fakeFetch(() => ({ status: 200, body: [{ sha: 'abc', commit: { message: 'init', author: { name: 'Ada', date: '2026-01-01' } } }] }));
  const r = await listCommits(conn(f.impl), 'acme/api');
  assert.ok(r.ok && r.data[0].sha === 'abc' && r.data[0].author === 'Ada');
});

test('listPulls shapes head/base refs', async () => {
  const f = fakeFetch(() => ({ status: 200, body: [{ number: 9, title: 't', state: 'open', head: { ref: 'feat' }, base: { ref: 'main' } }] }));
  const r = await listPulls(conn(f.impl), 'acme/api');
  assert.ok(r.ok && r.data[0].head === 'feat' && r.data[0].base === 'main');
});

test('health: GET /user 2xx → connected with login; 401 → honest not-connected (never fake green)', async () => {
  const up = fakeFetch(() => ({ status: 200, body: { login: 'ada' } }));
  assert.deepEqual(await githubHealth(conn(up.impl)), { connected: true, detail: 'authenticated as ada' });
  const bad = fakeFetch(() => ({ status: 401 }));
  const h = await githubHealth(conn(bad.impl));
  assert.ok(!h.connected && /unauthorized/.test(h.reason ?? ''));
});

test('honest failure: a thrown network error degrades to { ok:false, unreachable }, never throws', async () => {
  const impl = (async () => { throw new Error('boom'); }) as typeof fetch;
  const r = await listRepos({ baseUrl: 'https://api.github.com', token: TOKEN, fetchImpl: impl });
  assert.ok(!r.ok && r.reason === 'unreachable');
});

test('no token ⇒ no Authorization header sent (honest auth failure, not a broken header)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: [] }));
  await listRepos({ baseUrl: 'https://api.github.com', fetchImpl: f.impl });
  assert.equal((f.calls[0].init.headers as Record<string, string>).authorization, undefined);
});
