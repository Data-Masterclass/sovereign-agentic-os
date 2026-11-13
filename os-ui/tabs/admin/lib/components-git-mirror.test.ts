/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    The `git-mirror` row on Platform → Components & Health (Part D, checklist X2)
 * USER STORY: As a platform admin I want a mirror whose last push FAILED to be red on the health
 *             page with the domain and the reason, a configured-but-never-pushed mirror to be
 *             amber, and no row at all when the feature is off — so a remote silently falling
 *             behind is impossible.
 * ARCHITECTURE:
 *   - Pure: the route injects the signals (`core/infra/git-mirror.ts` `mirrorSignals`) and the
 *     clock. No store, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataProductsGitRow, gitMirrorRow } from '@tabs/admin/lib/components-extra';

test('the health row: absent when off or unconfigured, amber before the first push, red on failure', () => {
  assert.equal(gitMirrorRow({ enabled: false, signals: [{ domain: 'sales', url: 'https://git.example.com/a.git' }], now: 0 }), null);
  assert.equal(gitMirrorRow({ enabled: true, signals: [], now: 0 }), null);

  const amber = gitMirrorRow({ enabled: true, signals: [{ domain: 'sales', url: 'https://git.example.com/a.git' }], now: 0 })!;
  assert.equal(amber.health, 'amber');
  assert.match(amber.detail, /nothing has been pushed yet/);

  const green = gitMirrorRow({
    enabled: true,
    signals: [{ domain: 'sales', url: 'https://git.example.com/a.git', lastSha: 'a'.repeat(40), lastPushedAt: '2026-11-13T10:00:00.000Z' }],
    now: Date.parse('2026-11-13T10:01:00.000Z'),
  })!;
  assert.equal(green.health, 'green');
  assert.equal(green.at, Date.parse('2026-11-13T10:00:00.000Z'));
  assert.match(green.detail, /sales → git\.example\.com @ aaaaaaa/);

  const red = gitMirrorRow({
    enabled: true,
    signals: [
      { domain: 'sales', url: 'https://git.example.com/a.git', lastError: 'remote rejected', lastErrorAt: '2026-11-13T11:00:00.000Z' },
      { domain: 'finance', url: 'https://git.example.com/b.git', lastSha: 'b'.repeat(40), lastPushedAt: '2026-11-13T09:00:00.000Z' },
    ],
    now: Date.parse('2026-11-13T11:01:00.000Z'),
  })!;
  assert.equal(red.health, 'red');
  assert.match(red.detail, /Last push FAILED for sales/);
  assert.match(red.detail, /the next commit retries the push/);
  assert.equal(red.at, Date.parse('2026-11-13T11:00:00.000Z'));
});

test('the data-products row exists with the flag OFF and says scheduling is disabled (review M-8)', () => {
  const off = dataProductsGitRow({ enabled: false });
  assert.equal(off.id, 'data-products-git');
  assert.equal(off.state, 'off');
  assert.equal(off.health, 'amber', 'a deliberate opt-out is not a fault');
  assert.match(off.detail, /scheduling disabled/i);
  assert.match(off.detail, /Sync now/, 'it says what still works');
});

test('the data-products row is green with the flag on and names the scheduler', () => {
  const on = dataProductsGitRow({ enabled: true });
  assert.equal(on.state, 'on');
  assert.equal(on.health, 'green');
  assert.match(on.detail, /Dagster/);
  assert.match(on.detail, /os\/schedules\.yml/);
});

test('the row is never absent — that is the whole point of M-8', () => {
  for (const enabled of [true, false]) {
    const row = dataProductsGitRow({ enabled });
    assert.ok(row && row.id === 'data-products-git');
    assert.equal(row.state, enabled ? 'on' : 'off');
  }
});
