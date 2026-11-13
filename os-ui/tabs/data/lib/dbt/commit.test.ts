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
  'datasetForScheduler', 'datasetsForProject', 'listJoinable', 'listAskable', 'listImported',
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
  store.buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 'silver/stg_orders.sql', body: 'create or replace table iceberg.personal_amir.silver_orders as select * from iceberg.personal_amir.bronze_orders', compiled: true });
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
  setVersionRun: () => { const id = seedOrders(); calls = []; store.setVersionRun(id, 'silver', { commit: 'c'.repeat(40), dagsterRunId: 'run_1' }, 'amir'); },
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
  assert.deepEqual(last.opts.trailers, { 'OS-Actor': 'amir', 'OS-Author-Email': 'synthesized' });

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
  assert.deepEqual(calls[0].opts.trailers, { 'OS-Actor': 'amir' });
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
  assert.ok(tree!.has('macros/os_maintenance.sql'));
});

test('review M2: an AUTHORED body never becomes a model — the layer is a dbt source, tested there', async () => {
  __setDataProjectGitForTests(true);
  const d = store.createDataset(amir, { name: 'Authored' });
  store.buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/authored.dlt.yml' });
  // No `compiled: true` — what add_dataset_version / the version route record.
  store.buildVersion(d.id, amir, 'silver', { quality: 'unknown', artifact: 'silver/stg_authored.sql', body: "{{ exceptions.raise_compiler_error(env_var('X')) }}" });
  store.addCheck(d.id, amir, { rule: 'not_null', column: 'order_id' });
  let tree: Map<string, string> | null = null;
  await commitDataProject('sales', { id: 'amir' }, { action: 'x' }, {
    committer: async (_d, files) => { tree = files; return { sha: 'b'.repeat(40), changed: true }; },
  });
  assert.equal(tree!.has('models/personal/amir/silver_authored.sql'), false, 'authored body rendered as a model');
  for (const content of tree!.values()) assert.ok(!content.includes("env_var('X')"), 'user text reached the tree');
  const sources = tree!.get('models/sources.yml')!;
  assert.match(sources, /silver_authored/);
  assert.match(sources, /os_built: out-of-band/);
  assert.match(sources, /not_null/); // the rule tests the source
});

test('review M1: a rule column that is not a plain identifier is refused at the store gate', () => {
  const id = seedOrders();
  assert.throws(() => store.addCheck(id, amir, { rule: 'not_null', column: 'x" is null) or (1=1 --' }), /not a plain identifier/);
  assert.throws(() => store.addCheck(id, amir, { rule: 'unique', column: '1abc' }), /not a plain identifier/);
  store.addCheck(id, amir, { rule: 'not_null', column: 'order_id' }); // fine
  store.addCheck(id, amir, { name: 'free text with "quotes"' }); // an intention has no column
});

test('review B2-review-H2: an accepted_values entry that could break out of its SQL literal is refused at the gate', () => {
  const id = seedOrders();
  // dbt renders each value as `'{{ value }}'` with NO escaping, into a test executed as the
  // dataset's owner — so the store is the place to say no.
  assert.throws(
    () => store.addCheck(id, amir, { rule: 'accepted_values', column: 'status', values: ["x' or 1=1 or 'y"] }),
    /is not allowed/,
  );
  assert.throws(
    () => store.addCheck(id, amir, { rule: 'accepted_values', column: 'status', values: ['open', "{{ env_var('AGENT_RUNTIME_TOKEN') }}"] }),
    /is not allowed/,
  );
  assert.throws(
    () => store.addCheck(id, amir, { rule: 'accepted_values', column: 'status', values: ['x'.repeat(201)] }),
    /is not allowed/,
  );
  // A clean set still passes, and the stored values are untouched.
  const d = store.addCheck(id, amir, { rule: 'accepted_values', column: 'status', values: ['open', 'closed'] });
  assert.deepEqual(d.checks!.at(-1)!.values, ['open', 'closed']);
});

test('review B2-review-H3: an authored description never reaches the committed tree as Jinja', async () => {
  __setDataProjectGitForTests(true);
  const trees: Map<string, string>[] = [];
  uninstall = installDataProjectCommitHook({
    committer: async (_domain, files) => { trees.push(files); return { sha: 'e'.repeat(40), changed: true }; },
  });
  const id = seedOrders();
  await awaitDataProjectCommits();
  trees.length = 0;
  const payload = "{{ env_var('AGENT_RUNTIME_TOKEN') }}";
  store.setDocs(id, amir, { description: `Orders ${payload}`, columns: [{ name: 'order_id', description: `Id ${payload}` }] });
  await awaitDataProjectCommits();
  const tree = trees.at(-1);
  assert.ok(tree, 'the docs write produced a commit');
  for (const [path, content] of tree!) {
    assert.ok(!content.includes(payload), `the verbatim Jinja expression reached ${path}`);
    // `profiles.yml` carries the generator's OWN `{{ env_var('TRINO_HOST', …) }}` by design, so the
    // assertion is "no EVALUABLE reference to the runtime bearer", not "no Jinja syntax at all".
    assert.ok(!/\{\{[^}]*AGENT_RUNTIME_TOKEN/.test(content), `an evaluable env_var reached ${path}`);
  }
  // The author's text survives — only the delimiters go, so nothing is silently swallowed.
  const schema = [...tree!.entries()].find(([p]) => p.endsWith('schema.yml'));
  assert.ok(schema, 'a schema.yml was generated');
  assert.ok(schema![1].includes("env_var('AGENT_RUNTIME_TOKEN')"), 'the description text itself is kept');
});

test('review M3: two rapid writes produce two commits, each with its own actor, action and state', async () => {
  __setDataProjectGitForTests(true);
  const trees: { message: string; author: string; files: Map<string, string> }[] = [];
  uninstall = installDataProjectCommitHook({
    committer: async (_domain, files, opts) => { trees.push({ message: opts.message, author: opts.author.name, files }); return { sha: 'd'.repeat(40), changed: true }; },
    resolveActor: async (id) => { await new Promise((r) => setTimeout(r, 5)); return { id, name: `${id}-resolved`, email: `${id}@example.com` }; },
  });
  const id = seedOrders();
  await awaitDataProjectCommits();
  trees.length = 0;
  store.setDocs(id, amir, { description: 'A wrote this', columns: [] });
  store.addCheck(id, amir, { rule: 'not_null', column: 'order_id' });
  await awaitDataProjectCommits();
  assert.equal(trees.length, 2);
  assert.equal(trees[0].author, 'amir-resolved');
  assert.match(trees[0].message, /^data\(sales\): edit docs /);
  assert.match(trees[1].message, /^data\(sales\): add check /);
  const schemaA = trees[0].files.get('models/personal/amir/schema.yml')!;
  const schemaB = trees[1].files.get('models/personal/amir/schema.yml')!;
  assert.match(schemaA, /A wrote this/);
  assert.ok(!schemaA.includes('not_null'), "the first commit carries the second write's state");
  assert.match(schemaB, /not_null/);
});
