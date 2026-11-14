/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    dbt models + `schema.yml` pushed by an engineer → dataset records, and THE COIN
 * USER STORY: As the owner I want proof that a `git push` of a model and its `schema.yml` leaves
 *             the OS in exactly the state `create_dataset` + `define_quality_rules` would have
 *             left it in — the same generated project bytes and the same registry row, differing
 *             only in `OS-Surface` (checklist E5, E8, E9, X8's dataset half).
 * ARCHITECTURE:
 *   - The pure half (`readSchemaYml`, `datasetsFromSchemaYml`, `testToRule`) is tested against the
 *     OS's OWN generator output: `renderSchemas` out, `datasetsFromSchemaYml` back in. A reverse
 *     map that cannot read what the forward map writes is not a reverse map.
 *   - The applied half uses the real store with the real commit hook and an injected committer —
 *     the harness `tabs/data/lib/mcp-parity.test.ts` established — so "the same state" is compared
 *     on the bytes a commit would carry.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as store from '@tabs/data/lib/store';
import type { Principal } from '@tabs/data/lib/store';
import { __resetProjectListeners } from '@tabs/data/lib/project-events';
import { runWithSurface } from '@core/infra/request-surface';
import { parseTrailers, type CommitTreeOptions, type GitAuthor } from '@core/infra/git-store';
import { personalDataLane, registeredRepoKinds, __clearRepoKinds, type ChangedFile, type Pusher } from '@core/infra/git-receive';
import { installDataProjectCommitHook, awaitDataProjectCommits, __setDataProjectGitForTests } from '@tabs/data/lib/dbt/commit';
import { __setLaunchDepsForTests } from '@tabs/data/lib/dbt/launch';
import { __setMutationDepsForTests, createDatasetService, defineQualityRulesService } from '@tabs/data/lib/mutations-server';
import { personalSchema } from '@tabs/data/lib/store-fqn';
import {
  DATASET_KIND,
  datasetsFromSchemaYml,
  ingestDbtModels,
  layerOf,
  matchesDbt,
  readSchemaYml,
  registerDbtIngest,
  schemaOf,
  testToRule,
  validateDbtFile,
} from '@tabs/data/lib/dbt/ingest';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const pusher: Pusher = { id: 'amir', name: 'Amir', email: 'amir@acme.com', role: 'creator', domains: ['sales'] };

type Commit = { domain: string; files: [string, string][]; author: GitAuthor; trailers: Record<string, string>; subject: string };
let commits: Commit[] = [];
let uninstall: (() => void) | null = null;

beforeEach(() => {
  store.__resetStore();
  __resetProjectListeners();
  __clearRepoKinds();
  __setDataProjectGitForTests(true);
  commits = [];
  uninstall = installDataProjectCommitHook({
    committer: async (domain, files, opts: CommitTreeOptions) => {
      commits.push({
        domain,
        files: [...files.entries()].sort(([a], [b]) => a.localeCompare(b)),
        author: opts.author,
        trailers: parseTrailers(opts.message),
        subject: opts.message.split('\n')[0],
      });
      return { sha: 'f'.repeat(40), changed: true };
    },
  });
  __setLaunchDepsForTests({
    dagster: {
      launchRun: async () => ({ ok: true, data: { runId: 'run_fake', status: 'QUEUED' } }),
      assetGraph: async () => ({ ok: true, data: [] }),
      runsForDataset: async () => ({ ok: true, data: [] }),
    },
    head: async () => 'c'.repeat(40),
    sleep: async () => {},
  });
  __setMutationDepsForTests({ platform: async () => 'snowflake', queryFn: async () => ({ rows: [['0']] }) });
});

afterEach(async () => {
  // Commits are fire-and-forget per domain: drain them HERE or one test's commit lands inside the
  // next test's observations (which is how the coin test first went red).
  await awaitDataProjectCommits();
  uninstall?.();
  uninstall = null;
  __setDataProjectGitForTests(null);
  __setLaunchDepsForTests(null);
  __setMutationDepsForTests(null);
});

const ID_RE = /\bds_[A-Za-z0-9_]+/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const CHK_RE = /\bchk_[0-9a-f]+/g;
const scrub = (t: string) => t.replace(ISO, '<TS>').replace(ID_RE, '<ID>').replace(CHK_RE, '<CHK>');

/** The registry row, with everything random or clock-driven normalised away. */
function normalisedDataset(id: string): unknown {
  const d = store.getDataset(id, amir);
  return JSON.parse(scrub(JSON.stringify({ ...d, id: '<ID>', createdAt: '<TS>', updatedAt: '<TS>' })));
}

function changed(path: string, content: string): ChangedFile {
  return { path, status: 'added', content };
}

// ----------------------------------------------------------------------- the contract ---

test('the kind matches schema.yml and model SQL, and nothing outside models/', () => {
  assert.equal(matchesDbt('models/gold/schema.yml'), true);
  assert.equal(matchesDbt('models/personal/amir/silver_orders.sql'), true);
  assert.equal(matchesDbt('models/schema.yml'), true);
  assert.equal(matchesDbt('os/schedules.yml'), false);
  assert.equal(matchesDbt('agents/triage/system.yaml'), false);
  assert.equal(matchesDbt('dbt_project.yml'), false);
});

test('registerDbtIngest publishes exactly one kind to the gate', () => {
  registerDbtIngest();
  assert.deepEqual(registeredRepoKinds().map((k) => k.kind), [DATASET_KIND]);
});

test('`models/personal/<uid>/` agrees with the Trino personal schema — no drift', () => {
  assert.equal(personalDataLane('amir'), `models/personal/${personalSchema('amir').replace('personal_', '')}/`);
  assert.equal(personalDataLane('amir@acme.com'), `models/personal/${personalSchema('amir@acme.com').replace('personal_', '')}/`);
});

// --------------------------------------------------------------------------- the gate ---

test('the dbt gate refuses what `dbt parse` would refuse — and says which file and why (E5)', () => {
  const y = (s: string) => validateDbtFile({ path: 'models/gold/schema.yml', content: s });
  assert.match(String(y('version: 2\nmodels: [oh dear')), /not valid YAML/);
  assert.match(String(y('version: 1\nmodels: []\n')), /must declare `version: 2`/);
  assert.match(String(y('version: 2\nmodels: {}\n')), /`models:` must be a list/);
  assert.match(String(y('version: 2\nmodels:\n  - description: x\n')), /no `name`/);
  assert.match(String(y('version: 2\nmodels:\n  - name: 9lives\n')), /not a usable dbt identifier/);
  assert.match(String(y('version: 2\nmodels:\n  - name: ok\n    columns:\n      - description: x\n')), /column with no `name`/);
  assert.match(String(y('version: 2\nmodels:\n  - name: ok\n    columns:\n      - name: "a b"\n')), /not a usable dbt identifier/);
  assert.equal(y('version: 2\nmodels:\n  - name: gold_orders\n'), null);
  // A sources-only file is legal dbt.
  assert.equal(y('version: 2\nsources:\n  - name: raw\n'), null);

  const sql = (p: string, c: string) => validateDbtFile({ path: p, content: c });
  assert.equal(sql('models/gold/gold_orders.sql', 'select 1\n'), null);
  assert.match(String(sql('models/gold/gold_orders.sql', '   ')), /cannot build a model with no SQL/);
  assert.match(String(sql('models/gold/9lives.sql', 'select 1\n')), /not a usable dbt model name/);
});

test('readSchemaYml names what is wrong rather than throwing', () => {
  assert.deepEqual(readSchemaYml('version: 2\nmodels: []\n'), { models: [] });
  assert.ok('error' in readSchemaYml('[1,2,3]'));
  assert.ok('error' in readSchemaYml(''));
});

// -------------------------------------------------------------------- the reverse map ---

test('layer and schema come from the file, then the directory, then the model-name prefix', () => {
  assert.equal(layerOf('models/gold/x.sql', 'x', { os_layer: 'silver' }), 'silver');
  assert.equal(layerOf('models/gold/schema.yml', 'anything', {}), 'gold');
  assert.equal(layerOf('models/personal/amir/schema.yml', 'silver_orders', {}), 'silver');
  assert.equal(layerOf('models/personal/amir/schema.yml', 'orders', {}), 'bronze');
  assert.equal(schemaOf('models/personal/amir/schema.yml', 'sales'), 'personal_amir');
  assert.equal(schemaOf('models/gold/schema.yml', 'sales'), 'sales');
  assert.equal(schemaOf('models/gold/schema.yml', 'agentic-leader-q3'), 'agentic_leader_q3');
});

test('every dbt test shape maps to a rule, or is REPORTED rather than guessed', () => {
  assert.deepEqual(testToRule('id', 'not_null'), { rule: { rule: 'not_null', column: 'id', name: 'not_null(id)' } });
  assert.deepEqual(testToRule('id', 'unique'), { rule: { rule: 'unique', column: 'id', name: 'unique(id)' } });
  assert.deepEqual(testToRule('name', 'not_blank'), { rule: { rule: 'not_blank', column: 'name', name: 'not_blank(name)' } });
  assert.deepEqual(testToRule('status', { accepted_values: { values: ['new', 'won'] } }), {
    rule: { rule: 'accepted_values', column: 'status', values: ['new', 'won'], name: 'accepted_values(status)' },
  });
  assert.deepEqual(testToRule('amount', { range: { min: 0, max: 10 } }), {
    rule: { rule: 'range', column: 'amount', min: 0, max: 10, name: 'range(amount)' },
  });
  // Reported, never guessed: a relationships test names a MODEL, an OS rule needs a DATASET.
  assert.match(String((testToRule('cid', { relationships: { to: "ref('dim_customer')", field: 'id' } }) as { skip: string }).skip), /needs the referenced dataset/);
  assert.match(String((testToRule('id', { accepted_values: { values: [] } }) as { skip: string }).skip), /lists no values/);
  assert.match(String((testToRule('id', { range: {} }) as { skip: string }).skip), /neither min nor max/);
  assert.match(String((testToRule('id', 'dbt_utils.expression_is_true') as { skip: string }).skip), /stays a dbt test only/);
});

test('the reverse map reads what the OS GENERATOR writes — identity, layer, columns, rules', () => {
  // The golden fixture IS the generator's output (`tabs/data/lib/dbt/generate.test.ts` keeps it
  // in step with `renderSchemas`). A reverse map that cannot read what the forward map writes is
  // not a reverse map, so this reads the real bytes rather than a hand-written sample.
  const golden = JSON.parse(
    readFileSync(new URL('./fixtures/composition-with-tests.golden.json', import.meta.url), 'utf8'),
  ) as Record<string, string>;

  const personal = datasetsFromSchemaYml('models/personal/amir/schema.yml', golden['models/personal/amir/schema.yml'], 'sales');
  assert.deepEqual(personal.map((m) => m.model).sort(), ['gold_order_customer', 'silver_orders']);

  const oc = personal.find((m) => m.model === 'gold_order_customer')!;
  assert.equal(oc.datasetId, 'ds_oc000001', 'config.meta.os_dataset is the identity the OS wrote');
  assert.equal(oc.layer, 'gold');
  assert.equal(oc.schema, 'personal_amir'); // un-promoted work lives in the personal lane
  assert.match(oc.description, /^gold layer of OS dataset ds_oc000001/);
  assert.deepEqual(oc.columns, [
    { name: 'customer_id', description: 'Customer key' },
    { name: 'customer_name', description: '' },
    { name: 'total_amount', description: 'Sum of order amounts' },
  ]);
  // not_null + range come back as rules; the relationships test is REPORTED, not guessed; and the
  // generator's own `os_intentions` come back as the free-text rules they are.
  assert.deepEqual(
    oc.rules.filter((r) => r.rule).map((r) => ({ rule: r.rule, column: r.column, min: r.min })),
    [
      { rule: 'not_null', column: 'customer_id', min: undefined },
      { rule: 'range', column: 'total_amount', min: 0 },
    ],
  );
  assert.deepEqual(
    oc.rules.filter((r) => !r.rule).map((r) => r.name),
    ['Reconcile monthly with finance', 'reference(customer_id -> ds_elsewhere.customer_id)'],
  );
  assert.match(oc.notes.join(' '), /relationships on customer_id needs the referenced dataset/);

  const silver = datasetsFromSchemaYml('models/silver/schema.yml', golden['models/silver/schema.yml'], 'sales');
  assert.equal(silver.length, 1);
  assert.equal(silver[0].datasetId, 'ds_cust0001');
  assert.equal(silver[0].layer, 'silver');
  assert.equal(silver[0].schema, 'sales'); // a promoted layer lives in the domain schema
  assert.deepEqual(silver[0].rules, []);
});

// ------------------------------------------------------------------------- the ingest ---

test('a pushed schema.yml with NO os_dataset creates the dataset (name, columns, rules) (E9)', async () => {
  const yaml = [
    'version: 2',
    'models:',
    '  - name: silver_leads',
    '    columns:',
    '      - name: id',
    '        description: the lead id',
    '        data_tests:',
    '          - not_null',
    '          - unique',
    '      - name: stage',
    '        data_tests:',
    '          - accepted_values:',
    '              values: ["new", "qualified"]',
    '',
  ].join('\n');
  const report = await ingestDbtModels({
    domain: 'sales',
    files: [changed(`${personalDataLane('amir')}schema.yml`, yaml)],
    pusher,
    sha: 'a'.repeat(40),
  });
  assert.equal(report.created, 1);
  assert.equal(report.skipped, 0);
  const d = store.listAllDatasets()[0];
  assert.equal(d.name, 'silver_leads');
  assert.equal(d.domain, 'sales');
  assert.equal(d.owner, 'amir');
  assert.deepEqual(d.columns.map((c) => c.name), ['id', 'stage']);
  assert.deepEqual(
    (d.checks ?? []).map((c) => `${c.rule}(${c.column})`).sort(),
    ['accepted_values(stage)', 'not_null(id)', 'unique(id)'],
  );
});

test('a RE-push of the same schema.yml adds no duplicate rules', async () => {
  const yaml = 'version: 2\nmodels:\n  - name: silver_leads\n    columns:\n      - name: id\n        data_tests:\n          - not_null\n';
  const file = changed(`${personalDataLane('amir')}schema.yml`, yaml);
  await ingestDbtModels({ domain: 'sales', files: [file], pusher, sha: 'a'.repeat(40) });
  const id = store.listAllDatasets()[0].id;
  const after = await ingestDbtModels({
    domain: 'sales',
    files: [{ ...file, status: 'modified' }],
    pusher,
    sha: 'b'.repeat(40),
  });
  // The file carries no `os_dataset`, so the second push cannot RESOLVE the dataset the first one
  // created. It is reported (a name clash), never silently merged and never duplicated — and the
  // dataset the first push created still has exactly one rule.
  assert.equal(after.created, 0);
  assert.equal(after.skipped, 1);
  assert.equal((store.getDataset(id, amir).checks ?? []).length, 1);
  assert.equal(store.listAllDatasets().length, 1);
});

test('an os_dataset the pusher may not edit is SKIPPED with the reason — never a foreign write', async () => {
  const mine = createDatasetService(amir, { name: 'silver_orders', domain: 'sales' });
  const foreign = 'ds_not_mine_at_all';
  const yaml = `version: 2\nmodels:\n  - name: silver_orders\n    config:\n      meta:\n        os_dataset: ${foreign}\n`;
  const report = await ingestDbtModels({
    domain: 'sales',
    files: [changed('models/silver/schema.yml', yaml)],
    pusher,
    sha: 'a'.repeat(40),
  });
  assert.equal(report.updated, 0);
  assert.equal(report.skipped, 1);
  assert.match(report.notes.join(' '), /silver_orders/);
  // Nothing was written anywhere.
  assert.equal(store.listAllDatasets().length, 1);
  assert.equal(store.getDataset(mine.id, amir).name, 'silver_orders');
});

test('REMOVING a schema.yml does not delete the dataset — it is reported, not acted on', async () => {
  const d = createDatasetService(amir, { name: 'silver_orders', domain: 'sales' });
  const report = await ingestDbtModels({
    domain: 'sales',
    files: [{ path: 'models/silver/schema.yml', status: 'deleted', content: null }],
    pusher,
    sha: 'a'.repeat(40),
  });
  assert.equal(report.skipped, 1);
  assert.match(report.notes.join(' '), /retire the dataset in the OS to delete it/);
  assert.equal(store.getDataset(d.id, amir).id, d.id);
});

test('a .sql change on its own is a BUILD input — the registry is untouched', async () => {
  const report = await ingestDbtModels({
    domain: 'sales',
    files: [changed('models/silver/silver_orders.sql', 'select 1\n')],
    pusher,
    sha: 'a'.repeat(40),
  });
  assert.deepEqual(report, { kind: DATASET_KIND, created: 0, updated: 0, skipped: 0, notes: [] });
  assert.equal(store.listAllDatasets().length, 0);
});

test('AUDIENCE IS NOT PUSHABLE: a pushed os_tier that disagrees with the registry is REFUSED', async () => {
  const d = createDatasetService(amir, { name: 'silver_orders', domain: 'sales' });
  assert.equal(d.tier, 'dataset');
  const yaml = [
    'version: 2',
    'models:',
    '  - name: silver_orders',
    '    config:',
    '      meta:',
    `        os_dataset: ${d.id}`,
    '        os_tier: certified',
    '',
  ].join('\n');
  const report = await ingestDbtModels({
    domain: 'sales',
    files: [changed('models/silver/schema.yml', yaml)],
    pusher,
    sha: 'a'.repeat(40),
  });
  assert.equal(report.updated, 0);
  assert.equal(report.skipped, 1);
  assert.match(report.notes.join(' '), /audience is managed by the OS; use promotion/);
  assert.equal(store.getDataset(d.id, amir).tier, 'dataset', 'the tier the OS holds is unchanged');

  // The SAME file with the tier the OS already holds is an ordinary update.
  const agreeing = yaml.replace('os_tier: certified', `os_tier: ${d.tier}`);
  const ok = await ingestDbtModels({
    domain: 'sales',
    files: [changed('models/silver/schema.yml', agreeing)],
    pusher,
    sha: 'b'.repeat(40),
  });
  assert.equal(ok.updated, 1);
  assert.equal(ok.skipped, 0);
});

// ------------------------------------------------------------------------------ the coin ---

test('THE COIN: the same dataset over the MCP and by a push leaves identical files and an identical row', async () => {
  const columns = [
    { name: 'id', description: '' },
    { name: 'stage', description: '' },
  ];
  const rules = [
    { rule: 'not_null', column: 'id' },
    { rule: 'accepted_values', column: 'stage', values: ['new', 'qualified'] },
  ];

  // --- side A: the MCP door ------------------------------------------------------------
  let idA = '';
  runWithSurface('mcp:create_dataset', () => {
    idA = createDatasetService(amir, { name: 'silver_leads', domain: 'sales', columns }).id;
    defineQualityRulesService(amir, idA, rules);
  });
  await awaitDataProjectCommits();
  const rowA = normalisedDataset(idA);
  const commitsA = commits;
  assert.ok(commitsA.length > 0, 'the MCP door must commit');
  assert.deepEqual([...new Set(commitsA.map((c) => c.trailers['OS-Surface']))], ['mcp:create_dataset']);

  // --- side B: the push door -----------------------------------------------------------
  store.__resetStore();
  commits = [];
  const yaml = [
    'version: 2',
    'models:',
    '  - name: silver_leads',
    '    columns:',
    '      - name: id',
    '        data_tests:',
    '          - not_null',
    '      - name: stage',
    '        data_tests:',
    '          - accepted_values:',
    '              values: ["new", "qualified"]',
    '',
  ].join('\n');
  await ingestDbtModels({
    domain: 'sales',
    files: [changed(`${personalDataLane('amir')}schema.yml`, yaml)],
    pusher,
    sha: 'a'.repeat(40),
  });
  await awaitDataProjectCommits();
  const idB = store.listAllDatasets()[0].id;
  const rowB = normalisedDataset(idB);
  const commitsB = commits;
  assert.ok(commitsB.length > 0, 'the push door must commit');
  assert.deepEqual([...new Set(commitsB.map((c) => c.trailers['OS-Surface']))], ['git:push']);

  // IDENTICAL REGISTRY STATE.
  assert.deepEqual(rowB, rowA);

  // IDENTICAL FILES: the generated project at the END of each sequence, byte for byte.
  const lastA = commitsA[commitsA.length - 1];
  const lastB = commitsB[commitsB.length - 1];
  assert.deepEqual(
    lastB.files.map(([p, c]) => [p, scrub(c)]),
    lastA.files.map(([p, c]) => [p, scrub(c)]),
  );
  // IDENTICAL AUTHOR and action; the surface is the one thing that differs.
  assert.deepEqual(lastB.author, lastA.author);
  assert.equal(scrub(lastB.subject).replace('git:push', 'X'), scrub(lastA.subject).replace('mcp:create_dataset', 'X'));
  assert.equal(lastB.trailers['OS-Action'], lastA.trailers['OS-Action']);
});
