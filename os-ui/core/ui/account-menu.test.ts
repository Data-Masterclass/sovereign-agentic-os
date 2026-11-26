/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * FEATURE:    The sidebar account menu — the home for the three personal surfaces
 * USER STORY: As a signed-in user I want My Settings, My MCP access and About/Licenses
 *             reachable from the sidebar, so that personal settings are not buried in a
 *             tenant-administration menu where they never belonged.
 * ARCHITECTURE:
 *   - Pins the contract of `ACCOUNT_ITEMS` exported from Sidebar.tsx: the three entries
 *     that left the Platform menu on 2026-10-30, in order, at the EXACT hrefs and
 *     minRoles they had there. Moving a surface must never widen access, so the roles
 *     are asserted, not just the ids.
 *   - Data-only assertion: the test imports the const, never renders the component, so it
 *     stays runnable under `node --test` with no DOM.
 *   - It imports `./account-menu.ts`, the data module Sidebar.tsx re-exports `ACCOUNT_ITEMS`
 *     from. Importing `./Sidebar.tsx` directly is impossible here: the runner strips types
 *     but not JSX (ERR_UNKNOWN_FILE_EXTENSION on .tsx), and Sidebar also imports
 *     next/navigation and an .svg, neither of which loads under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_ITEMS, shellHeadingKey } from './account-menu.ts';

test('ACCOUNT-MENU: carries the personal surfaces; My Settings is open to every user (language picker)', () => {
  assert.deepEqual(ACCOUNT_ITEMS.map((i) => [i.id, i.href, i.minRole]), [
    ['my-settings', '/settings', 'creator'],
    ['my-mcp', '/mcp', 'builder'],
    ['licenses', '/about', 'creator'],
  ]);
});

test('ACCOUNT-MENU: every item names its shell catalog key, and the headings map to keys', () => {
  assert.deepEqual(ACCOUNT_ITEMS.map((i) => i.labelKey), ['account.mySettings', 'account.myMcp', 'account.about']);
  assert.equal(shellHeadingKey('Context'), 'context');
  assert.equal(shellHeadingKey('Build'), 'build');
  assert.equal(shellHeadingKey('Manage'), 'manage');
  assert.equal(shellHeadingKey('Elsewhere'), null);
});
