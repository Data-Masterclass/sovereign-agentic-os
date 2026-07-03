/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Marketplace spine tests — the import→grant decision logic, cross-domain RLS,
 * and lineage-aware deprecation. Pure modules only (no cluster, no node_modules),
 * runnable with `node --test`. This is the executable proof of the validation
 * gate's hard claims: per-type import modes, "different rows via RLS", and
 * "deprecating an in-use product warns importers".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  importModesFor,
  isModeAllowed,
  enforcementTarget,
  defaultAccessPolicy,
} from './import-policy.ts';
import { compileRls, rowMatches, applyRls, rlsEngineLabel } from './rls.ts';
import { importersOf, planDeprecation, canHardRemove, importerLineage } from './lineage.ts';
import { mockCatalog } from './store.ts';
import type { Grant } from './types.ts';

// ---------------------------------------------------------------- store pin --

test('globalThis pin: the mock catalog is a shared singleton across route bundles', () => {
  const a = mockCatalog();
  const pinned = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.marketplace.catalog')];
  assert.equal(a, pinned, 'mockCatalog() returns the globalThis-pinned array');
  // A second resolution (as a separately-bundled route handler would do) must
  // see the SAME instance, not a fresh empty copy.
  assert.equal(mockCatalog(), a, 'second mockCatalog() call returns the same array');
});

// --------------------------------------------------------- per-type import policy

test('per-type import modes follow the golden-path table', () => {
  assert.equal(importModesFor('metric').default, 'read-grant');
  assert.equal(importModesFor('dashboard').default, 'read-grant');
  assert.deepEqual(importModesFor('knowledge').options, ['read-grant', 'fork']);
  assert.equal(importModesFor('agent').default, 'fork');
  assert.equal(importModesFor('connection').default, 'template');
  assert.equal(importModesFor('app').default, 'deploy-instance');
});

test('mode legality is enforced per type', () => {
  assert.equal(isModeAllowed('metric', 'read-grant'), true);
  assert.equal(isModeAllowed('metric', 'fork'), false); // a metric is read-in-place only
  assert.equal(isModeAllowed('agent', 'read-grant'), false); // an agent is fork-to-own
  assert.equal(isModeAllowed('knowledge', 'fork'), true);
});

test('enforcement target maps read-grants to the right RLS engine', () => {
  assert.equal(enforcementTarget('metric', 'read-grant'), 'cube-rls');
  assert.equal(enforcementTarget('dashboard', 'read-grant'), 'cube-rls');
  assert.equal(enforcementTarget('knowledge', 'read-grant'), 'opensearch-dls');
  assert.equal(enforcementTarget('file', 'read-grant'), 'opensearch-dls');
  assert.equal(enforcementTarget('dataset', 'read-grant'), 'opa-trino');
  assert.equal(enforcementTarget('knowledge', 'fork'), 'copy');
  assert.equal(enforcementTarget('connection', 'template'), 'template');
  assert.equal(enforcementTarget('app', 'deploy-instance'), 'instance');
});

test('access policy: read-grants are open; shared creds/instances need approval', () => {
  assert.equal(defaultAccessPolicy('metric', 'read-grant'), 'open');
  assert.equal(defaultAccessPolicy('knowledge', 'fork'), 'open');
  assert.equal(defaultAccessPolicy('connection', 'template'), 'approval');
  assert.equal(defaultAccessPolicy('app', 'deploy-instance'), 'approval');
});

// --------------------------------------------------------------- cross-domain RLS

test('compileRls scopes a viewer to their own domain by default', () => {
  assert.equal(compileRls('sales').rows, "domain = 'sales'");
  assert.equal(compileRls('marketing').rows, "domain = 'marketing'");
  assert.equal(compileRls('marketing', { rowScope: 'open-rows' }).rows, 'true');
});

test('compileRls escapes quotes (no predicate injection via domain name)', () => {
  assert.equal(compileRls("ev'il").rows, "domain = 'ev''il'");
});

test('rowMatches parses the compiled predicate and fails closed on garbage', () => {
  assert.equal(rowMatches('true', { domain: 'x' }), true);
  assert.equal(rowMatches("domain = 'sales'", { domain: 'sales' }), true);
  assert.equal(rowMatches("domain = 'sales'", { domain: 'marketing' }), false);
  assert.equal(rowMatches("domain = 'sales' AND region = 'DE'", { domain: 'sales', region: 'DE' }), true);
  assert.equal(rowMatches('DROP TABLE x', { domain: 'sales' }), false); // unparseable → fail closed
});

