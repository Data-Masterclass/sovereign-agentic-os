/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:      Tests for same-origin enforcement (refusals + their still-working twins)
 * USER STORY:   As a user, cross-origin writes as me are refused while the OS UI, bearer MCP clients and OAuth callbacks keep working.
 * ARCHITECTURE: Unit tests of core/kernel/same-origin.ts verdicts over real Headers objects.
 */
/**
 * Same-origin enforcement for cookie-authenticated API requests. Each refusal has a
 * negative twin that must keep working: same-origin UI calls, bearer MCP/API calls,
 * OAuth callbacks, and cookie-less server-to-server calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalApiPath, checkSameOrigin, needsSameOriginCheck, parseOriginList, requestOriginOf } from '@core/kernel/same-origin';

const OS = 'https://agentic.datamasterclass.com';
const APP = 'https://x.apps.agentic.datamasterclass.com';

function req(
  method: string,
  pathname: string,
  headers: Record<string, string>,
  opts: { cookie?: boolean; osPublicUrl?: string; aliases?: string[]; requestOrigin?: string } = {},
) {
  return checkSameOrigin({
    method,
    pathname,
    headers: new Headers(headers),
    hasSessionCookie: opts.cookie ?? true,
    osPublicUrl: opts.osPublicUrl ?? OS,
    osPublicUrlAliases: opts.aliases ?? [],
    requestOrigin: opts.requestOrigin ?? OS,
  });
}

// ---------------------------------------------------------------- refused

test('REFUSED: credentialed POST from an apps subdomain', () => {
  const v = req('POST', '/api/governance/approvals/decide', { origin: APP, 'sec-fetch-site': 'same-site' });
  assert.equal(v.ok, false);
});

test('REFUSED: apps-subdomain Origin even without Fetch Metadata (older browser)', () => {
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(req(m, '/api/software/deploy', { origin: APP }).ok, false, m);
  }
});

test('REFUSED: cookie but NO Origin and NO Referer', () => {
  const v = req('POST', '/api/platform-admin/settings', {});
  assert.equal(v.ok, false);
  assert.equal((v as { reason: string }).reason, 'request origin missing');
});

test('REFUSED: look-alike origins', () => {
  for (const o of [
    'https://agentic.datamasterclass.com.evil.example',
    'https://evil-agentic.datamasterclass.com',
    'http://agentic.datamasterclass.com',
    'https://agentic.datamasterclass.com:8443',
    'null',
  ]) {
    assert.equal(req('POST', '/api/data/datasets', { origin: o }).ok, false, o);
  }
});

test('REFUSED: apps-subdomain Referer when Origin is absent', () => {
  assert.equal(req('DELETE', '/api/files/f1', { referer: `${APP}/page` }).ok, false);
});

test('REFUSED: cross-site / same-site Fetch Metadata wins over a forged-looking Origin', () => {
  assert.equal(req('POST', '/api/data/datasets', { origin: OS, 'sec-fetch-site': 'same-site' }).ok, false);
  assert.equal(req('POST', '/api/data/datasets', { origin: OS, 'sec-fetch-site': 'cross-site' }).ok, false);
});

test('REFUSED: admin GET from an apps subdomain (reads are checked on admin routes)', () => {
  assert.equal(req('GET', '/api/platform-admin/settings', { origin: APP, 'sec-fetch-site': 'same-site' }).ok, false);
  assert.equal(req('GET', '/api/platform-admin/settings', {}).ok, false);
  assert.equal(req('GET', '/api/admin/anything', { referer: `${APP}/` }).ok, false);
});

test("REFUSED: Sec-Fetch-Site 'none' never authorises a write", () => {
  assert.equal(req('POST', '/api/data/datasets', { 'sec-fetch-site': 'none' }).ok, false);
});

// ---------------------------------------------------------------- still working

test('WORKS: same-origin UI POST (Origin = OS)', () => {
  assert.equal(req('POST', '/api/data/datasets', { origin: OS, 'sec-fetch-site': 'same-origin' }).ok, true);
  assert.equal(req('POST', '/api/data/datasets', { origin: OS }).ok, true);
});

test('WORKS: same-origin admin GET (Chrome omits Origin on same-origin GET; Fetch Metadata / Referer prove it)', () => {
  assert.equal(req('GET', '/api/platform-admin/settings', { 'sec-fetch-site': 'same-origin' }).ok, true);
  assert.equal(req('GET', '/api/platform-admin/settings', { referer: `${OS}/platform/settings` }).ok, true);
});

test('WORKS: bearer MCP / API client (no session cookie)', () => {
  assert.equal(
    req('POST', '/api/mcp', { authorization: 'Bearer tok', 'content-type': 'application/json' }, { cookie: false }).ok,
    true,
  );
  assert.equal(req('POST', '/api/mcp', {}, { cookie: false }).ok, true);
});

test('WORKS: bearer client that also happens to hold a cookie (Authorization needs a CORS preflight cross-origin)', () => {
  assert.equal(req('POST', '/api/mcp', { authorization: 'Bearer tok' }).ok, true);
});

test('WORKS: OAuth callbacks are top-level GET navigations from the provider', () => {
  for (const p of ['/api/connections/oauth/github/callback', '/api/connections/notion/callback']) {
    assert.equal(req('GET', p, { 'sec-fetch-site': 'cross-site', referer: 'https://github.com/' }).ok, true, p);
  }
  assert.equal(needsSameOriginCheck('GET', '/api/connections/oauth/github/callback'), false);
});

test('WORKS: non-admin GET is not checked (CORS withholds cross-origin responses)', () => {
  assert.equal(req('GET', '/api/auth/me', { origin: APP }).ok, true);
});

test('REFUSED: an Origin that only matches the request host / X-Forwarded-Host (OS_PUBLIC_URL is configured)', () => {
  // The forwarded host is request data, not configuration: it never widens the allowed set.
  assert.equal(
    req('GET', '/api/metrics/alerts/run', { origin: 'https://evil.example' }, { requestOrigin: 'https://evil.example' }).ok,
    false,
  );
  assert.equal(
    req('POST', '/api/data/datasets', { origin: 'http://os-ui:3000' }, { requestOrigin: 'http://os-ui:3000' }).ok,
    false,
  );
});

test('WORKS: an in-cluster client that states the configured public origin', () => {
  assert.equal(
    req('GET', '/api/metrics/alerts/run', { origin: OS }, { requestOrigin: 'http://os-ui:3000' }).ok,
    true,
  );
});

test('WORKS: a configured alias host (OS_PUBLIC_URL_ALIASES); a look-alike of it is refused', () => {
  const alias = 'https://os.agentic.datamasterclass.com';
  assert.equal(req('POST', '/api/data/datasets', { origin: alias }, { aliases: [alias] }).ok, true);
  assert.equal(req('POST', '/api/data/datasets', { origin: alias }).ok, false, 'not configured → refused');
  assert.equal(
    req('POST', '/api/data/datasets', { origin: 'https://os.agentic.datamasterclass.com.evil.example' }, { aliases: [alias] }).ok,
    false,
  );
});

test('WORKS: local dev with no OS_PUBLIC_URL falls back to the request origin', () => {
  assert.equal(
    req('POST', '/api/data/datasets', { origin: 'http://localhost:3000' }, { osPublicUrl: '', requestOrigin: 'http://localhost:3000' }).ok,
    true,
  );
  assert.equal(
    req('POST', '/api/data/datasets', { origin: APP }, { osPublicUrl: '', requestOrigin: 'http://localhost:3000' }).ok,
    false,
  );
});

test('scope: only /api/ is checked; OPTIONS never reaches the check', () => {
  assert.equal(needsSameOriginCheck('POST', '/signin'), false);
  assert.equal(needsSameOriginCheck('OPTIONS', '/api/data/datasets'), false);
  assert.equal(needsSameOriginCheck('POST', '/api/data/datasets'), true);
  assert.equal(needsSameOriginCheck('GET', '/api/platform-admin'), true);
  assert.equal(needsSameOriginCheck('GET', '/api/platform-administrator'), false);
});

test('requestOriginOf ignores X-Forwarded-Host / -Proto (request data is never configuration)', () => {
  const u = new URL('http://localhost:3000/api/x');
  assert.equal(
    requestOriginOf(u, new Headers({ 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' })),
    'http://localhost:3000',
  );
});

// ---------------------------------------------------------------- audited state-changing GETs

test('REFUSED: state-changing / credential-minting GETs from an apps subdomain', () => {
  for (const p of [
    '/api/metrics/alerts/run',
    '/api/mcp/token',
    '/api/connections/oauth/github/authorize',
    '/api/connections/notion/authorize',
  ]) {
    assert.equal(req('GET', p, { origin: APP, 'sec-fetch-site': 'same-site' }).ok, false, p);
    assert.equal(req('GET', p, {}).ok, false, `${p} (no provenance)`);
  }
});

test('WORKS: the same GETs from the OS UI, and the alert cron with its Origin', () => {
  for (const p of ['/api/metrics/alerts/run', '/api/mcp/token', '/api/connections/notion/authorize']) {
    assert.equal(req('GET', p, { 'sec-fetch-site': 'same-origin' }).ok, true, p);
  }
  // The CronJob calls the in-cluster URL but states the configured public origin.
  assert.equal(
    req('GET', '/api/metrics/alerts/run', { origin: OS }, { requestOrigin: 'http://os-ui:3000' }).ok,
    true,
  );
});

test('the OAuth callbacks and the e-mail verify link stay unchecked GETs (cross-site by design)', () => {
  for (const p of ['/api/connections/oauth/github/callback', '/api/connections/notion/callback', '/api/auth/verify']) {
    assert.equal(needsSameOriginCheck('GET', p), false, p);
  }
});

// ---------------------------------------------------------------- tool proxy writes

test('REFUSED: a cookie-carrying write through the tool proxy from an apps subdomain', () => {
  assert.equal(req('POST', '/tools/dagster/graphql', { origin: APP }).ok, false);
  assert.equal(req('POST', '/tools/dagster/graphql', { origin: OS }).ok, true);
  assert.equal(needsSameOriginCheck('GET', '/tools/dagster/'), false);
});

// ---------------------------------------------------------------- path tricks

test('path spellings of admin routes are judged as the admin route', () => {
  for (const p of [
    '/API/platform-admin/settings',
    '/Api/Platform-Admin/settings',
    '/api//platform-admin/settings',
    '/api/platform-admin%2Fsettings',
    '/api/platform-admin%2fsettings',
    '/api%2Fplatform-admin/settings',
    '/api/platform-admin%5Csettings',
  ]) {
    assert.equal(needsSameOriginCheck('GET', p), true, p);
    assert.equal(req('GET', p, { origin: APP }).ok, false, p);
  }
  assert.equal(canonicalApiPath('/API//platform-admin%2Fx'), '/api/platform-admin/x');
});

// ---------------------------------------------------------------- MCP consent (outside /api/)

test('REFUSED: the MCP consent POST at /oauth/authorize from an apps subdomain or with no provenance', () => {
  assert.equal(req('POST', '/oauth/authorize', { origin: APP, 'sec-fetch-site': 'same-site' }).ok, false);
  assert.equal(req('POST', '/oauth/authorize', {}).ok, false);
  assert.equal(req('POST', '/OAUTH/authorize', { origin: APP }).ok, false);
});

test('WORKS: the consent POST from the OS consent page; the token endpoint (no cookie) is untouched', () => {
  assert.equal(req('POST', '/oauth/authorize', { origin: OS, 'sec-fetch-site': 'same-origin' }).ok, true);
  assert.equal(req('POST', '/oauth/token', {}, { cookie: false }).ok, true);
  assert.equal(needsSameOriginCheck('POST', '/oauth/token'), false);
  assert.equal(needsSameOriginCheck('GET', '/oauth/authorize'), false);
});

test('parseOriginList keeps http(s) origins only, canonicalised', () => {
  assert.deepEqual(
    parseOriginList(' https://os.agentic.datamasterclass.com/ ,https://Agentic.datamasterclass.com,ftp://x,not a url,'),
    ['https://os.agentic.datamasterclass.com', 'https://agentic.datamasterclass.com'],
  );
  assert.deepEqual(parseOriginList(''), []);
  assert.deepEqual(parseOriginList(undefined), []);
});
