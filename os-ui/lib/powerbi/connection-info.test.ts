/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionInfoForDomain, type SqlApiExposure } from './connection-info.ts';

const EXPOSURE: SqlApiExposure = {
  enabled: true,
  host: 'cube-sql.example.com',
  port: 15432,
  passwordSecretName: 'cube-sql-secrets',
};

test('connectionInfoForDomain: exact PostgreSQL Get-Data fields for the domain', () => {
  const info = connectionInfoForDomain('sales', EXPOSURE);
  assert.equal(info.server, 'cube-sql.example.com:15432');
  assert.equal(info.host, 'cube-sql.example.com');
  assert.equal(info.port, 15432);
  assert.equal(info.user, 'bi_sales');
  assert.equal(info.database, 'bi_sales');
  assert.equal(info.domain, 'sales');
  assert.equal(info.enabled, true);
});

test('connection info NEVER carries a password — only a vault reference', () => {
  const info = connectionInfoForDomain('sales', EXPOSURE);
  assert.deepEqual(info.password, { source: 'vault', secretName: 'cube-sql-secrets', key: 'CUBEJS_SQL_PASSWORD' });
  // Defence in depth: no field anywhere in the serialised payload looks like a secret value.
  const blob = JSON.stringify(info);
  assert.doesNotMatch(blob, /"password":"[^"]/); // password is an object ref, not a string value
  assert.ok(!Object.values(info).some((v) => typeof v === 'string' && /secret.*=|passw.*=/i.test(v)));
});

test('per-domain shape: two domains yield different, correctly-scoped principals', () => {
  const sales = connectionInfoForDomain('sales', EXPOSURE);
  const finance = connectionInfoForDomain('finance', EXPOSURE);
  assert.equal(sales.user, 'bi_sales');
  assert.equal(finance.user, 'bi_finance');
  assert.deepEqual(sales.securityContext.domains, ['sales']);
  assert.deepEqual(finance.securityContext.domains, ['finance']);
});

test('scope note is honest about domain-level (not per-viewer) RLS', () => {
  const info = connectionInfoForDomain('sales', EXPOSURE);
  assert.match(info.scopeNote, /domain-level/i);
  assert.match(info.scopeNote, /not|per-individual|per-viewer/i);
});

test('disabled exposure is reflected so the UI/doc never advertise a closed port', () => {
  const info = connectionInfoForDomain('sales', { ...EXPOSURE, enabled: false });
  assert.equal(info.enabled, false);
});
