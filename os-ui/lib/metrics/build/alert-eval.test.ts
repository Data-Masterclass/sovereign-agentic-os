/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Headless alert evaluation (Phase 2): a rule's value is resolved through the governed-SQL
 * path (exploreMetric) AS THE RULE'S OWNER, and classified HONESTLY — an unreachable Trino
 * SKIPS with 'unavailable' (never a fabricated value / false alarm), an un-computable metric is
 * 'pending', only a real number is 'ok'. We stub the public-user directory and inject the
 * resolver + explore so the classification + owner-identity are proven without a cluster.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { goldSales } from '../fixtures.ts';
import type { ExploreServerResult } from './explore-server.ts';

mock.module('../../platform-admin/users.ts', {
  namedExports: {
    // The rule owner 'amir' is a domain_admin in 'sales' — the headless token must carry this.
    getPublicUser: async (id: string) =>
      id === 'amir' ? { id: 'amir', name: 'Amir', domains: ['sales'], role: 'domain_admin' } : null,
  },
});
const { resolveAlertValue } = await import('./alert-eval.ts');

const dataset = goldSales();
const measure = dataset.measures[0];
const resolve = () => ({ dataset, measure });
const rule = { id: 'ds_sales.revenue', member: 'Sales.revenue', comparator: 'lt' as const, threshold: 50000, notify: ['in_app' as const], owner: 'amir', domain: 'sales', createdAt: '2026-07-31T00:00:00Z' };

function explored(over: Partial<ExploreServerResult>): ExploreServerResult {
  return { member: 'Sales.revenue', rows: [], securityContext: {}, sql: 'SELECT 1', mode: 'live (sql)', ...over };
}

test('OK: a computed number is summed and returned as the owner would see it', async () => {
  let seenPrincipal: string | undefined;
  const explore = (async (_d: unknown, _m: unknown, token: { sub: string }) => {
    seenPrincipal = token.sub;
    return explored({ rows: [{ 'Sales.revenue': 40000 }] });
  }) as unknown as Parameters<typeof resolveAlertValue>[1]['explore'];
  const r = await resolveAlertValue(rule, { resolve, explore });
  assert.deepEqual(r, { status: 'ok', value: 40000 });
  assert.equal(seenPrincipal, 'amir', 'the headless read runs AS THE OWNER (amir), not the cron-triggerer');
});

test('OK: multi-row result is summed to a single value', async () => {
  const explore = (async () => explored({ rows: [{ 'Sales.revenue': 10 }, { 'Sales.revenue': 32 }] })) as never;
  const r = await resolveAlertValue(rule, { resolve, explore });
  assert.deepEqual(r, { status: 'ok', value: 42 });
});

test('UNAVAILABLE: a Trino outage SKIPS — never a fabricated value, never a false alarm', async () => {
  const explore = (async () => explored({ rows: [], unavailable: true, mode: 'unavailable', warning: 'Trino unreachable' })) as never;
  const r = await resolveAlertValue(rule, { resolve, explore });
  assert.equal(r.status, 'unavailable');
  assert.match((r as { reason: string }).reason, /unreachable/i);
});

test('PENDING: an empty (no rows) result is pending, not a zero-value breach', async () => {
  const explore = (async () => explored({ rows: [], pending: true })) as never;
  const r = await resolveAlertValue(rule, { resolve, explore });
  assert.equal(r.status, 'pending');
});

test('PENDING: a member no visible metric owns resolves to pending (never a wrong number)', async () => {
  const r = await resolveAlertValue(rule, { resolve: () => null, explore: (async () => explored({})) as never });
  assert.equal(r.status, 'pending');
  assert.match((r as { reason: string }).reason ?? '', /could not be resolved/i);
});
