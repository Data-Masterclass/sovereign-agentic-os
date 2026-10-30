/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    The tenant-connector registries are admin-only and every one of them is reachable
 * USER STORY: As a platform admin I want the three registries of what this tenant admits to be
 *             listed on Connections and to actually open, and as a creator I want never to be
 *             shown a tile I cannot use.
 * ARCHITECTURE:
 *   - Guards REGISTRIES (tabs/connections/lib/registries.ts): three rows, all minRole 'admin',
 *     unique ids, and each href matched against the app-router routes that really exist, so a
 *     renamed or deleted route fails here instead of 404-ing an admin.
 *   - Route discovery walks app/ for directories holding a page.tsx and strips the invisible
 *     (group) segments, which is exactly how Next.js derives the URL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { REGISTRIES } from '@tabs/connections/lib/registries';

/** Every app-router route that exists on disk, as its public URL path. */
function appRoutes(dir: string, route = ''): string[] {
  const out: string[] = [];
  if (existsSync(join(dir, 'page.tsx')) || existsSync(join(dir, 'page.ts'))) out.push(route || '/');
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    // A (group) segment is organisational and never appears in the URL.
    const seg = /^\(.*\)$/.test(e.name) ? '' : `/${e.name}`;
    out.push(...appRoutes(join(dir, e.name), route + seg));
  }
  return out;
}

test('REGISTRIES: all three are admin-only', () => {
  assert.equal(REGISTRIES.length, 3);
  assert.deepEqual(
    REGISTRIES.map((r) => r.id).sort(),
    ['mcp-apis', 'oauth-apps', 'plugins'],
  );
  for (const r of REGISTRIES) assert.equal(r.minRole, 'admin', `${r.id} is not admin-only`);
});

test('REGISTRIES: ids are unique', () => {
  assert.equal(new Set(REGISTRIES.map((r) => r.id)).size, REGISTRIES.length);
});

test('REGISTRIES: every href is absolute and points at a route that exists', () => {
  const routes = new Set(appRoutes('app'));
  for (const r of REGISTRIES) {
    assert.ok(r.href.startsWith('/'), `${r.id} href is not absolute: ${r.href}`);
    assert.ok(routes.has(r.href), `${r.id} href ${r.href} has no page in app/`);
  }
});

test('REGISTRIES: each row carries a label and a one-line explanation', () => {
  for (const r of REGISTRIES) {
    assert.ok(r.label.length > 0, `${r.id} has no label`);
    assert.ok(r.sub.length > 0, `${r.id} has no sub`);
  }
});
