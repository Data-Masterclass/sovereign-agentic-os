/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       admin
 * FEATURE:    "Register" says it only marked this OS as registered; nothing was sent anywhere
 * USER STORY: As a platform admin I want the marketplace "Register" result to say that it was
 *             recorded in this OS only and that no external marketplace was called, so I do not
 *             tell a partner we are listed when no request ever left the OS.
 * ARCHITECTURE:
 *   - `registerMarketplace` sets a flag on the OS's own record and calls no external service.
 *     The words for that live in `plugins.ts` (`REGISTRATION_NOTE`), which the page shows; the
 *     page is read as text (a test cannot import a `.tsx`).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@core/kernel/config';
import { _reset, registerMarketplace } from '@tabs/admin/lib/plugins';

beforeEach(() => _reset());

test('register records a note that no external marketplace call was made', () => {
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (u: string | URL | Request) => { urls.push(String(u instanceof Request ? u.url : u)); return new Response('{}'); }) as typeof fetch;
  try {
    const reg = registerMarketplace({ partnerId: 'p-123' }) as { note?: string };
    // The only request is the OS's own durable mirror write; nothing goes to a marketplace.
    assert.deepEqual(urls.filter((u) => !u.startsWith(config.opensearchUrl)), [], 'no request leaves the OS');
    assert.match(String(reg.note), /Marked as registered in this OS; no external marketplace call was made/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the page no longer claims it registered with the external marketplace', () => {
  const page = readFileSync(join(process.cwd(), 'app/(govern)/platform/plugins/page.tsx'), 'utf8');
  assert.doesNotMatch(page, /Registered with the external STACKIT marketplace/);
  assert.match(page, /REGISTRATION_NOTE/);
  const route = readFileSync(join(process.cwd(), 'app/api/platform-admin/plugins/route.ts'), 'utf8');
  assert.doesNotMatch(route, /Registered external STACKIT marketplace listing/, 'the audit detail says what happened too');
});
