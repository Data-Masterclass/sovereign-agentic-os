/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Every data-store mutator commits (flag on) and none does (flag off) — checklist X1
 * USER STORY: As a maintainer I want a new store mutator to FAIL this test until it is classified,
 *             and proof that each known mutator reaches the one commit path when DATA_PROJECT_GIT is
 *             on and never touches git when it is off.
 * ARCHITECTURE:
 *   - Enumerates the store module's function exports: every name must be in READ_ONLY xor MUTATORS.
 *   - Installs the real commit hook with a spy committer against the real store; asserts per mutator.
 *   - Also covers the request surface (ui:<route> / mcp:<tool>) and the synthesized-email trailer.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '@tabs/data/lib/store';
import type { Principal } from '@tabs/data/lib/store';
import { __resetProjectListeners } from '@tabs/data/lib/project-events';
import { runWithSurface } from '@core/infra/request-surface';
import { parseTrailers, type CommitTreeOptions } from '@core/infra/git-store';
import {
  installDataProjectCommitHook,
  awaitDataProjectCommits,
  __setDataProjectGitForTests,
  commitDataProject,
} from '@tabs/data/lib/dbt/commit';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const bea: Principal = { id: 'bea', domains: ['sales'], role: 'builder' };
const sara: Principal = { id: 'sara', domains: ['sales'], role: 'admin' };
const fatima: Principal = { id: 'fatima', domains: ['finance'], role: 'builder' };

/** Exports that only READ (or are test seams). Anything else must be a classified mutator. */
const READ_ONLY = new Set([
  'ensureHydrated', '__resetStore', '__seedDatasetForTest',
  'listDatasets', 'getDataset', 'peekDatasetMeta', 'peekDatasetTier', 'peekDatasetColumns', 'peekDatasetMeasureNames',
  'isDatasetArchived', 'requireDatasetEditable', 'builtLayerFqn', 'listGovernedDatasets', 'listAllDatasets',
  'datasetForScheduler', 'datasetsWithSync', 'datasetsForProject', 'listJoinable', 'listAskable', 'listImported',
  'listDatasetVersions', 'listFiles', 'readFile', 'assetTarget', 'productTarget',
  'requestPromotion', 'validatePromotion', 'assertPromoteTargetFree', 'assertGrantsWithinAuthority',
  'requireDomainTableMaterialized', 'requestCertification',
]);

type Calls = { domain: string; message: string; opts: CommitTreeOptions }[];
let calls: Calls = [];
let uninstall: (() => void) | null = null;

function installSpy(): void {
  uninstall = installDataProjectCommitHook({
    committer: async (domain, _files, opts) => {
      calls.push({ domain, message: opts.message, opts });
      return { sha: 'f'.repeat(40), changed: true };
    },
  });
}

beforeEach(() => {
  store.__resetStore();
  __resetProjectListeners();
  calls = [];
});
afterEach(() => {
  uninstall?.();
  uninstall = null;
  __setDataProjectGitForTests(null);
});

function seedOrders(): string {
  const d = store.createDataset(amir, { name: 'Orders' });
  store.buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });
  store.buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 'silver/stg_orders.sql', body: 'create or replace table iceberg.personal_amir.silver_orders as select * from iceberg.personal_amir.bronze_orders' });
  return d.id;
}
function documented(id: string): string {
  store.setDocs(id, amir, { description: 'Orders', columns: [{ name: 'order_id', description: 'key' }] });
  return id;
}
function promoted(id: string): string {
  documented(id);
  const req = store.requestPromotion(id, amir);
  store.applyApprovedPromotion(req, bea);
  return id;
}
function stale(id: string): string {
  promoted(id);
  store.buildVersion(id, amir, 'gold', { quality: 'unknown', artifact: 'gold/mart_orders.sql', passThrough: true });
  return id;
}
function connected(id = 'exp_1', connectionId = 'conn_1') {
  return store.adoptConnectedDataset(sara, {
    name: `Ext ${id}`,
    domain: 'sales',
    description: 'an external table',
    connected: { connectionId, exposureId: id, source: { catalog: 'wh', schema: 'public', table: 'events' }, mode: 'live', tier: 'silver', status: 'ok' },
  });
}
const sync = { connectionId: 'conn_wh', source: { schema: 'public', table: 'events' }, mode: 'append' as const, cursor: { kind: 'timestamp' as const, column: 'updated_at' }, schedule: { cron: '0 6 * * *' }, enabled: true };

