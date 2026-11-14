/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    The data-product engineering view — the dbt model and YAML as committed, the Dagster asset
 * USER STORY: As a reviewer I want the dbt section to show the repository's bytes with their paths
 *             and the real `dbt build --select <node>` command, and the Dagster section to show
 *             the asset key, job, schedule and last run — against a fixture, with no cluster
 *             (checklist T1, T3, T4).
 * ARCHITECTURE:
 *   - Pure: the store, the repository reader and the Dagster client are module-mocked. The section
 *     builders and the vocabulary rule are the real ones.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { vocabularyViolations } from '@core/engineering/vocabulary';
import type { EngineeringPrincipal } from '@core/engineering/types';

const SQL = 'select order_id, amount from {{ ref("silver_orders") }}\n';
const SCHEMA = 'version: 2\nmodels:\n  - name: gold_orders\n    tests: []\n';
const PATHS = ['models/gold/gold_orders.sql', 'models/gold/schema.yml', 'models/sources.yml', 'os/schedules.yml'];

const DATASET = { id: 'ds_1', name: 'Orders', slug: 'orders', domain: 'ops', owner: 'amir', measures: [{ name: 'revenue' }] };

mock.module('@tabs/data/lib/store', {
  namedExports: {
    getDataset: (id: string) => {
      if (id !== DATASET.id) { const e = new Error('Dataset not found') as Error & { status?: number }; e.status = 404; throw e; }
      return DATASET;
    },
  },
});
mock.module('@tabs/data/lib/store-fqn', { namedExports: { physicalSlug: () => 'orders' } });
mock.module('@core/engineering/repo', {
  namedExports: {
    repoPaths: async () => ({ repo: 'ops', head: 'cafe1234', paths: PATHS, reason: null }),
    readRepoFiles: async (_repo: string, match: (p: string) => boolean) => ({
      repo: 'ops',
      head: 'cafe1234',
      files: [{ path: 'models/gold/gold_orders.sql', content: SQL }, { path: 'models/gold/schema.yml', content: SCHEMA }, { path: 'models/sources.yml', content: 'version: 2\n' }].filter((f) => match(f.path)),
      unreadable: [],
      reason: null,
    }),
  },
});
mock.module('@core/infra/dagster', {
  namedExports: {
    dagsterConfigured: () => true,
    runsForDataset: async () => ({ ok: true, data: [{ runId: 'run-7', status: 'SUCCESS', startedAt: '2026-11-14T00:00:00.000Z' }] }),
    modelAssetKey: (domain: string, model: string) => [domain, model],
    scheduleNameFor: (domain: string, id: string) => `${domain}__${id}`,
    sanitizeName: (s: string) => s,
  },
});

const { datasetEngineeringView, dagsterConsoleFor, modelPathsFor, nodeOf } = await import('@tabs/data/lib/engineering');
const USER = { id: 'amir', name: 'Amir', domains: ['ops'], allDomains: ['ops'], activeDomain: 'ops', role: 'admin' } as unknown as EngineeringPrincipal;
/** A Company-tier (`product`) data product is visible outside its domain; the REPOSITORY is not. */
const OUTSIDER = { id: 'fiona', name: 'Fiona', domains: ['finance'], allDomains: ['finance'], activeDomain: 'finance', role: 'admin' } as unknown as EngineeringPrincipal;
const CREATOR = { id: 'cara', name: 'Cara', domains: ['ops'], allDomains: ['ops'], activeDomain: 'ops', role: 'creator' } as unknown as EngineeringPrincipal;

test('the committed model paths of a data product are found by the physical slug the generator uses', () => {
  assert.deepEqual(modelPathsFor(PATHS, 'orders'), ['models/gold/gold_orders.sql']);
  assert.deepEqual(modelPathsFor(['models/personal/amir/silver_orders__ds_9.sql'], 'orders'), ['models/personal/amir/silver_orders__ds_9.sql']);
  assert.deepEqual(modelPathsFor(['models/gold/gold_other.sql'], 'orders'), []);
  assert.equal(nodeOf('models/gold/gold_orders.sql'), 'gold_orders');
});

test('T3: the dbt section shows the repository bytes, the paths and the dbt commands', async () => {
  const view = await datasetEngineeringView(USER, 'ds_1');
  assert.deepEqual(vocabularyViolations(view), []);
  const dbt = view.sections.find((s) => s.tool === 'dbt');
  assert.ok(dbt);
  assert.equal(dbt?.title, 'dbt model `gold_orders` (data product)');
  const model = dbt?.artefacts.find((a) => a.repoPath === 'models/gold/gold_orders.sql');
  assert.equal(model?.body, SQL, 'the SQL shown is the SQL in the repository');
  assert.equal(model?.noun, 'dbt model');
  assert.ok(dbt?.artefacts.some((a) => a.repoPath === 'models/gold/schema.yml' && a.body === SCHEMA));
  assert.deepEqual(dbt?.commands.map((c) => c.command), ['dbt build --select gold_orders', 'dbt test --select gold_orders']);
  // No semantic file is committed, so the panel says `mf query` would not resolve — it does not pretend.
  assert.ok((dbt?.caveats ?? []).some((c) => /mf query/.test(c)));
});

