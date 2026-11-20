/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    WP-50 — `knowledge/**` is OS-owned in every domain repo: a push to it is refused
 * USER STORY: As a domain admin I want the shared knowledge bundle written only by the OS, because
 *             its frontmatter carries governed facts (scope, status, owner) that change only through
 *             promotion and approval — a push must never be a way around them.
 * ARCHITECTURE: the same rule as `os/`, `data/dagster/` and `connections/` (`OS_OWNED_PREFIXES` +
 *             `decidePath`). Negative twin: an ordinary shared path stays pushable for a builder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OS_OWNED_PREFIXES, decidePath, type Pusher } from '@core/infra/git-receive';
import { LAYOUT_V2 } from '@core/infra/repo-layout';

const pusher = (role: Pusher['role']): Pusher => ({ id: 'p@example.com', role, domains: ['sales'] });

test('knowledge/ is in the OS-owned prefixes', () => {
  assert.ok((OS_OWNED_PREFIXES as readonly string[]).includes('knowledge/'));
});

for (const role of ['creator', 'builder', 'domain_admin', 'admin'] as const) {
  test(`a ${role} push to knowledge/** is refused`, () => {
    for (const p of ['knowledge/index.md', 'knowledge/workflows/bank/workflow.md', 'knowledge/workflows/bank/guardrails.json', 'knowledge/manual/domain.md']) {
      const v = decidePath(p, pusher(role), { layout: LAYOUT_V2 });
      assert.equal(v.allowed, false, `${role} → ${p}`);
    }
  });
}

test('TWIN: an ordinary shared path is still pushable for a builder', () => {
  assert.equal(decidePath('data/dbt/models/gold/gold_x.sql', pusher('builder'), { layout: LAYOUT_V2 }).allowed, true);
});
