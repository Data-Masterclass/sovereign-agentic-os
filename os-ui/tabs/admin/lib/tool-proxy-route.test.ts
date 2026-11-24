/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Route test — the /tools/<key> proxy and the short addresses obey the Tool consoles switch
 * USER STORY: As a platform admin demoing the OS I open <domain>/dagster and land in the read-only
 *             Dagster console, but only after I switched it on, only as an admin, and never without
 *             the OS sign-in. Everyone else, and everyone while it is off, sees a plain 404; a
 *             signed-out visitor is sent to sign in. The LiteLLM Model Hub stays open to every
 *             signed-in user as before.
 * ARCHITECTURE:
 *   - The REAL proxy route (`app/(entry)/tools/[tool]/[[...path]]/route.ts`), the REAL short-address
 *     routes and the REAL settings store; only the session (`requireUser`) and the network are
 *     stand-ins. Upstream fetches are recorded, so "404" also proves nothing reached the tool.
 *   - Negative twins for every positive case: off -> 404, non-admin -> 403/404, signed out ->
 *     sign-in redirect (navigation) or 401 (sub-resource).
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.DAGSTER_READONLY_URL = 'http://agentic-os-dagster-webserver-read-only:80';

type U = { id: string; name: string; domains: string[]; role: string } | null;
let USER: U = null;
mock.module('@core/kernel/auth', {
  namedExports: {
    requireUser: async () => {
      if (!USER) { const e = new Error('Not signed in'); (e as Error & { status?: number }).status = 401; throw e; }
      return USER;
    },
  },
});
// The LiteLLM admin console mints a UI session server-side; here it mints a fixed cookie.
mock.module('@core/infra/tool-sso-litellm', {
  namedExports: { hasLiteLlmSession: () => false, getLiteLlmSessionCookies: async () => ['token=minted; Path=/'] },
});

const UPSTREAM: string[] = [];
const COOKIES: (string | null)[] = [];
globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
  const url = String(u);
  if (url.includes('agentic-os-litellm') || url.includes('dagster-webserver-read-only')) {
    UPSTREAM.push(url);
    COOKIES.push(new Headers(init?.headers).get('cookie'));
    return new Response('<html>tool</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  }
  throw new TypeError('fetch failed'); // the settings mirror is unreachable in a unit test
}) as typeof fetch;

const proxyRoute = await import('@/app/(entry)/tools/[tool]/[[...path]]/route');
const dagsterShort = await import('@/app/(entry)/dagster/route');
const litellmShort = await import('@/app/(entry)/litellm/route');
const langfuseShort = await import('@/app/(entry)/langfuse/route');
const settings = await import('@tabs/admin/lib/settings');

const ADMIN = { id: 'ada', name: 'Ada', domains: [], role: 'admin' };
const BUILDER = { id: 'bob', name: 'Bob', domains: ['sales'], role: 'builder' };
const CREATOR = { id: 'cy', name: 'Cy', domains: ['sales'], role: 'creator' };

beforeEach(() => {
  settings._reset();
  USER = null;
  UPSTREAM.length = 0;
  COOKIES.length = 0;
});

