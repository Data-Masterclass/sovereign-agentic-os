/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:      Tests for the "session cookie will not stick" verdict and its single log line
 * USER STORY:   As an operator on http://<server>:8080, I get told why sign-in bounces, with the fix, instead of a silent reload.
 * ARCHITECTURE: Unit tests of core/kernel/session-transport.ts (pure) and core/auth/signin-session.ts (the page's message pick).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  diagnoseSessionTransport,
  isLoopbackHost,
  LOG_ORIGIN_MAX,
  resetSessionTransportWarnings,
  sessionTransportLogLine,
  WARN_MAX_PER_WINDOW,
  warnSessionTransport,
  type SessionTransportInput,
} from '@core/kernel/session-transport';
import { cookieNotKept, sessionProblem } from '@core/auth/signin-session';

const base: SessionTransportInput = {
  secureCookie: true,
  origin: null,
  forwardedProto: null,
  requestUrl: 'http://10.0.0.5:8080/api/auth/login',
  osPublicUrl: '',
  osPublicUrlAliases: '',
};

beforeEach(() => resetSessionTransportWarnings());

test('plain HTTP on a server IP with a Secure cookie → insecureHttp (from the Origin header)', () => {
  const w = diagnoseSessionTransport({ ...base, origin: 'http://10.0.0.5:8080' });
  assert.deepEqual(w, { kind: 'insecureHttp', origin: 'http://10.0.0.5:8080' });
});

test('no Origin: the request URL scheme + host decide (still insecureHttp)', () => {
  assert.equal(diagnoseSessionTransport(base)?.kind, 'insecureHttp');
});

test('twin: the same request behind a TLS proxy (X-Forwarded-Proto: https) is fine', () => {
  assert.equal(diagnoseSessionTransport({ ...base, forwardedProto: 'https' }), null);
  assert.equal(diagnoseSessionTransport({ ...base, forwardedProto: 'https, http' }), null, 'first hop wins');
});

test('twin: the Origin header beats X-Forwarded-Proto (the browser is on https)', () => {
  assert.equal(diagnoseSessionTransport({ ...base, origin: 'https://os.example.com', forwardedProto: 'http' }), null);
});

test('twin: the browser really is on http even if a proxy claims https → still insecureHttp', () => {
  assert.equal(diagnoseSessionTransport({ ...base, origin: 'http://os.example.com', forwardedProto: 'https' })?.kind, 'insecureHttp');
});

test('twin: localhost / 127.x / ::1 over http are not flagged (browsers keep Secure cookies there)', () => {
  for (const o of ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080', 'http://os.localhost:8080']) {
    assert.equal(diagnoseSessionTransport({ ...base, origin: o }), null, o);
  }
  assert.equal(isLoopbackHost('127.10.0.1'), true);
  assert.equal(isLoopbackHost('localhost.example.com'), false);
  assert.equal(isLoopbackHost('10.0.0.5'), false);
});

test('twin: insecure cookie opted in (OS_SESSION_COOKIE_INSECURE) → plain HTTP is not flagged', () => {
  assert.equal(diagnoseSessionTransport({ ...base, secureCookie: false, origin: 'http://10.0.0.5:8080' }), null);
});

test('origin not publicUrl nor an alias → originMismatch; publicUrl or an alias → fine', () => {
  const cfg = { ...base, osPublicUrl: 'https://os.example.com/', osPublicUrlAliases: 'https://os2.example.com' };
  assert.deepEqual(diagnoseSessionTransport({ ...cfg, origin: 'https://other.example.com' }), {
    kind: 'originMismatch',
    origin: 'https://other.example.com',
    publicUrl: 'https://os.example.com',
  });
  assert.equal(diagnoseSessionTransport({ ...cfg, origin: 'https://os.example.com' }), null);
  assert.equal(diagnoseSessionTransport({ ...cfg, origin: 'https://OS2.example.com' }), null, 'case-insensitive host');
});

test('twin: no Origin header → never an originMismatch (a proxy-rewritten Host is no evidence)', () => {
  const cfg = { ...base, osPublicUrl: 'https://os.example.com', requestUrl: 'http://os-ui:3000/api/auth/login', forwardedProto: 'https' };
  assert.equal(diagnoseSessionTransport(cfg), null);
});

test('twin: no publicUrl configured (local dev) → no origin check', () => {
  assert.equal(diagnoseSessionTransport({ ...base, origin: 'https://anything.example.com' }), null);
});

test('the log line names the fix: HTTPS / X-Forwarded-Proto / publicUrl / insecureSessionCookie (not for production)', () => {
  const line = sessionTransportLogLine({ kind: 'insecureHttp', origin: 'http://10.0.0.5:8080' });
  for (const s of ['WARN', 'http://10.0.0.5:8080', 'HTTPS', 'X-Forwarded-Proto', 'osUI.publicUrl', 'osUI.insecureSessionCookie=true', 'OS_SESSION_COOKIE_INSECURE', 'non-production']) {
    assert.ok(line.includes(s), `missing ${s}: ${line}`);
  }
  assert.equal(line.includes('\n'), false, 'one line');
  const m = sessionTransportLogLine({ kind: 'originMismatch', origin: 'https://a.example', publicUrl: 'https://b.example' });
  for (const s of ['https://a.example', 'https://b.example', 'osUI.publicUrlAliases']) assert.ok(m.includes(s), s);
});

