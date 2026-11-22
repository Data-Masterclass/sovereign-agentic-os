/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Home layout — chat first, golden-path tiles compact but still routing
 * USER STORY: As a user I want a big chat on Home and the tiles still one click away.
 * ARCHITECTURE: the pure launcher plus a source-text tripwire on the page (a `.tsx` page cannot be
 *             imported under node --test).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launcherFor } from '@tabs/home/lib/launcher';

const OSUI = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p: string) => readFileSync(resolve(OSUI, p), 'utf8');

test('the tiles still route: every golden path keeps its exact tab and deep link', () => {
  const hrefs = Object.fromEntries(launcherFor('creator').map((c) => [c.id, c.href]));
  assert.deepEqual(hrefs, {
    data: '/data?from=home&action=create',
    files: '/unstructured?from=home&action=create',
    knowledge: '/knowledge?from=home&action=create',
    connections: '/connections', // Builder-gated: explore only, no create action
    metrics: '/metrics?from=home&action=create',
    dashboards: '/dashboards?from=home&action=create',
    agents: '/agents?from=home&action=create',
    workflows: '/workflows?from=home&action=create',
    software: '/software?from=home&action=create',
  });
});

test('NEGATIVE TWIN: a dimmed tile never carries a create action', () => {
  for (const c of launcherFor('creator').filter((x) => !x.canAct)) assert.doesNotMatch(c.href, /action=/);
});

test('Home renders the chat first and the launcher in its compact form', () => {
  const page = read('app/page.tsx');
  assert.match(page, /HomeChat/);
  assert.match(page, /<HomeLauncher[^>]*compact/);
  assert.ok(page.indexOf('<HomeChat') < page.indexOf('<HomeLauncher'), 'chat precedes the tiles');
  const tile = read('tabs/home/ui/HomeLauncher.tsx');
  assert.match(tile, /href=\{c\.href\}/, 'the tile still links to the card href');
});

test('the chat shell talks to the governed assistant route only, and renders no model markup', () => {
  const ui = read('tabs/home/ui/HomeChat.tsx');
  assert.match(ui, /\/api\/assistant\/chat/);
  assert.match(ui, /\/api\/assistant\/confirm/);
  assert.doesNotMatch(ui, /dangerouslySetInnerHTML|eval\(|new Function/);
});
