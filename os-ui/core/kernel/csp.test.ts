/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:      OS pages carry a CSP that forbids cross-origin images and media
 * USER STORY:   As a user, my browser refuses to load images/media from other sites on OS pages.
 * ARCHITECTURE: Unit tests of core/kernel/csp.ts + a tripwire that middleware.ts sets the headers
 *               through `finish` on page responses and skips the tool proxy / API / OAuth paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_CSP_ENFORCED, pageCspAppliesTo, pageCspHeaders, pageCspReportOnly } from '@core/kernel/csp';

const OSUI = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const directive = (policy: string, name: string): string | undefined =>
  policy.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `));

test('the enforced policy restricts img-src and media-src to self, data: and blob:', () => {
  assert.equal(directive(PAGE_CSP_ENFORCED, 'img-src'), "img-src 'self' data: blob:");
  assert.equal(directive(PAGE_CSP_ENFORCED, 'media-src'), "media-src 'self' data: blob:");
  // Nothing else is enforced tonight — scripts/styles/frames stay report-only.
  assert.equal(directive(PAGE_CSP_ENFORCED, 'script-src'), undefined);
  assert.equal(directive(PAGE_CSP_ENFORCED, 'frame-ancestors'), undefined);
  assert.doesNotMatch(PAGE_CSP_ENFORCED, /https?:|\*/);
});

test('headers: enforced + report-only', () => {
  const h = pageCspHeaders('apps.example.com');
  assert.equal(h['Content-Security-Policy'], PAGE_CSP_ENFORCED);
  const ro = h['Content-Security-Policy-Report-Only'];
  assert.equal(directive(ro, 'frame-ancestors'), "frame-ancestors 'self'");
  assert.equal(directive(ro, 'connect-src'), "connect-src 'self'");
  assert.equal(directive(ro, 'frame-src'), "frame-src 'self' https://*.apps.example.com");
  // A malformed apps domain never injects into the policy.
  assert.equal(directive(pageCspReportOnly("x; script-src *"), 'frame-src'), "frame-src 'self'");
});

test('applies to pages, never to the tool proxy, API or OAuth routes', () => {
  for (const p of ['/', '/knowledge', '/agents/x', '/signin', '/platform/settings']) assert.equal(pageCspAppliesTo(p), true, p);
  for (const p of ['/tools/litellm/', '/tools/langfuse/project/x', '/api/files/1/raw', '/api/apps/runtime/a', '/oauth/authorize', '/.well-known/oauth-authorization-server', '/_next/data/x.json']) {
    assert.equal(pageCspAppliesTo(p), false, p);
  }
});

test('middleware.ts sets the page CSP on its responses', () => {
  const src = readFileSync(join(OSUI, 'middleware.ts'), 'utf8');
  assert.match(src, /from '@core\/kernel\/csp'/);
  assert.match(src, /pageCspAppliesTo\(pathname\)\s*\?\s*pageCspHeaders\(/);
  // Applied inside `finish`, which every page response (next / redirect) goes through.
  const finish = src.slice(src.indexOf('const finish ='), src.indexOf('const withCors ='));
  assert.match(finish, /res\.headers\.set\(k, v\)/);
});
