/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileDomainTables, mayReconcile, type ReconcileDeps } from './reconcile.ts';
import type { Dataset } from './dataset-schema.ts';
import type { Principal } from './store.ts';
import type { RematerializeOutcome } from './publish.ts';

const bea: Principal = { id: 'bea', domains: ['sales'], role: 'builder' };
const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const admin: Principal = { id: 'root', domains: ['ops'], role: 'admin' };

/** A minimal promoted dataset (only the fields reconcile reads). */
function ds(id: string, over: Partial<Dataset> = {}): Dataset {
  return {
    id,
    name: id,
    owner: 'amir',
    domain: 'sales',
    tier: 'asset',
    versions: { bronze: { built: true }, silver: { built: true }, gold: { built: true } },
    ...over,
  } as unknown as Dataset;
}

/** Build injectable deps: a fixed dataset list, a probe keyed by fqn-present set,
 *  and a re-materialize keyed by dataset id → outcome. Records the ids repaired. */
function deps(opts: {
  datasets: Dataset[];
  present: Set<string>; // fqns the probe reports as physically present
  probeThrows?: Set<string>; // fqns whose probe throws (fail-soft ⇒ missing)
  rematerialize?: (id: string) => RematerializeOutcome | Promise<RematerializeOutcome>;
}): { deps: ReconcileDeps; repaired: string[] } {
  const repaired: string[] = [];
  const d: ReconcileDeps = {
    governedDatasets: () => opts.datasets,
    verifyDomainTable: async (fqn) => {
      if (opts.probeThrows?.has(fqn)) throw new Error('trino down');
      return opts.present.has(fqn);
    },
    rematerialize: async (id) => {
      repaired.push(id);
      const out = opts.rematerialize?.(id);
      return out ?? { ok: true, fqn: `iceberg.sales.gold_${id}`, mode: 'live', report: {} as never, dataset: ds(id) };
    },
  };
  return { deps: d, repaired };
}

const fqn = (id: string) => `iceberg.sales.gold_${id}`;

test('missing domain table → refreshed (self-heal the zombie)', async () => {
  const d = ds('ds_missing');
  const { deps: dp, repaired } = deps({ datasets: [d], present: new Set() });
  const rep = await reconcileDomainTables(bea, dp);
  assert.equal(rep.scanned, 1);
  assert.equal(rep.refreshed, 1);
  assert.equal(rep.entries[0].before, 'missing');
  assert.equal(rep.entries[0].after, 'refreshed');
  assert.deepEqual(repaired, ['ds_missing']);
});

test('stale-flagged but present → refreshed', async () => {
  const d = ds('ds_stale', { domainTableStale: true } as Partial<Dataset>);
  const { deps: dp, repaired } = deps({ datasets: [d], present: new Set([fqn('ds_stale')]) });
  const rep = await reconcileDomainTables(bea, dp);
  assert.equal(rep.refreshed, 1);
  assert.equal(rep.entries[0].before, 'stale');
  assert.equal(rep.entries[0].after, 'refreshed');
  assert.deepEqual(repaired, ['ds_stale']);
});

test('promote-as-view: a view-promoted dataset is ALWAYS skipped (no probe, no re-materialize)', async () => {
  // A view is a live pass-through — it can never drift, so reconcile skips it without a
  // probe or a CTAS re-run, even if the probe would report it missing.
  const d = ds('ds_view', { domainArtifact: 'view' } as Partial<Dataset>);
  const { deps: dp, repaired } = deps({ datasets: [d], present: new Set() /* would be "missing" */ });
  const rep = await reconcileDomainTables(bea, dp);
  assert.equal(rep.scanned, 1);
  assert.equal(rep.skipped, 1);
  assert.equal(rep.refreshed, 0);
  assert.equal(rep.entries[0].before, 'ok');
  assert.equal(rep.entries[0].after, 'skipped');
  assert.deepEqual(repaired, [], 'a view is never re-materialized');
});

test('present and not flagged → skipped, no CTAS re-run', async () => {
  const d = ds('ds_ok');
  const { deps: dp, repaired } = deps({ datasets: [d], present: new Set([fqn('ds_ok')]) });
  const rep = await reconcileDomainTables(bea, dp);
  assert.equal(rep.skipped, 1);
  assert.equal(rep.refreshed, 0);
  assert.equal(rep.entries[0].before, 'ok');
  assert.equal(rep.entries[0].after, 'skipped');
  assert.deepEqual(repaired, []); // never touches a healthy table
});