/** Every mutating export, with the smallest scenario that makes it write. */
const MUTATORS: Record<string, () => void | Promise<void>> = {
  createDataset: () => void store.createDataset(amir, { name: 'New' }),
  adoptConnectedDataset: () => void connected(),
  moveDatasetsDomain: () => void store.moveDatasetsDomain({ id: seedOrders() }, 'finance'),
  markDatasetsSourceRevoked: () => { connected('exp_r'); store.markDatasetsSourceRevoked('exp_r'); },
  markDatasetsDrifted: () => { connected('exp_d', 'conn_d'); store.markDatasetsDrifted('conn_d', [{ schema: 'public', table: 'events' }]); },
  reassignOwner: () => { seedOrders(); store.reassignOwner('amir', 'kenji'); },
  buildVersion: () => void store.buildVersion(seedOrders(), amir, 'gold', { quality: 'unknown', artifact: 'gold/mart_orders.sql', passThrough: true }),
  buildGoldJoin: () => void store.buildGoldJoin(seedOrders(), amir, { measures: [], upstreams: [], artifact: 'gold/mart_orders.sql', body: 'create or replace table iceberg.personal_amir.gold_orders as select * from iceberg.personal_amir.silver_orders' }),
  setDocs: () => void documented(seedOrders()),
  renameDataset: () => void store.renameDataset(seedOrders(), amir, 'Orders 2'),
  moveDataset: () => void store.moveDataset(seedOrders(), amir, '/q3'),
  addCheck: () => void store.addCheck(seedOrders(), amir, { rule: 'not_null', column: 'order_id' }),
  removeCheck: () => { const id = seedOrders(); const d = store.addCheck(id, amir, { rule: 'not_null', column: 'order_id' }); calls = []; store.removeCheck(id, amir, d.checks![0].id); },
  updateCheckDescriptions: () => { const id = seedOrders(); const d = store.addCheck(id, amir, { rule: 'not_null', column: 'order_id' }); calls = []; store.updateCheckDescriptions(id, amir, [{ id: d.checks![0].id, description: 'x' }]); },
  setMonitor: () => void store.setMonitor(seedOrders(), amir, 'freshness', false),
  setDatasetSync: () => void store.setDatasetSync(seedOrders(), amir, sync),
  defineMeasure: () => { const id = seedOrders(); store.buildVersion(id, amir, 'gold', { quality: 'unknown', artifact: 'gold/mart_orders.sql', passThrough: true }); calls = []; store.defineMeasure(id, amir, { name: 'revenue', type: 'sum', sql: 'amount' }); },
  removeMeasure: () => { const id = seedOrders(); store.buildVersion(id, amir, 'gold', { quality: 'unknown', artifact: 'gold/mart_orders.sql', passThrough: true }); store.defineMeasure(id, amir, { name: 'revenue', type: 'sum', sql: 'amount' }); calls = []; store.removeMeasure(id, amir, 'revenue'); },
  setMeasureLabel: () => { const id = seedOrders(); store.buildVersion(id, amir, 'gold', { quality: 'unknown', artifact: 'gold/mart_orders.sql', passThrough: true }); store.defineMeasure(id, amir, { name: 'revenue', type: 'sum', sql: 'amount' }); calls = []; store.setMeasureLabel(id, amir, 'revenue', 'Revenue'); },
  transition: () => { const id = promoted(seedOrders()); calls = []; store.transition(id, sara, 'unshare'); },
  applyApprovedPromotion: () => { const id = documented(seedOrders()); const req = store.requestPromotion(id, amir); calls = []; store.applyApprovedPromotion(req, bea); },
  clearDomainTableStale: () => { const id = stale(seedOrders()); calls = []; store.clearDomainTableStale(id, bea); },
  verifyPromotedMaterialization: async () => { const id = stale(seedOrders()); calls = []; await store.verifyPromotedMaterialization(id, amir, async () => true); },
  certify: () => { const id = promoted(seedOrders()); calls = []; store.certify(id, sara); },
  applyApprovedCertification: () => { const id = promoted(seedOrders()); const req = store.requestCertification(id, bea); calls = []; store.applyApprovedCertification(req, sara); },
  importProduct: () => { const id = promoted(seedOrders()); store.certify(id, sara); calls = []; store.importProduct(id, fatima); },
  archiveDataset: () => void store.archiveDataset(seedOrders(), amir),
  unarchiveDataset: () => { const id = seedOrders(); store.archiveDataset(id, amir); calls = []; store.unarchiveDataset(id, amir); },
  deleteDataset: () => void store.deleteDataset(seedOrders(), amir),
  restoreDatasetVersion: () => { const id = seedOrders(); calls = []; store.restoreDatasetVersion(id, amir, 1); },
  writeFile: () => { const id = seedOrders(); const f = store.readFile(id, amir, 'dataset.yaml'); calls = []; store.writeFile(id, amir, { path: 'dataset.yaml', content: f.content.replace('description: ""', 'description: "edited"'), sha: f.sha }); },
};

