/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePolicy, governanceFor, tableFqn, cubeFor, type Roster } from './compiler.ts';
import { runConformance, evaluateOpa, evaluateCube } from './conformance.ts';
import { emptyVersions, type Dataset, type Grant } from '../dataset-schema.ts';

function product(over: Partial<Dataset> = {}): Dataset {
  const v = emptyVersions();
  v.bronze.built = true; v.silver.built = true; v.gold.built = true;
  return {
    version: '1', id: 'ds_orders', name: 'Orders', owner: 'amir', domain: 'sales',
    tier: 'product', visibility: 'shared', description: 'Orders.', versions: v,
    grants: [], measures: [], columns: [{ name: 'order_id', description: 'k' }, { name: 'net_amount', description: 'v' }],
    ...over,
  };
}

const roster: Roster = {
  amir: { domains: ['sales'] },
  kenji: { domains: ['finance'] },
  sam: { domains: ['sales', 'finance'] },
};

const domainGrant = (id: string): Grant => ({ grantee: { kind: 'domain', id }, scope: { rows: [], columns: { mask: [], hide: [] } }, cardinality: 'low', action: 'read' });
const userGrant = (id: string): Grant => ({ grantee: { kind: 'user', id }, scope: { rows: [], columns: { mask: [], hide: [] } }, cardinality: 'low', action: 'read' });
const maskGrant = (col: string): Grant => ({ grantee: { kind: 'domain', id: 'sales' }, scope: { rows: [], columns: { mask: [col], hide: [] } }, cardinality: 'low', action: 'read' });

test('compiles ONE source → the OPA governance bundle the trino rego reads', () => {
  const d = product({ imports: ['finance'], grants: [userGrant('analyst1')] });
  const { opa } = compilePolicy([d], roster);
  const fqn = tableFqn(d);
  assert.equal(opa.tables[fqn].domain, 'sales');
  assert.equal(opa.tables[fqn].visibility, 'shared');
  assert.deepEqual(opa.tables[fqn].shared_with, ['finance']); // import = domain read grant
  assert.deepEqual(opa.tables[fqn].shared_with_users, ['analyst1']);
  assert.deepEqual(opa.principals.kenji, { domains: ['finance'], clearances: [] });
});

test('compiles the SAME source → Cube access policies', () => {
  const d = product({ imports: ['finance'], grants: [maskGrant('net_amount')] });
  const { cube } = compilePolicy([d], roster);
  const c = cube.find((x) => x.cube === cubeFor(d))!;
  assert.deepEqual(c.allowDomains, ['finance', 'sales']);
  assert.ok(c.excludes.includes('net_amount')); // restricted column excluded in Cube
});

test('OPA and Cube agree on row access for every identity (conformance ✓)', () => {
  const d = product({ imports: ['finance'] });
  const r = runConformance([d], roster);
  assert.equal(r.ok, true);
  assert.ok(r.checks > 0);
});

test('restricted column: masked in Trino AND excluded in Cube (mask-vs-hide conformant)', () => {
  const d = product({ grants: [maskGrant('net_amount')] });
  const { opa, cube } = compilePolicy([d], roster);
  const fqn = tableFqn(d);
  const opaDec = evaluateOpa(opa, { user: 'amir', domains: ['sales'] }, fqn, 'net_amount');
  const cubeDec = evaluateCube(cube, { user: 'amir', domains: ['sales'] }, cubeFor(d), 'net_amount');
  assert.equal(opaDec.masked, true);
  assert.equal(cubeDec.excluded, true);
  assert.equal(runConformance([d], roster).ok, true);
});

test('cross-domain without a grant is denied on BOTH paths', () => {
  const d = product({ visibility: 'domain' }); // sales only, no finance grant
  const { opa, cube } = compilePolicy([d], roster);
  const fqn = tableFqn(d);
  assert.equal(evaluateOpa(opa, { user: 'kenji', domains: ['finance'] }, fqn).entitled, false);
  assert.equal(evaluateCube(cube, { user: 'kenji', domains: ['finance'] }, cubeFor(d)).entitled, false);
});

test('CONFORMANCE FAILS on injected drift — a grant present in OPA but dropped from Cube', () => {
  const d = product({ imports: ['finance'] });
  const r = runConformance([d], roster, {
    mutate: (c) => ({
      ...c,
      // drift: drop 'finance' from the Cube policy only (OPA still allows it)
      cube: c.cube.map((p) => ({ ...p, allowDomains: p.allowDomains.filter((x) => x !== 'finance') })),
    }),
  });
  assert.equal(r.ok, false);
  assert.ok(r.mismatches.some((m) => m.user === 'kenji' && /row access/.test(m.reason)));
});

test('CONFORMANCE FAILS when a column is masked in Trino but visible in Cube', () => {
  const d = product({ grants: [maskGrant('net_amount')] });
  const r = runConformance([d], roster, {
    mutate: (c) => ({ ...c, cube: c.cube.map((p) => ({ ...p, excludes: [] })) }), // Cube no longer excludes it
  });
  assert.equal(r.ok, false);
  assert.ok(r.mismatches.some((m) => /column mask/.test(m.reason)));
});

test('private datasets are not governed in Trino (no table entry)', () => {
  assert.equal(governanceFor(product({ tier: 'dataset', visibility: 'private' })), null);
});

test('domain-visibility with a stray cross-domain domain grant stays conformant (both deny)', () => {
  // A `domain` asset must NOT honour shared_with on either path (OPA gates it on
  // visibility=shared); the compiler must agree, or conformance would catch the drift.
  const d = product({ tier: 'asset', visibility: 'domain', grants: [domainGrant('finance')] });
  const r = runConformance([d], roster);
  assert.equal(r.ok, true);
  const { opa, cube } = compilePolicy([d], roster);
  assert.equal(evaluateOpa(opa, { user: 'kenji', domains: ['finance'] }, tableFqn(d)).entitled, false);
  assert.equal(evaluateCube(cube, { user: 'kenji', domains: ['finance'] }, cubeFor(d)).entitled, false);
});
