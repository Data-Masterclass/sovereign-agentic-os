/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:      The MCP consent page cannot be framed
 * USER STORY:   As a user, no other page can embed the "Connect" consent screen and trick me into approving.
 * ARCHITECTURE: Unit test of CONSENT_PAGE_HEADERS + a tripwire that every HTML response of the authorize route uses it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CONSENT_PAGE_HEADERS } from '@core/auth/consent-headers';

const ROUTE = resolve(dirname(fileURLToPath(import.meta.url)), '../../app/(entry)/oauth/authorize/route.ts');

test('consent headers forbid every framing ancestor', () => {
  assert.equal(CONSENT_PAGE_HEADERS['x-frame-options'], 'DENY');
  assert.match(CONSENT_PAGE_HEADERS['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(CONSENT_PAGE_HEADERS['cache-control'], 'no-store');
});

test('every HTML response of /oauth/authorize carries the consent headers', () => {
  const src = readFileSync(ROUTE, 'utf8');
  const html = src.match(/new NextResponse\([^;]*?\{[^}]*headers:[^}]*\}/gs) ?? [];
  assert.ok(html.length >= 2, 'consent page + error page');
  for (const h of html) assert.match(h, /headers:\s*CONSENT_PAGE_HEADERS/, h.slice(0, 120));
});

test('negative twin: a bare html header set (the pre-fix shape) fails the tripwire', () => {
  const pre = "return new NextResponse(x, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });";
  const html = pre.match(/new NextResponse\([^;]*?\{[^}]*headers:[^}]*\}/gs) ?? [];
  assert.equal(html.length, 1);
  assert.doesNotMatch(html[0], /headers:\s*CONSENT_PAGE_HEADERS/);
});
