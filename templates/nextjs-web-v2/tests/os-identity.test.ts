/**
 * FEATURE:    Tests of sign-in through the OS: PKCE login, callback checks, the session cookie, bearer forwarding.
 * USER STORY: As the owner of this app I want proof that sign-in cannot be completed by a page that did not start it,
 *             that the token never shows up in a URL, and that every OS call carries it as a bearer.
 * ARCHITECTURE: The login and callback routes run against a scripted OS token endpoint; no network, no real OS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET as login } from '../src/app/os/login/route.ts';
import { GET as callback } from '../src/app/os/callback/route.ts';
import { osFor } from '../src/lib/os/index.ts';
import { APP_LOGIN_COOKIE, APP_SESSION_COOKIE, needsSignIn, s256, safeNext } from '../src/lib/os/session.ts';

const ENV = { OS_PUBLIC_URL: 'https://os.example', OS_BASE_URL: 'http://os-ui.agentic-os.svc:3000', APP_DOMAIN: 'sales', APP_SLUG: 'orders', APP_ENV: 'dev' };
Object.assign(process.env, ENV);
const HOST = 'orders.sales.dev.apps.example';
const fakeJwt = ['aGVhZA', 'Ym9keQ', 'c2ln'].join('.');

function cookiesOf(res: Response): string[] {
  return (res.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
}

async function startLogin(next = '/orders?x=1') {
  const res = await login(new Request(`http://pod/os/login?next=${encodeURIComponent(next)}`, { headers: { host: HOST } }));
  const loc = new URL(res.headers.get('location') ?? '');
  const loginCookie = cookiesOf(res).find((c) => c.startsWith(`${APP_LOGIN_COOKIE}=`)) ?? '';
  return { res, loc, loginCookie: loginCookie.split(';')[0] };
}

test('login sends the browser to the OS with PKCE S256, state, nonce and the exact callback; secrets stay in an HttpOnly cookie', async () => {
  const { res, loc, loginCookie } = await startLogin();
  assert.equal(res.status, 302);
  assert.equal(`${loc.origin}${loc.pathname}`, 'https://os.example/api/auth/app-login');
  assert.equal(loc.searchParams.get('app'), 'sales/orders');
  assert.equal(loc.searchParams.get('env'), 'dev');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(loc.searchParams.get('redirect_uri'), `https://${HOST}/os/callback`);
  assert.ok((loc.searchParams.get('state') ?? '').length >= 32);
  assert.ok(!loc.toString().includes('verifier'), 'the PKCE verifier never travels in the URL');
  const set = cookiesOf(res)[0];
  assert.match(set, /HttpOnly/);
  assert.match(set, /Secure/);
  assert.match(set, /SameSite=Lax/);
  assert.doesNotMatch(set, /Domain=/i, 'host-only');
  assert.ok(loginCookie);
});

test('callback: state mismatch is refused before any OS call', async () => {
  const { loginCookie } = await startLogin();
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
  try {
    const res = await callback(new Request(`http://pod/os/callback?code=abc&state=forged-state-value`, { headers: { host: HOST, cookie: loginCookie } }));
    assert.equal(res.status, 400);
    assert.equal(called, false);
  } finally { globalThis.fetch = original; }
});

test('callback: exchanges code + verifier server-to-server, checks the nonce, sets the session cookie, never puts the token in the URL', async () => {
  const { loc, loginCookie } = await startLogin('/orders?x=1');
  const sent: { url: string; body: Record<string, string> }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    sent.push({ url: String(input), body });
    return Response.json({ access_token: fakeJwt, token_type: 'Bearer', expires_in: 900, nonce: loc.searchParams.get('nonce') });
  }) as typeof fetch;
  try {
    const res = await callback(new Request(`http://pod/os/callback?code=the-code&state=${loc.searchParams.get('state')}`, { headers: { host: HOST, cookie: loginCookie } }));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/orders?x=1');
    assert.equal(sent[0].url, 'http://os-ui.agentic-os.svc:3000/api/auth/app-token');
    assert.equal(sent[0].body.code, 'the-code');
    assert.equal(await s256(sent[0].body.code_verifier), loc.searchParams.get('code_challenge'), 'the verifier matches the challenge sent at login');
    assert.equal(sent[0].body.redirect_uri, `https://${HOST}/os/callback`);
    const session = cookiesOf(res).find((c) => c.startsWith(`${APP_SESSION_COOKIE}=`)) ?? '';
    assert.match(session, /HttpOnly; Secure; SameSite=Lax; Max-Age=870/);
    assert.ok(!(res.headers.get('location') ?? '').includes(fakeJwt));
  } finally { globalThis.fetch = original; }
});

test('callback: a nonce mismatch and an OS refusal both end without a session', async () => {
  const { loc, loginCookie } = await startLogin();
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ access_token: fakeJwt, expires_in: 900, nonce: 'someone-elses-nonce' })) as typeof fetch;
    let res = await callback(new Request(`http://pod/os/callback?code=c&state=${loc.searchParams.get('state')}`, { headers: { host: HOST, cookie: loginCookie } }));
    assert.equal(res.status, 401);
    assert.ok(!cookiesOf(res).some((c) => c.startsWith(`${APP_SESSION_COOKIE}=`)));
    globalThis.fetch = (async () => Response.json({ error: 'invalid_grant' }, { status: 400 })) as typeof fetch;
    res = await callback(new Request(`http://pod/os/callback?code=c&state=${loc.searchParams.get('state')}`, { headers: { host: HOST, cookie: loginCookie } }));
    assert.equal(res.status, 401);
  } finally { globalThis.fetch = original; }
});

test('a refused consent (error=access_denied) is 403 and no OS call', async () => {
  const { loc, loginCookie } = await startLogin();
  const res = await callback(new Request(`http://pod/os/callback?error=access_denied&state=${loc.searchParams.get('state')}`, { headers: { host: HOST, cookie: loginCookie } }));
  assert.equal(res.status, 403);
});

test('OS calls carry the session as a bearer and no cookie of the app host', async () => {
  const seen: Record<string, string>[] = [];
  const os = osFor(
    new Request('http://pod/x', { headers: { cookie: `${APP_SESSION_COOKIE}=${fakeJwt}; other=1` } }),
    ENV,
    (async (_i: RequestInfo | URL, init?: RequestInit) => { seen.push(init?.headers as Record<string, string>); return Response.json({ user: { id: 'u1' } }); }) as typeof fetch,
  );
  await os.whoami();
  assert.equal(seen[0].authorization, `Bearer ${fakeJwt}`);
  assert.equal(seen[0].cookie, undefined);
});

test('pages without a session need sign-in; the return path is same-origin only', () => {
  assert.equal(needsSignIn(new Request('http://pod/')), true);
  assert.equal(needsSignIn(new Request('http://pod/', { headers: { cookie: `${APP_SESSION_COOKIE}=${fakeJwt}` } })), false);
  assert.equal(safeNext('//evil.example/x'), '/');
  assert.equal(safeNext('https://evil.example'), '/');
  assert.equal(safeNext('/orders'), '/orders');
});