test('a failed re-materialize is reported, sweep continues (best-effort)', async () => {
  const a = ds('ds_a');
  const b = ds('ds_b');
  const { deps: dp } = deps({
    datasets: [a, b],
    present: new Set(),
    rematerialize: (id) =>
      id === 'ds_a'
        ? { ok: false, fqn: fqn('ds_a'), error: 'Trino: TABLE_NOT_FOUND source' }
        : { ok: true, fqn: fqn('ds_b'), mode: 'live', report: {} as never, dataset: b },
  });
  const rep = await reconcileDomainTables(bea, dp);
  assert.equal(rep.scanned, 2);
  assert.equal(rep.failed, 1);
  assert.equal(rep.refreshed, 1);
  const failed = rep.entries.find((e) => e.datasetId === 'ds_a')!;
  assert.equal(failed.after, 'failed');
  assert.match(failed.error!, /TABLE_NOT_FOUND/);
});

test('a probe throw is fail-soft → treated as missing and repaired', async () => {
  const d = ds('ds_probe');
  const { deps: dp, repaired } = deps({ datasets: [d], present: new Set(), probeThrows: new Set([fqn('ds_probe')]) });
  const rep = await reconcileDomainTables(bea, dp);
  assert.equal(rep.entries[0].before, 'missing');
  assert.equal(rep.entries[0].after, 'refreshed');
  assert.deepEqual(repaired, ['ds_probe']);
});

test('a thrown re-materialize never aborts the sweep', async () => {
  const a = ds('ds_throw');
  const b = ds('ds_good');
  const d: ReconcileDeps = {
    governedDatasets: () => [a, b],
    verifyDomainTable: async () => false,
    rematerialize: async (id) => {
      if (id === 'ds_throw') throw new Error('boom');
      return { ok: true, fqn: fqn(id), mode: 'live', report: {} as never, dataset: b };
    },
  };
  const rep = await reconcileDomainTables(bea, d);
  assert.equal(rep.scanned, 2);
  assert.equal(rep.failed, 1);
  assert.equal(rep.refreshed, 1);
  assert.match(rep.entries.find((e) => e.datasetId === 'ds_throw')!.error!, /boom/);
});

test('domain scope filters to the requested domain', async () => {
  const sales = ds('ds_sales', { domain: 'sales' });
  const fin = ds('ds_fin', { domain: 'finance' });
  const { deps: dp } = deps({ datasets: [sales, fin], present: new Set() });
  const rep = await reconcileDomainTables(admin, dp, { domain: 'sales' });
  assert.equal(rep.scanned, 1);
  assert.equal(rep.entries[0].datasetId, 'ds_sales');
});

test('governance: a creator governs nothing → empty sweep', async () => {
  const d = ds('ds_x');
  const { deps: dp, repaired } = deps({ datasets: [d], present: new Set() });
  const rep = await reconcileDomainTables(amir, dp);
  assert.equal(rep.scanned, 0);
  assert.deepEqual(repaired, []);
});

test('governance: a builder only reconciles their own domain', async () => {
  const sales = ds('ds_sales', { domain: 'sales' });
  const fin = ds('ds_fin', { domain: 'finance' });
  const { deps: dp } = deps({ datasets: [sales, fin], present: new Set() });
  const rep = await reconcileDomainTables(bea, dp); // bea ∈ sales only
  assert.equal(rep.scanned, 1);
  assert.equal(rep.entries[0].datasetId, 'ds_sales');
});

test('governance: an admin reconciles every domain', async () => {
  const sales = ds('ds_sales', { domain: 'sales' });
  const fin = ds('ds_fin', { domain: 'finance' });
  const { deps: dp } = deps({ datasets: [sales, fin], present: new Set() });
  const rep = await reconcileDomainTables(admin, dp);
  assert.equal(rep.scanned, 2);
});

test('mayReconcile floors', () => {
  assert.equal(mayReconcile(admin, 'anything'), true);
  assert.equal(mayReconcile(bea, 'sales'), true);
  assert.equal(mayReconcile(bea, 'finance'), false);
  assert.equal(mayReconcile(amir, 'sales'), false); // creator
});