test('every store export is classified: read-only or a mutator under test (a new mutator fails here)', () => {
  const exported = Object.entries(store)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k)
    .sort();
  const unknown = exported.filter((k) => !READ_ONLY.has(k) && !(k in MUTATORS));
  assert.deepEqual(unknown, [], 'unclassified store exports — add to READ_ONLY or MUTATORS');
  const stale = Object.keys(MUTATORS).filter((k) => !exported.includes(k));
  assert.deepEqual(stale, [], 'MUTATORS names an export that no longer exists');
});

for (const [name, run] of Object.entries(MUTATORS)) {
  test(`flag ON: ${name} reaches the commit path`, async () => {
    __setDataProjectGitForTests(true);
    installSpy();
    await run();
    await awaitDataProjectCommits();
    assert.ok(calls.length >= 1, `${name} produced no commit`);
    for (const c of calls) {
      assert.match(c.message, /^data\((sales|finance)\): /, c.message);
      assert.ok(['sales', 'finance'].includes(c.domain));
      const t = parseTrailers(c.message);
      assert.ok(t['OS-Action'] && t['OS-Object'] && t['OS-Surface'] && t['OS-Request-Id'], `trailers: ${c.message}`);
    }
  });

  test(`flag OFF: ${name} never touches git`, async () => {
    __setDataProjectGitForTests(false);
    installSpy();
    await run();
    await awaitDataProjectCommits();
    assert.equal(calls.length, 0, `${name} committed with the flag off`);
  });
}

test('the ambient surface and request id land in the message; no surface ⇒ ui:data; author e-mail synthesized when unknown', async () => {
  __setDataProjectGitForTests(true);
  installSpy();
  await runWithSurface('mcp:define_quality_rules', async () => {
    store.addCheck(seedOrders(), amir, { rule: 'not_null', column: 'order_id' });
  }, 'req_abc');
  await awaitDataProjectCommits();
  const last = calls.at(-1)!;
  assert.match(last.message, /^data\(sales\): add check orders — via mcp:define_quality_rules\n/);
  const t = parseTrailers(last.message);
  assert.equal(t['OS-Request-Id'], 'req_abc');
  assert.match(t['OS-Object'], /^ds_\w+ \(Orders\)$/);
  assert.deepEqual(last.opts.author, { name: 'amir', email: 'amir@os.local' });
  assert.deepEqual(last.opts.trailers, { 'OS-Author-Email': 'synthesized' });

  calls = [];
  store.setMonitor(store.listDatasets(amir).mine[0].id, amir, 'volume', false);
  await awaitDataProjectCommits();
  assert.equal(parseTrailers(calls.at(-1)!.message)['OS-Surface'], 'ui:data');
});

test('a resolved actor is the git author; the deleted dataset is named by id in a retire commit', async () => {
  __setDataProjectGitForTests(true);
  uninstall = installDataProjectCommitHook({
    committer: async (domain, _files, opts) => { calls.push({ domain, message: opts.message, opts }); return { sha: 'a'.repeat(40), changed: true }; },
    resolveActor: async (id) => ({ id, name: 'Amir Example', email: 'amir@example.com' }),
  });
  const id = seedOrders();
  await awaitDataProjectCommits(); // let the seed commits land before isolating the retire
  calls = [];
  store.deleteDataset(id, amir);
  await awaitDataProjectCommits();
  assert.deepEqual(calls[0].opts.author, { name: 'Amir Example', email: 'amir@example.com' });
  assert.deepEqual(calls[0].opts.trailers, {});
  assert.match(calls[0].message, new RegExp(`^data\\(sales\\): retire ${id} — via ui:data`));
});

test('commitDataProject is a no-op (null) with the flag off and generates a real tree with it on', async () => {
  __setDataProjectGitForTests(false);
  assert.equal(await commitDataProject('sales', { id: 'amir' }, { action: 'x' }), null);
  __setDataProjectGitForTests(true);
  seedOrders();
  let tree: Map<string, string> | null = null;
  const r = await commitDataProject('sales', { id: 'amir' }, { action: 'x' }, {
    committer: async (_d, files) => { tree = files; return { sha: 'b'.repeat(40), changed: true }; },
  });
  assert.equal(r?.changed, true);
  assert.ok(tree!.has('models/personal/amir/silver_orders.sql'));
  assert.ok(tree!.has('dbt_project.yml') && tree!.has('profiles.yml'));
});