const NAV = { accept: 'text/html,application/xhtml+xml', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
function call(tool: string, path: string[], headers: Record<string, string> = NAV) {
  const url = `https://os.example.test/tools/${tool}/${path.join('/')}`;
  return proxyRoute.GET(new Request(url, { headers: { host: 'os.example.test', ...headers } }), {
    params: Promise.resolve({ tool, path }),
  });
}
const on = (key: string) => settings.__setForTests({ toolConsoles: { [key]: { exposed: true } } });

/* ------------------------------------------------------------------ proxy */

test('OFF (the default): Dagster is 404 for an admin and nothing reaches the webserver', async () => {
  USER = ADMIN;
  const res = await call('dagster', []);
  assert.equal(res.status, 404);
  assert.equal(UPSTREAM.length, 0);
});

test('ON: an admin reaches the READ-ONLY webserver, with the /tools/dagster prefix kept', async () => {
  on('dagster');
  USER = ADMIN;
  const res = await call('dagster', ['runs']);
  assert.equal(res.status, 200);
  assert.deepEqual(UPSTREAM, ['http://agentic-os-dagster-webserver-read-only:80/tools/dagster/runs']);
});

test('ON: a builder and a creator get 403 from Dagster, and nothing reaches it', async () => {
  on('dagster');
  for (const u of [BUILDER, CREATOR]) {
    USER = u;
    assert.equal((await call('dagster', [])).status, 403, u.role);
  }
  assert.equal(UPSTREAM.length, 0);
});

test('signed out: a page navigation is sent to sign in, a sub-resource gets 401, Dagster is never reached', async () => {
  on('dagster');
  const nav = await call('dagster', ['runs']);
  assert.equal(nav.status, 307);
  assert.equal(nav.headers.get('location'), '/signin?next=%2Ftools%2Fdagster%2Fruns');
  const xhr = await call('dagster', ['graphql'], { accept: 'application/json' });
  assert.equal(xhr.status, 401);
  assert.equal(UPSTREAM.length, 0);
});

test('LiteLLM admin console: OFF is 404 for an admin; ON the admin gets in with the minted session', async () => {
  USER = ADMIN;
  assert.equal((await call('litellm', ['ui'])).status, 404);
  assert.equal(UPSTREAM.length, 0);
  on('litellm');
  const res = await call('litellm', ['ui']);
  assert.equal(res.status, 200);
  assert.deepEqual(UPSTREAM, ['http://agentic-os-litellm:4000/tools/litellm/ui']);
  assert.match(COOKIES[0] ?? '', /token=minted/, 'the server-minted UI session reaches LiteLLM (no second login)');
  assert.ok(res.headers.getSetCookie().some((c) => /token=minted/.test(c) && /Path=\/tools\/litellm\//.test(c)), 'and the browser keeps it, scoped to the prefix');
});

test('LiteLLM public Model Hub: no session is minted or injected for it', async () => {
  USER = CREATOR;
  await call('litellm', ['public', 'model_hub']);
  assert.doesNotMatch(COOKIES[0] ?? '', /token=minted/);
});

test('LiteLLM admin session cookie: Secure + SameSite=Strict, scoped to the prefix; NOT HttpOnly because the LiteLLM UI reads it', async () => {
  on('litellm');
  USER = ADMIN;
  const res = await call('litellm', ['ui']);
  const c = res.headers.getSetCookie().find((x) => /^token=minted/.test(x)) ?? '';
  assert.match(c, /;\s*Secure/i);
  assert.match(c, /;\s*SameSite=Strict/i);
  assert.match(c, /Path=\/tools\/litellm\//);
  // Verified in the shipped image (litellm-database 1.109.1): the dashboard's JS reads and writes
  // `token` through document.cookie, so HttpOnly would sign every admin out of the console.
  assert.doesNotMatch(c, /HttpOnly/i);
});

test('a browser still holding the admin session: a creator on the Model Hub does NOT forward it to LiteLLM', async () => {
  USER = CREATOR;
  await call('litellm', ['public', 'model_hub'], { ...NAV, cookie: 'token=stolen-admin-jwt; theme=dark' });
  assert.equal(COOKIES.length, 1);
  assert.doesNotMatch(COOKIES[0] ?? '', /token=/);
  assert.match(COOKIES[0] ?? '', /theme=dark/, 'the tool\'s other cookies still pass');
});

test('the admin session is not forwarded on Model Hub paths, even for an admin', async () => {
  USER = ADMIN;
  await call('litellm', ['public', 'model_hub'], { ...NAV, cookie: 'token=admin-jwt' });
  assert.doesNotMatch(COOKIES[0] ?? '', /token=/);
});

test('a non-admin is never proxied to a console path with the admin session (403 before anything is sent)', async () => {
  on('litellm');
  USER = BUILDER;
  const res = await call('litellm', ['ui'], { ...NAV, cookie: 'token=admin-jwt' });
  assert.equal(res.status, 403);
  assert.equal(UPSTREAM.length, 0);
});

test('a dot segment or an embedded separator is refused with 400 before anything is proxied', async () => {
  on('dagster');
  USER = ADMIN;
  for (const p of [['..', 'secret'], ['a%2Fb'.replace('%2F', '/')], ['.']]) {
    assert.equal((await call('dagster', p)).status, 400, JSON.stringify(p));
  }
  assert.equal(UPSTREAM.length, 0);
});

test('LiteLLM public Model Hub: every signed-in role keeps it while the console is OFF', async () => {
  for (const u of [CREATOR, BUILDER, ADMIN]) {
    USER = u;
    assert.equal((await call('litellm', ['public', 'model_hub'])).status, 200, u.role);
  }
  // Negative twin: the console part next to it stays shut for a creator, on or off.
  USER = CREATOR;
  assert.equal((await call('litellm', ['ui'])).status, 404);
  on('litellm');
  assert.equal((await call('litellm', ['ui'])).status, 403);
});

test('a console that cannot be served here stays 404 even with a stale ON value', async () => {
  on('langfuse');
  USER = ADMIN;
  assert.equal((await call('langfuse', [])).status, 404);
});

test('an unknown tool is 404', async () => {
  USER = ADMIN;
  assert.equal((await call('trino', [])).status, 404);
});

/* --------------------------------------------------------- short addresses */

const short = (mod: { GET: (req: Request) => Promise<Response> }, path: string) =>
  mod.GET(new Request(`https://os.example.test${path}`, { headers: { host: 'os.example.test' } }));

test('/dagster: 308 to /tools/dagster/ for an admin when ON; 404 when OFF, for a non-admin, or signed out', async () => {
  USER = ADMIN;
  assert.equal((await short(dagsterShort, '/dagster')).status, 404, 'off');
  on('dagster');
  const res = await short(dagsterShort, '/dagster');
  assert.equal(res.status, 308);
  assert.equal(res.headers.get('location'), '/tools/dagster/');
  USER = BUILDER;
  assert.equal((await short(dagsterShort, '/dagster')).status, 404, 'non-admin');
  USER = null;
  const out = await short(dagsterShort, '/dagster');
  assert.equal(out.status, 307, 'signed out is sent to sign in');
  assert.equal(out.headers.get('location'), '/signin?next=%2Fdagster');
});

test('/litellm: 308 when ON; /langfuse: 404 while its console is pending', async () => {
  USER = ADMIN;
  on('litellm');
  assert.equal((await short(litellmShort, '/litellm')).status, 308);
  on('langfuse');
  assert.equal((await short(langfuseShort, '/langfuse')).status, 404);
});