test('T4: the Dagster section shows the asset key, job, schedule, last run and the materialize command', async () => {
  const view = await datasetEngineeringView(USER, 'ds_1');
  const dag = view.sections.find((s) => s.tool === 'dagster');
  assert.equal(dag?.artefacts[0].name, '["ops","gold_orders"]');
  assert.deepEqual(dag?.artefacts[0].facts?.map((f) => f.value), ['["ops","gold_orders"]', 'ops__all', 'ops__ds_1']);
  assert.ok(dag?.artefacts.some((a) => a.noun === 'Dagster run' && a.name === 'run-7'));
  assert.deepEqual(dag?.commands.map((c) => c.command), ['dagster asset materialize --select ops/gold_orders']);
  assert.ok(dag?.links[0].url?.includes('run-7') || dag?.links[0].unresolvedReason, 'the deep link resolves or says why not');
});

test('T9: the view offers the dbt project tarball with the commands to parse it elsewhere', async () => {
  const view = await datasetEngineeringView(USER, 'ds_1');
  assert.equal(view.export?.href, '/api/data/projects/ops/export');
  assert.ok(view.export?.commands.some((c) => c.includes('dbt parse')));
});

test('T7: a data product that does not exist is the tab\'s own 404', async () => {
  await assert.rejects(() => datasetEngineeringView(USER, 'ds_missing'), (e: Error & { status?: number }) => e.status === 404);
});

// ---- identity: a visible data product in a domain you are not in (review H-1) ---

test('H-1: a non-member sees only this data product\'s own dbt model — no domain-wide bytes, no export', async () => {
  const view = await datasetEngineeringView(OUTSIDER, 'ds_1');
  assert.deepEqual(vocabularyViolations(view), []);

  const dbt = view.sections.find((s) => s.tool === 'dbt');
  const paths = (dbt?.artefacts ?? []).map((a) => a.repoPath);
  assert.deepEqual(paths, ['models/gold/gold_orders.sql'], 'only the product\'s own model file');
  assert.ok(!paths.includes('models/sources.yml'), 'a domain-wide file would be bytes the blob route 403s');
  assert.ok((dbt?.caveats ?? []).some((c) => /not a member of 'ops'/.test(c)), 'and the panel says why it is narrower');

  const git = view.sections.find((s) => s.tool === 'git');
  assert.deepEqual((git?.artefacts ?? []).filter((a) => a.repoPath).map((a) => a.repoPath), ['models/gold/gold_orders.sql']);

  // M-1: the export would 403 for this caller, so it is offered as unavailable WITH the reason.
  assert.equal(view.export?.href, null);
  assert.match(view.export?.unresolvedReason ?? '', /members-only/);

  // A member still gets the domain files and the download.
  const inside = await datasetEngineeringView(USER, 'ds_1');
  assert.ok((inside.sections.find((s) => s.tool === 'dbt')?.artefacts ?? []).some((a) => a.repoPath === 'models/sources.yml'));
  assert.equal(inside.export?.href, '/api/data/projects/ops/export');
});

// ---- the Dagster link: both branches are live (review H-3) ----------------------

test('H-3: the Dagster console link resolves for a builder+ and explains itself for a creator', () => {
  const allowed = dagsterConsoleFor(USER);
  assert.ok(allowed.url, 'an admin gets Dagster\'s own console address');
  assert.ok(!allowed.url?.startsWith('/tools/'), 'NOT the /tools proxy: Dagster\'s console is declared ownTab because it renders blank behind the prefix');
  assert.equal(allowed.reason, undefined);

  const refused = dagsterConsoleFor(CREATOR);
  assert.equal(refused.url, null);
  assert.match(refused.reason ?? '', /needs builder; you are creator/);
});

test('H-3: the link a creator sees on the panel says why, and the command is still theirs', async () => {
  const view = await datasetEngineeringView(CREATOR, 'ds_1');
  const dag = view.sections.find((s) => s.tool === 'dagster');
  assert.equal(dag?.links[0].url, null);
  assert.match(dag?.links[0].unresolvedReason ?? '', /needs builder/);
  assert.deepEqual(dag?.commands.map((c) => c.command), ['dagster asset materialize --select ops/gold_orders']);
});
