/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    WP-50 (alerts) — `metrics/alerts/**` is OS-owned in every domain repo: a push to it is refused
 * USER STORY: As an alert owner I want my alert's query written only by the OS on my behalf, because
 *             the evaluator runs it as me: a pushed edit would run someone else's query as my identity.
 * ARCHITECTURE: the same rule as `connections/` and `knowledge/` (`OS_OWNED_PREFIXES` + `decidePath`).
 *             Negative twin: an ordinary shared path stays pushable for a builder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OS_OWNED_PREFIXES, decidePath, type Pusher } from '@core/infra/git-receive';
import { LAYOUT_V2 } from '@core/infra/repo-layout';

const pusher = (role: Pusher['role']): Pusher => ({ id: 'p@example.com', role, domains: ['sales'] });

test('metrics/alerts/ is in the OS-owned prefixes', () => {
  assert.ok((OS_OWNED_PREFIXES as readonly string[]).includes('metrics/alerts/'));
});

for (const role of ['creator', 'builder', 'domain_admin', 'admin'] as const) {
  test(`a ${role} push to metrics/alerts/** is refused`, () => {
    for (const p of ['metrics/alerts/rev_low.yml', 'metrics/alerts/new_one.yml', 'metrics/alerts/README.md']) {
      const v = decidePath(p, pusher(role), { layout: LAYOUT_V2 });
      assert.equal(v.allowed, false, `${role} → ${p}`);
      assert.match(String(v.reason), /managed by the OS|MANAGED/i);
    }
  });
}

test('TWIN: an ordinary shared path is still pushable for a builder', () => {
  assert.equal(decidePath('data/dbt/models/gold/gold_x.sql', pusher('builder'), { layout: LAYOUT_V2 }).allowed, true);
});
