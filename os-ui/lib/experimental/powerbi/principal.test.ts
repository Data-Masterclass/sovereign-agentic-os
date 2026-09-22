/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  biUserForDomain,
  domainFromBiUser,
  normalizeDomainId,
  resolveSqlPrincipal,
  securityContextForDomain,
} from './principal.ts';

test('biUserForDomain: domain → bi_<domain> and back', () => {
  assert.equal(biUserForDomain('sales'), 'bi_sales');
  assert.equal(domainFromBiUser('bi_sales'), 'sales');
  // Round-trips through the same normaliser Power BI/Postgres accept.
  assert.equal(biUserForDomain('Sales Ops'), 'bi_sales_ops');
  assert.equal(domainFromBiUser(biUserForDomain('Sales Ops')), 'sales_ops');
});

test('normalizeDomainId: lowercases + strips to [a-z0-9_]', () => {
  assert.equal(normalizeDomainId('  Marketing-EU '), 'marketing_eu');
  assert.equal(normalizeDomainId('a.b.c'), 'a_b_c');
});

test('biUserForDomain rejects an empty/invalid domain', () => {
  assert.throws(() => biUserForDomain(''));
  assert.throws(() => biUserForDomain('   '));
  assert.throws(() => biUserForDomain('!!!'));
});

test('domainFromBiUser rejects non-BI logins', () => {
  assert.equal(domainFromBiUser('cube-sales'), null); // the HTTP-path Trino user, not a BI principal
  assert.equal(domainFromBiUser('admin'), null);
  assert.equal(domainFromBiUser(''), null);
});

test('securityContextForDomain: domain-scoped, lowest role, read-only (mirrors governed.ts keys)', () => {
  const ctx = securityContextForDomain('sales');
  assert.deepEqual(ctx, { sub: 'bi:sales', domains: ['sales'], role: 'creator', scope: 'bi-readonly' });
  // Only the structural RLS keys governed.ts recognises — no stray region attribute
  // (domain-level scope, not per-viewer).
  assert.deepEqual(Object.keys(ctx).sort(), ['domains', 'role', 'scope', 'sub']);
});

test('resolveSqlPrincipal: this is exactly what Cube checkSqlAuth calls', () => {
  // A domain BI login resolves to that domain's securityContext...
  assert.deepEqual(resolveSqlPrincipal('bi_marketing'), {
    sub: 'bi:marketing',
    domains: ['marketing'],
    role: 'creator',
    scope: 'bi-readonly',
  });
  // ...and NO other login does (so a random SQL user can't get a scope).
  assert.equal(resolveSqlPrincipal('postgres'), null);
  assert.equal(resolveSqlPrincipal('cube-sales'), null);
});

test('domain isolation: domain X principal never yields domain Y scope', () => {
  const sales = resolveSqlPrincipal('bi_sales')!;
  const finance = resolveSqlPrincipal('bi_finance')!;
  assert.deepEqual(sales.domains, ['sales']);
  assert.deepEqual(finance.domains, ['finance']);
  assert.notDeepEqual(sales.domains, finance.domains);
});