test('GATE: Sales and Marketing import the SAME metric but see DIFFERENT rows', () => {
  // The certified "Daily revenue" metric: rows tagged by owning domain.
  const columns = ['domain', 'day', 'revenue'];
  const rows = [
    ['sales', '2026-06-28', '12000'],
    ['sales', '2026-06-29', '13500'],
    ['marketing', '2026-06-28', '4200'],
    ['marketing', '2026-06-29', '5100'],
  ];

  const salesView = applyRls(compileRls('sales'), columns, rows);
  const marketingView = applyRls(compileRls('marketing'), columns, rows);

  assert.deepEqual(salesView.rows.map((r) => r[0]), ['sales', 'sales']);
  assert.deepEqual(marketingView.rows.map((r) => r[0]), ['marketing', 'marketing']);
  // Same product, same definition — but the row sets are disjoint.
  assert.notDeepEqual(salesView.rows, marketingView.rows);
  assert.equal(salesView.rows.length, 2);
  assert.equal(marketingView.rows.length, 2);
});

test('column projection drops disallowed columns', () => {
  const columns = ['domain', 'day', 'revenue', 'cost'];
  const rows = [['marketing', '2026-06-29', '5100', '900']];
  const scope = compileRls('marketing', { columns: ['domain', 'day', 'revenue'] });
  const view = applyRls(scope, columns, rows);
  assert.deepEqual(view.columns, ['domain', 'day', 'revenue']);
  assert.deepEqual(view.rows, [['marketing', '2026-06-29', '5100']]);
});

test('rlsEngineLabel names the runtime that enforces each type', () => {
  assert.match(rlsEngineLabel('metric'), /Cube/);
  assert.match(rlsEngineLabel('knowledge'), /Document-Level Security/);
  assert.match(rlsEngineLabel('dataset'), /Trino/);
});

// ----------------------------------------------------- lineage-aware deprecation

function grant(p: Partial<Grant>): Grant {
  return {
    id: 'g1',
    listingId: 'lst_revenue',
    productId: 'seed_cert_revenue',
    type: 'metric',
    productName: 'Daily revenue',
    mode: 'read-grant',
    granteeUser: 'mona',
    granteeDomain: 'marketing',
    ownerUser: 'sara',
    ownerDomain: 'sales',
    scope: { rows: "domain = 'marketing'" },
    enforcedBy: 'cube-rls',
    status: 'active',
    createdAt: '2026-06-30T00:00:00Z',
    updatedAt: '2026-06-30T00:00:00Z',
    ...p,
  };
}

test('GATE: deprecating an in-use product warns its importers and keeps grants', () => {
  const grants = [
    grant({ id: 'g1', granteeDomain: 'marketing' }),
    grant({ id: 'g2', granteeDomain: 'finance' }),
    grant({ id: 'g3', granteeDomain: 'finance' }), // dedup
    grant({ id: 'g4', granteeDomain: 'ops', status: 'revoked' }), // excluded
  ];
  assert.deepEqual(importersOf(grants, 'lst_revenue'), ['finance', 'marketing']);

  const res = planDeprecation('lst_revenue', grants);
  assert.equal(res.deprecated, true);
  assert.deepEqual(res.warned, ['finance', 'marketing']);
  assert.equal(canHardRemove(grants, 'lst_revenue'), false);
});

test('a product with no live importers can be hard-removed', () => {
  const grants = [grant({ id: 'g4', status: 'revoked' })];
  assert.equal(canHardRemove(grants, 'lst_revenue'), true);
  assert.deepEqual(planDeprecation('lst_revenue', grants).warned, []);
});

test('importerLineage builds one node per importer domain+mode', () => {
  const grants = [
    grant({ id: 'g1', granteeDomain: 'marketing', mode: 'read-grant' }),
    grant({ id: 'g2', granteeDomain: 'marketing', mode: 'fork' }),
  ];
  const nodes = importerLineage(grants, 'lst_revenue');
  assert.equal(nodes.length, 2);
  assert.ok(nodes.every((n) => n.relation === 'importer'));
});
