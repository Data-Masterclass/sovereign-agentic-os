/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    WP-51 — the OS publishes an authenticated clone URL only when it serves one
 * USER STORY: As an engineer I want the clone URL in every engineering view when this deployment
 *             runs the git-http door, and an honest "none" when it does not — never a guessed host.
 * ARCHITECTURE: pure inputs (`base`, `enabled`) so both halves are a measurement.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishedCloneUrl } from './git-clone-published.ts';

test('published: the https clone URL, when the git-http door is rendered', () => {
  assert.equal(publishedCloneUrl('sales', { base: 'https://os.example.com/', enabled: true }), 'https://os.example.com/git/sales.git');
  assert.equal(publishedCloneUrl('user-0123456789ab', { base: 'https://os.example.com', enabled: true }), 'https://os.example.com/git/user-0123456789ab.git');
});

test('negative twin: no git-http door, no public base, or a plain-http base publishes NOTHING', () => {
  assert.equal(publishedCloneUrl('sales', { base: 'https://os.example.com', enabled: false }), null);
  assert.equal(publishedCloneUrl('sales', { base: '', enabled: true }), null);
  assert.equal(publishedCloneUrl('sales', { base: 'http://os.example.com', enabled: true }), null, 'a token must never travel over plain http');
  assert.equal(publishedCloneUrl('../x', { base: 'https://os.example.com', enabled: true }), null);
});
