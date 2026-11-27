/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:      The login route reports a session cookie the browser will drop — one log line + a sessionWarning
 * USER STORY:   As an operator on http://<server>:8080, sign-in tells me why it bounces and the os-ui log names the fix.
 * ARCHITECTURE: Route test of app/api/auth/login with the user directory mocked (core/kernel/auth); production mode,
 *               so the session cookie is Secure like a real install.
 */
import { test, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'production';
delete process.env.OS_SESSION_COOKIE_INSECURE;
process.env.OS_SESSION_SECRET = process.env.OS_SESSION_SECRET || 'test-session-secret-0123456789abcdef0123456789';

const USER = { id: 'maya', name: 'Maya', role: 'builder', domains: ['ops'] };
// Keep every other export of the auth module (route helpers import them); only the directory lookup is faked.
const realAuth = await import('@core/kernel/auth');
mock.module('@core/kernel/auth', { namedExports: { ...realAuth, authenticate: async () => USER } });

const { POST } = await import('@/app/api/auth/login/route');
const { resetSessionTransportWarnings } = await import('@core/kernel/session-transport');

const warned: string[] = [];
const realWarn = console.warn;
console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(' ')); };
after(() => { console.warn = realWarn; });
beforeEach(() => { warned.length = 0; resetSessionTransportWarnings(); });

let n = 0;
function login(headers: Record<string, string>, url = 'http://10.0.0.5:8080/api/auth/login') {
  n += 1;
  return POST(new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.9.${n}`, ...headers },
    body: JSON.stringify({ username: `maya${n}`, password: 'pw' }),
  }));
}

test('http://<server>:8080 → 200 with sessionWarning insecureHttp, a Secure cookie, and ONE warning line', async () => {
  const res = await login({ origin: 'http://10.0.0.5:8080' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.sessionWarning, { kind: 'insecureHttp', origin: 'http://10.0.0.5:8080' });
  assert.match(res.headers.get('set-cookie') ?? '', /__Host-soa_session=[^;]+;.*Secure/i, 'the cookie is still set (Secure)');
  const lines = warned.filter((l) => l.includes('[auth] WARN'));
  assert.equal(lines.length, 1, warned.join('\n'));
  assert.match(lines[0], /osUI\.insecureSessionCookie=true/);
  // A second attempt from the same origin does not flood the log.
  await login({ origin: 'http://10.0.0.5:8080' });
  assert.equal(warned.filter((l) => l.includes('[auth] WARN')).length, 1);
});

test('twin: the same server behind a TLS reverse proxy → no warning, no sessionWarning', async () => {
  const res = await login({ origin: 'https://os.example.com', 'x-forwarded-proto': 'https' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal('sessionWarning' in body, false);
  assert.equal(warned.length, 0);
});

test('twin: http://localhost:8080 (the laptop install) → no warning', async () => {
  const res = await login({ origin: 'http://localhost:8080' }, 'http://localhost:8080/api/auth/login');
  assert.equal('sessionWarning' in (await res.json()), false);
  assert.equal(warned.length, 0);
});
