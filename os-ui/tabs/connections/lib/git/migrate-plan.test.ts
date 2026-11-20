/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    WP-50 — the DRY-RUN plan that moves existing live connection records into git
 * USER STORY: As an operator I want to see, before anything is written, which files every domain
 *             repository would gain from the existing connection records, and which records cannot
 *             be moved and why — with no way for the plan itself to write.
 * ARCHITECTURE: node:test against the real module (and a real temp git repo where it commits); no mocks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionsFromJson, planConnectionsMigration } from '@tabs/connections/lib/git/migrate-plan';

const rec = (id: string, domain: string, catalog: string, config: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  id, name: id, template: 'warehouse', owner: 'o@example.com', domain, visibility: 'domain', archived: false,
  secretRef: { name: `conn-${id}`, key: 'password' }, warehouse: { platform: 'postgresql', catalog, config }, ...extra,
});

test('reads an array, a search response, or { _source } hits', () => {
  const a = rec('c1', 'sales', 'pg_a', { host: 'h', database: 'd', username: 'u' });
  assert.equal(connectionsFromJson(JSON.stringify([a])).length, 1);
  assert.equal(connectionsFromJson(JSON.stringify({ hits: { hits: [{ _source: a }] } })).length, 1);
});

test('plans files per domain, and lists every record it cannot move with the reason', () => {
  const plan = planConnectionsMigration([
    rec('c1', 'sales', 'pg_a', { host: 'h', database: 'd', username: 'u' }),
    rec('c2', 'sales', 'pg_bad', { host: '', database: 'd', username: 'u' }),
    rec('c3', 'finance', 'pg_f', { host: 'h', database: 'd', username: 'u' }),
    { ...rec('c4', 'sales', 'x', {}), template: 'gdrive', warehouse: undefined },
  ]);
  const sales = plan.domains.find((d) => d.domain === 'sales')!;
  assert.deepEqual(sales.files.filter((f) => f.endsWith('catalog.properties')), ['connections/pg_a/catalog.properties']);
  assert.deepEqual(plan.refused.map((r) => r.id), ['c2']);
  assert.match(plan.refused[0].reason, /pg_bad/);
  assert.deepEqual(plan.notCatalogs, ['c4']);
  assert.ok(plan.domains.some((d) => d.domain === 'finance'));
  assert.equal(plan.mode, 'dry-run');
});
