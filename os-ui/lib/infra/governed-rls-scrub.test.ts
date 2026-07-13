/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * RLS-SCRUB test for the governed Cube send path. The per-viewer securityContext (R3)
 * carries the viewer's low-cardinality attributes (region, tenant …) so Cube's RLS
 * applies. But Cube's queryRewrite pushes an attribute as a `filters` member on the
 * queried cube — and 400s the WHOLE query if that cube has no such dimension
 * (`'region' not found for path 'Northpeak_CAC_COS_Weekly.region'`). So before the
 * securityContext reaches Cube we DROP any attribute the queried cube(s) do not have
 * as a dimension: never emit a filter on a non-existent path, never weaken RLS where
 * the dimension DOES exist.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { cubeLoad, __setCubeMetaForTest, scrubSecurityContext } from './governed.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  __setCubeMetaForTest(null);
});

/** Capture the securityContext header cubeLoad sends to Cube's /v1/load. */
function captureLoad(): { header: () => string | undefined } {
  let header: string | undefined;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const h = (init.headers ?? {}) as Record<string, string>;
    header = h['x-cube-security-context'];
    return { ok: true, text: async () => JSON.stringify({ data: [], annotation: {} }) };
  }) as unknown as typeof fetch;
  return { header: () => header };
}

test('scrubSecurityContext keeps structural keys + only attributes the cube HAS as a dimension', () => {
  const ctx = { sub: 'amir', domains: ['np'], role: 'creator', scope: 'domain', imported: [], region: 'DE' };
  // Northpeak-shaped cube: NO region dimension.
  const scrubbed = scrubSecurityContext(ctx, new Set(['Northpeak_CAC_COS_Weekly.cohort']));
  assert.equal(scrubbed.region, undefined, 'region must be dropped: the cube has no region dimension');
  assert.equal(scrubbed.sub, 'amir', 'structural keys are preserved');
  assert.deepEqual(scrubbed.domains, ['np']);
  assert.equal(scrubbed.scope, 'domain');
});

test('scrubSecurityContext KEEPS an attribute the cube DOES have (RLS stays sound)', () => {
  const ctx = { sub: 'amir', role: 'creator', region: 'DE' };
  const scrubbed = scrubSecurityContext(ctx, new Set(['Sales.region', 'Sales.order_date']));
  assert.equal(scrubbed.region, 'DE', 'region must survive: the cube has a region dimension');
});

test('LIVE: region-less cube => the securityContext sent to Cube omits region (no 400)', async () => {
  __setCubeMetaForTest({ 'Northpeak_CAC_COS_Weekly.cohort': true });
  const cap = captureLoad();
  await cubeLoad(
    { measures: ['Northpeak_CAC_COS_Weekly.cac'], limit: 1 },
    { securityContext: { sub: 'amir', role: 'creator', domains: ['np'], region: 'DE' } },
  );
  const sent = JSON.parse(cap.header() ?? '{}');
  assert.equal(sent.region, undefined, 'no region filter is pushed at a cube without a region dimension');
  assert.equal(sent.sub, 'amir', 'the viewer identity still propagates (RLS not collapsed)');
});

test('INTEGRATION: a Northpeak cohort query resolves (no 400) because region is scrubbed', async () => {
  __setCubeMetaForTest({ 'Northpeak_CAC_COS_Weekly.cohort': true, 'Northpeak_CAC_COS_Weekly.week': true });
  // A Cube that 400s if the forwarded securityContext carries `region` (the live bug shape).
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const h = (init.headers ?? {}) as Record<string, string>;
    const ctx = JSON.parse(h['x-cube-security-context'] ?? '{}');
    if ('region' in ctx) {
      return { ok: false, status: 400, text: async () => `{"type":"UserError","error":"'region' not found for path 'Northpeak_CAC_COS_Weekly.region'"}` };
    }
    return { ok: true, text: async () => JSON.stringify({ data: [{ 'Northpeak_CAC_COS_Weekly.cac': 42 }], annotation: {} }) };
  }) as unknown as typeof fetch;
  const res = await cubeLoad(
    { measures: ['Northpeak_CAC_COS_Weekly.cac'], dimensions: ['Northpeak_CAC_COS_Weekly.cohort'], limit: 10 },
    { securityContext: { sub: 'amir', role: 'creator', domains: ['np'], region: 'DE' } },
  );
  assert.deepEqual(res.rows, [{ 'Northpeak_CAC_COS_Weekly.cac': 42 }], 'the cohort query resolves — region never reached Cube');
});

test('LIVE: cube WITH region => the securityContext still carries region (RLS enforced)', async () => {
  __setCubeMetaForTest({ 'Sales.region': true });
  const cap = captureLoad();
  await cubeLoad(
    { measures: ['Sales.revenue'], limit: 1 },
    { securityContext: { sub: 'amir', role: 'creator', region: 'DE' } },
  );
  const sent = JSON.parse(cap.header() ?? '{}');
  assert.equal(sent.region, 'DE', 'region RLS is preserved for a cube that has the dimension');
});
