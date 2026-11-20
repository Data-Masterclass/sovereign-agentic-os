/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    WP-50 — `connections/**` is OS-owned in every domain repo: a push to it is refused
 * USER STORY: As an operator I want the Trino catalog files to be written only by the OS, because
 *             Trino loads them with access to its own environment: a pushed `connection-url` to
 *             another host with `${ENV:<any secret>}` would hand that secret to the host.
 * ARCHITECTURE: the same rule as `os/` and `data/dagster/` (`OS_OWNED_PREFIXES` + `decidePath`).
 *             Negative twin: an ordinary shared path stays pushable for a builder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OS_OWNED_PREFIXES, decidePath, type Pusher } from '@core/infra/git-receive';
import { LAYOUT_V2 } from '@core/infra/repo-layout';

const pusher = (role: Pusher['role']): Pusher => ({ id: 'p@example.com', role, domains: ['sales'] });

test('connections/ is in the OS-owned prefixes', () => {
  assert.ok((OS_OWNED_PREFIXES as readonly string[]).includes('connections/'));
});

for (const role of ['creator', 'builder', 'domain_admin', 'admin'] as const) {
  test(`a ${role} push to connections/** is refused`, () => {
    for (const p of ['connections/pg_sales/catalog.properties', 'connections/pg_sales/os.yaml', 'connections/README.md', 'connections/evil/catalog.properties']) {
      const v = decidePath(p, pusher(role), { layout: LAYOUT_V2 });
      assert.equal(v.allowed, false, `${role} → ${p}`);
      assert.match(String(v.reason), /managed by the OS|MANAGED/i);
    }
  });
}

test('TWIN: an ordinary shared path is still pushable for a builder', () => {
  assert.equal(decidePath('data/dbt/models/gold/gold_x.sql', pusher('builder'), { layout: LAYOUT_V2 }).allowed, true);
});
