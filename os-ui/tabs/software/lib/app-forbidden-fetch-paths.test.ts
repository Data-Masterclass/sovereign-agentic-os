/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Pin `APP_FORBIDDEN_PATHS` (the routes app JavaScript may not use) with a test
 * USER STORY: As the OS I want the list of approval-deciding routes an app may not call to be the
 *             real list — every such route named, and every named route refusing an app.
 * ARCHITECTURE:
 *   - The refusal itself is `guardAppIntent(…, 'approval-decide')` in each route; this test ties
 *     the list in `app-runtime.ts` to those routes in both directions, and drives the guard with
 *     an app-minted intent to show it is refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_FORBIDDEN_PATHS } from './app-runtime.ts';
import { APP_INTENT_HEADER, APP_ORIGIN_HEADER, guardAppIntent, mintAppIntent } from '@core/kernel/app-intent';

const APP_DIR = fileURLToPath(new URL('../../../app', import.meta.url));

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === 'route.ts') out.push(full);
  }
  return out;
}

/** `app/api/governance/approvals/route.ts` → `/api/governance/approvals`. */
const urlOf = (file: string) => `/${relative(APP_DIR, file).split(sep).slice(0, -1).join('/')}`;

const decidingRoutes = routeFiles(join(APP_DIR, 'api'))
  .filter((f) => /guardAppIntent\([^)]*'approval-decide'\)/.test(readFileSync(f, 'utf8')))
  .map(urlOf)
  .sort();

test('every route that decides an approval is in APP_FORBIDDEN_PATHS', () => {
  assert.ok(decidingRoutes.length > 0, 'found the approval-deciding routes');
  assert.deepEqual([...APP_FORBIDDEN_PATHS].sort(), decidingRoutes);
});

test('every path in APP_FORBIDDEN_PATHS is a route that refuses an app intent', () => {
  for (const path of APP_FORBIDDEN_PATHS) {
    const file = join(APP_DIR, ...path.split('/').filter(Boolean), 'route.ts');
    assert.ok(existsSync(file), `${path} is a real route`);
    assert.match(readFileSync(file, 'utf8'), /guardAppIntent\([^)]*'approval-decide'\)/, `${path} guards approval-decide`);
  }
  const token = mintAppIntent({ userId: 'amir', appSlug: 'invoices', scopes: ['agent-run'] });
  const h: Record<string, string> = { [APP_INTENT_HEADER]: token, [APP_ORIGIN_HEADER]: 'app', 'sec-fetch-site': 'same-origin' };
  const verdict = guardAppIntent({ get: (n: string) => h[n.toLowerCase()] ?? null }, { id: 'amir' }, 'approval-decide');
  assert.equal(verdict.ok, false, 'an app intent never decides an approval');
});
