/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLiveAdapters, INGEST_OBJECT_KEY, type DltClient } from './live.ts';
import { mockDeps, newMockBackends } from './mocks.ts';
import { runAdapter, type DataBuildContext } from './adapter.ts';
import { emptyVersions, type Dataset } from '../dataset-schema.ts';

/**
 * T3 honesty contract for the Bronze ingest: the dlt adapter's `apply` now calls the
 * data-runner (via `load` with the upload objectKey + principal), and the Bronze is ✓
 * ONLY when `verify` (a governed probe SELECT as the principal) also passes — so the
 * route lights the Bronze dot only on a real, queryable landing.
 */

function personalDataset(): Dataset {
  return {
    version: '1', id: '', name: 'Returns', owner: '', domain: 'personal_creator',
    tier: 'dataset', visibility: 'private', description: '', versions: emptyVersions(),
    grants: [], measures: [], columns: [],
  };
}

function ctx(objectKey?: string): DataBuildContext {
  const artifacts: Record<string, string> = {};
  if (objectKey) artifacts[INGEST_OBJECT_KEY] = objectKey;
  return { dataset: personalDataset(), artifacts, principal: 'creator', stage: 'bronze' };
}

type LoadCall = { table: string; source: string; ctx?: { objectKey?: string; principal?: string } };

function recordingDlt(tableExistsResult: boolean) {
  const loads: LoadCall[] = [];
  const probes: { table: string; principal?: string }[] = [];
  const dlt: DltClient = {
    async load(table, source, c) { loads.push({ table, source, ctx: c }); },
    async tableExists(table, principal) { probes.push({ table, principal }); return tableExistsResult; },
  };
  return { dlt, loads, probes };
}

test('dlt apply calls the runner with the upload objectKey + session principal', async () => {
  const { dlt, loads } = recordingDlt(true);
  const adapters = makeLiveAdapters({ ...mockDeps(newMockBackends()), dlt });
  const r = await adapters.dlt.apply(ctx('uploads/creator/returns.csv'));
  assert.equal(r.ok, true);
  assert.equal(loads.length, 1);
  assert.equal(loads[0].ctx?.objectKey, 'uploads/creator/returns.csv');
  assert.equal(loads[0].ctx?.principal, 'creator');
  // The bronze target is the caller's personal schema (matches the runner output).
  assert.equal(loads[0].table, 'iceberg.personal_creator.bronze_returns');
});

test('dlt verify probes the personal bronze table AS the principal', async () => {
  const { dlt, probes } = recordingDlt(true);
  const adapters = makeLiveAdapters({ ...mockDeps(newMockBackends()), dlt });
  const r = await adapters.dlt.verify(ctx('uploads/creator/returns.csv'));
  assert.equal(r.ok, true);
  assert.equal(probes.length, 1);
  assert.equal(probes[0].table, 'iceberg.personal_creator.bronze_returns');
  assert.equal(probes[0].principal, 'creator');
});

test('Bronze is ✓ only when BOTH apply and verify pass (verify fail ⇒ no commit)', async () => {
  const pass = makeLiveAdapters({ ...mockDeps(newMockBackends()), ...recordingDlt(true) });
  const okRow = await runAdapter(pass.dlt, ctx('uploads/creator/returns.csv'));
  assert.equal(okRow.status, 'ok');

  // The physical probe fails → the row is ✗, so the ingest route must NOT light the dot.
  const fail = makeLiveAdapters({ ...mockDeps(newMockBackends()), ...recordingDlt(false) });
  const failRow = await runAdapter(fail.dlt, ctx('uploads/creator/returns.csv'));
  assert.equal(failRow.status, 'fail');
  assert.match(failRow.error ?? '', /not in Polaris/);
});

test('without an upload objectKey the load is a no-op (honest ✗ when the table is absent)', async () => {
  const { dlt, loads } = recordingDlt(false);
  const adapters = makeLiveAdapters({ ...mockDeps(newMockBackends()), dlt });
  const row = await runAdapter(adapters.dlt, ctx()); // no objectKey
  assert.equal(loads[0].ctx?.objectKey, undefined);
  assert.equal(row.status, 'fail'); // nothing landed → verify probe false
});