test('one warning line per cause and origin per 10 minutes — never a flood', () => {
  const lines: string[] = [];
  const w = { kind: 'insecureHttp', origin: 'http://10.0.0.5:8080' } as const;
  assert.equal(warnSessionTransport(w, (l) => lines.push(l), 1_000), true);
  assert.equal(warnSessionTransport(w, (l) => lines.push(l), 2_000), false);
  assert.equal(warnSessionTransport({ ...w, origin: 'http://10.0.0.6:8080' }, (l) => lines.push(l), 2_000), true);
  assert.equal(warnSessionTransport(w, (l) => lines.push(l), 1_000 + 10 * 60 * 1000), true);
  assert.equal(lines.length, 3);
});

test('sign-in page message: the server verdict wins, else the page location, else the generic one', () => {
  const httpLoc = { protocol: 'http:', hostname: '10.0.0.5', origin: 'http://10.0.0.5:8080' };
  const httpsLoc = { protocol: 'https:', hostname: 'os.example.com', origin: 'https://os.example.com' };
  assert.deepEqual(sessionProblem({ kind: 'insecureHttp', origin: 'http://10.0.0.5:8080' }, httpsLoc), {
    key: 'signin.cookieNeedsHttps', params: { origin: 'http://10.0.0.5:8080' },
  });
  assert.deepEqual(sessionProblem({ kind: 'originMismatch', origin: 'https://a.example', publicUrl: 'https://b.example' }, httpsLoc), {
    key: 'signin.cookieWrongOrigin', params: { origin: 'https://a.example', publicUrl: 'https://b.example' },
  });
  assert.equal(sessionProblem(undefined, httpLoc).key, 'signin.cookieNeedsHttps', 'no server verdict, page on http');
  assert.equal(sessionProblem(undefined, { protocol: 'http:', hostname: 'localhost', origin: 'http://localhost:8080' }).key, 'signin.cookieNotKept');
  assert.equal(sessionProblem(undefined, httpsLoc).key, 'signin.cookieNotKept');
  assert.equal(sessionProblem({ kind: 'bogus', origin: 1 }, httpsLoc).key, 'signin.cookieNotKept', 'junk is ignored');
});

test('a huge origin is truncated in the log line (~200 chars), not written whole', () => {
  const host = `${'a'.repeat(60)}.`.repeat(4) + 'example.com';
  const line = sessionTransportLogLine({ kind: 'originMismatch', origin: `https://${host}`, publicUrl: 'https://os.example.com' });
  assert.ok(!line.includes(host), 'the full origin is not in the line');
  assert.ok(line.includes('…'));
  const big = sessionTransportLogLine({ kind: 'insecureHttp', origin: `http://${'b'.repeat(5000)}` });
  assert.ok(big.length < 1000 + LOG_ORIGIN_MAX, `line length ${big.length}`);
});

test('global cap: many distinct origins log at most WARN_MAX_PER_WINDOW lines + one "suppressed" line per window', () => {
  const lines: string[] = [];
  for (let i = 0; i < 100; i++) warnSessionTransport({ kind: 'insecureHttp', origin: `http://10.0.${i}.1:8080` }, (l) => lines.push(l), 5_000 + i);
  assert.equal(lines.length, WARN_MAX_PER_WINDOW + 1);
  assert.match(lines.at(-1) ?? '', /suppressed/);
  // A new window logs again.
  warnSessionTransport({ kind: 'insecureHttp', origin: 'http://10.9.9.9:8080' }, (l) => lines.push(l), 5_000 + 10 * 60 * 1000 + 1);
  assert.equal(lines.length, WARN_MAX_PER_WINDOW + 2);
});

test('cookieNotKept: only a 200 with an explicit user: null; a 500, a network error, signedOut or a user are not', () => {
  assert.equal(cookieNotKept({ ok: true }, { user: null }), true);
  assert.equal(cookieNotKept({ ok: false }, { user: null }), false, '500/503 is not a cookie problem');
  assert.equal(cookieNotKept(null, null), false, 'network error');
  assert.equal(cookieNotKept({ ok: true }, null), false, 'unreadable body');
  assert.equal(cookieNotKept({ ok: true }, {}), false, 'no explicit user field');
  assert.equal(cookieNotKept({ ok: true }, { user: null, signedOut: true }), false, 'deactivated / deleted account');
  assert.equal(cookieNotKept({ ok: true }, { user: { id: 'maya' } }), false, 'signed in');
});
