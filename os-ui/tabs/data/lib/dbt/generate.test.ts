/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    dbt project generator tests — byte-stability, three golden shapes, body parity
 * USER STORY: As a maintainer I want proof that the same OS state yields a byte-identical project
 *             (D3), that the three canonical shapes render as the concept specifies (D1, D4, D6), and
 *             that a composition's model body IS today's compileGoldJoin SELECT after FQN → ref().
 * ARCHITECTURE:
 *   - Pure: literal `Dataset` fixtures, no store, no cluster. Goldens live in
 *     `fixtures/<shape>.golden.json` (path → content); `REGEN_GOLDEN=1` rewrites them — review the diff.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { Dataset } from '@tabs/data/lib/dataset-schema';
import { emptyVersions } from '@tabs/data/lib/dataset-schema';
import { compileGoldJoin, compileSilver } from '@tabs/data/lib/transform';
import { generateProject } from '@tabs/data/lib/dbt/generate';
import { planModels, rewriteFqns, stripCtas } from '@tabs/data/lib/dbt/models';
import type { ProjectSnapshot } from '@tabs/data/lib/dbt/snapshot';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

function ds(input: Partial<Dataset> & { id: string; name: string; owner: string; domain: string }): Dataset {
  return {
    version: '1',
    tier: 'dataset',
    visibility: 'private',
    folder: '/',
    description: '',
    versions: emptyVersions(),
    grants: [],
    measures: [],
    columns: [],
    viewNamespaced: true,
    ...input,
  };
}

const built = (artifact: string | null, passThrough = false) => ({ built: true, passThrough, quality: 'unknown' as const, updatedAt: '2026-11-13T00:00:00.000Z', artifact });
const unbuilt = { built: false, passThrough: false, quality: 'unknown' as const, updatedAt: null, artifact: null };

// ---- Shape (a): an ingested pass-through dataset (bronze landed, silver + gold carried forward).
function shapeIngested(): ProjectSnapshot {
  const orders = ds({
    id: 'ds_orders1',
    name: 'Orders',
    owner: 'amir',
    domain: 'sales',
    description: 'Raw web-shop orders.',
    columns: [
      { name: 'order_id', description: 'Order key' },
      { name: 'amount', description: 'Net amount (EUR)' },
      { name: '_loaded_at', description: 'Ingest timestamp' },
    ],
    versions: { bronze: built('bronze/orders.dlt.yml'), silver: built('silver/stg_orders.sql', true), gold: built('gold/mart_orders.sql', true) },
  });
  return { domain: 'sales', datasets: [{ dataset: orders, artifacts: {} }], catalogs: {} };
}

// ---- Shape (b): a two-dataset composition with a not_null and a range rule.
const silverOrdersSql = compileSilver({
  source: 'iceberg.personal_amir.bronze_orders',
  target: 'iceberg.personal_amir.silver_orders',
  columns: ['order_id', 'customer_id', 'amount'],
  ops: [{ kind: 'cast', column: 'amount', type: 'double' }, { kind: 'filter', column: 'order_id', op: 'not_null' }],
});
const goldSpec = {
  source: 'iceberg.personal_amir.silver_orders',
  joins: [{ table: 'iceberg.sales.silver_customers', type: 'inner' as const, on: [{ left: { ref: 0, column: 'customer_id' }, right: 'customer_id' }] }],
  dimensions: [{ col: { ref: 0, column: 'customer_id' } }, { col: { ref: 1, column: 'customer_name' } }],
  measures: [{ name: 'total_amount', agg: 'sum' as const, col: { ref: 0, column: 'amount' } }],
  target: 'iceberg.personal_amir.gold_order_customer',
};
const goldSql = compileGoldJoin(goldSpec);

function shapeComposition(): ProjectSnapshot {
  const orders = ds({
    id: 'ds_orders1',
    name: 'Orders',
    owner: 'amir',
    domain: 'sales',
    columns: [{ name: 'order_id', description: 'Order key' }, { name: 'customer_id', description: '' }, { name: 'amount', description: 'Net amount' }],
    versions: { bronze: built('bronze/orders.dlt.yml'), silver: built('silver/stg_orders.sql'), gold: unbuilt },
  });
  const customers = ds({
    id: 'ds_cust0001',
    name: 'Customers',
    owner: 'bea',
    domain: 'sales',
    tier: 'asset',
    visibility: 'domain',
    description: 'Customer master.',
    columns: [{ name: 'customer_id', description: 'Customer key' }, { name: 'customer_name', description: 'Display name' }],
    versions: { bronze: built('bronze/customers.dlt.yml'), silver: built('silver/stg_customers.sql', true), gold: unbuilt },
  });
  const composition = ds({
    id: 'ds_oc000001',
    name: 'Order Customer',
    owner: 'amir',
    domain: 'sales',
    origin: 'curated',
    description: 'Orders joined to customers.',
    columns: [{ name: 'customer_id', description: 'Customer key' }, { name: 'customer_name', description: '' }, { name: 'total_amount', description: 'Sum of order amounts' }],
    versions: { bronze: unbuilt, silver: unbuilt, gold: built('gold/mart_order_customer.sql') },
    upstreams: [
      { datasetId: 'ds_orders1', name: 'Orders', fqn: 'iceberg.personal_amir.silver_orders', joinType: 'inner' },
      { datasetId: 'ds_cust0001', name: 'Customers', fqn: 'iceberg.sales.silver_customers', joinType: 'inner' },
    ],
    checks: [
      { id: 'chk_1', name: 'not_null(customer_id)', description: '', createdBy: 'amir', createdAt: '2026-11-13T00:00:00.000Z', rule: 'not_null', column: 'customer_id' },
      { id: 'chk_2', name: 'range(total_amount)', description: 'Never negative', createdBy: 'amir', createdAt: '2026-11-13T00:00:00.000Z', rule: 'range', column: 'total_amount', min: 0 },
      { id: 'chk_3', name: 'Reconcile monthly with finance', description: 'free text', createdBy: 'amir', createdAt: '2026-11-13T00:00:00.000Z' },
    ],
  });
  return {
    domain: 'sales',
    datasets: [
      { dataset: orders, artifacts: { 'silver/stg_orders.sql': silverOrdersSql }, compiled: ['silver/stg_orders.sql'] },
      { dataset: customers, artifacts: {} },
      { dataset: composition, artifacts: { 'gold/mart_order_customer.sql': goldSql }, compiled: ['gold/mart_order_customer.sql'] },
    ],
    catalogs: {},
  };
}

// ---- Shape (c): an append sync with a timestamp cursor (connected, silver tier) + a merge sibling.
function shapeAppendSync(): ProjectSnapshot {
  const events = ds({
    id: 'ds_events01',
    name: 'Events',
    owner: 'bea',
    domain: 'sales',
    tier: 'asset',
    visibility: 'domain',
    description: 'Web events copied from the warehouse.',
    origin: 'connected',
    connected: { connectionId: 'conn_wh', exposureId: 'exp_1', source: { catalog: 'wh', schema: 'public', table: 'events' }, mode: 'sync', tier: 'silver', status: 'ok' },
    sync: { connectionId: 'conn_wh', source: { schema: 'public', table: 'events' }, mode: 'append', cursor: { kind: 'timestamp', column: 'updated_at' }, schedule: { cron: '*/15 * * * *' }, enabled: true },
    columns: [{ name: 'event_id', description: 'Event key' }, { name: 'updated_at', description: 'Cursor' }],
    checks: [{ id: 'chk_e', name: 'unique(event_id)', description: '', createdBy: 'bea', createdAt: '2026-11-13T00:00:00.000Z', rule: 'unique', column: 'event_id' }],
    versions: { bronze: unbuilt, silver: built(null), gold: unbuilt },
  });
  const accounts = ds({
    id: 'ds_accts001',
    name: 'Accounts',
    owner: 'bea',
    domain: 'sales',
    tier: 'asset',
    visibility: 'domain',
    origin: 'connected',
    connected: { connectionId: 'conn_wh', exposureId: 'exp_1', source: { catalog: 'wh', schema: 'public', table: 'accounts' }, mode: 'sync', tier: 'gold', status: 'ok' },
    sync: { connectionId: 'conn_wh', source: { schema: 'public', table: 'accounts' }, mode: 'merge', cursor: { kind: 'number', column: 'version' }, mergeKeys: ['account_id'], schedule: { cron: '0 6 * * *' }, enabled: false },
    versions: emptyVersions(),
  });
  return { domain: 'sales', datasets: [{ dataset: events, artifacts: {} }, { dataset: accounts, artifacts: {} }], catalogs: { conn_wh: 'wh' } };
}

const SHAPES: Record<string, () => ProjectSnapshot> = {
  'ingested-pass-through': shapeIngested,
  'composition-with-tests': shapeComposition,
  'append-sync-with-cursor': shapeAppendSync,
};

function toObject(files: Map<string, string>): Record<string, string> {
  return Object.fromEntries([...files.entries()]);
}

for (const [shape, make] of Object.entries(SHAPES)) {
  test(`golden: ${shape}`, () => {
    const files = generateProject('sales', make());
    const actual = toObject(files);
    const golden = join(FIXTURES, `${shape}.golden.json`);
    if (process.env.REGEN_GOLDEN === '1' || !existsSync(golden)) {
      mkdirSync(FIXTURES, { recursive: true });
      writeFileSync(golden, JSON.stringify(actual, null, 2) + '\n');
    }
    const expected = JSON.parse(readFileSync(golden, 'utf8')) as Record<string, string>;
    assert.deepEqual(actual, expected, `${shape} differs from its golden (REGEN_GOLDEN=1 to accept)`);
  });

  test(`byte-stable: ${shape} generated twice is identical`, () => {
    const a = generateProject('sales', make());
    const b = generateProject('sales', make());
    assert.deepEqual([...a.keys()], [...b.keys()]);
    for (const k of a.keys()) assert.equal(a.get(k), b.get(k), k);
    for (const [k, v] of a) assert.ok(v.endsWith('\n') && !v.endsWith('\n\n'), `${k} ends with exactly one newline`);
    assert.deepEqual([...a.keys()], [...a.keys()].sort(), 'keys sorted');
  });

  test(`valid yaml and no secrets: ${shape}`, () => {
    const files = generateProject('sales', make());
    for (const [k, v] of files) {
      // Every emitted `.yml` must still parse AS YAML, even the one carrying a Jinja guard — the
      // guard is therefore written as a YAML comment (B3-review, "impersonation reality").
      if (k.endsWith('.yml')) yaml.load(v);
      // A credential-shaped KEY is allowed, but ONLY as `env_var()` indirection: the repository is
      // readable by anyone who can clone it, so a literal value is what must never appear. Check
      // the key's value explicitly, then run the blanket word hunt over everything else.
      for (const m of v.matchAll(/^\s*(?:password|secret|token)\w*:\s*(.*)$/gim)) {
        assert.match(m[1], /^"\{\{\s*env_var\(/, `${k}: a credential key may only hold an env_var() call`);
      }
      const withoutEnvVars = v
        .replace(/^\s*(?:password|secret|token)\w*:.*$/gim, '')
        .replace(/\{[{%][^}]*[}%]\}/g, '');
      assert.doesNotMatch(withoutEnvVars, /password|secret|token/i, `${k} must not carry credentials`);
      assert.doesNotMatch(v, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, `${k} must not carry timestamps`);
    }
    assert.match(files.get('profiles.yml')!, /impersonation_user: "\{\{ env_var\('OS_PRINCIPAL'\) \}\}"/);
    assert.match(files.get('profiles.yml')!, /method: "\{\{ env_var\('TRINO_AUTH_METHOD', 'none'\) \}\}"/);
    // The password line exists, is guarded, and is never a literal.
    assert.match(
      files.get('profiles.yml')!,
      /# \{% if env_var\('TRINO_AUTH_METHOD', 'none'\) != 'none' %\}\n\s+password: "\{\{ env_var\('TRINO_PASSWORD', ''\) \}\}"\n\s+# \{% endif %\}/,
    );
  });
}

test('shape (a): bronze is a source with freshness, silver + gold are pass-through models in the personal lane', () => {
  const files = generateProject('sales', shapeIngested());
  assert.deepEqual(
    [...files.keys()].filter((k) => k.startsWith('models/')),
    ['models/personal/amir/gold_orders.sql', 'models/personal/amir/schema.yml', 'models/personal/amir/silver_orders.sql', 'models/sources.yml'],
  );
  const sources = yaml.load(files.get('models/sources.yml')!) as { sources: { name: string; schema: string; tables: { name: string; loaded_at_field?: string }[] }[] };
  assert.equal(sources.sources[0].name, 'personal_amir');
  assert.equal(sources.sources[0].tables[0].name, 'bronze_orders');
  assert.equal(sources.sources[0].tables[0].loaded_at_field, '_loaded_at');
  assert.match(files.get('models/personal/amir/silver_orders.sql')!, /select \* from \{\{ source\('personal_amir', 'bronze_orders'\) \}\}/);
  assert.match(files.get('models/personal/amir/gold_orders.sql')!, /select \* from \{\{ ref\('silver_orders'\) \}\}/);
  const project = yaml.load(files.get('dbt_project.yml')!) as { models: { sales: { personal: { amir: Record<string, string> } } } };
  assert.equal(project.models.sales.personal.amir['+schema'], 'personal_amir');
});

test('shape (b): the composition body equals today\'s compileGoldJoin SELECT after FQN → ref() substitution', () => {
  const files = generateProject('sales', shapeComposition());
  const model = files.get('models/personal/amir/gold_order_customer.sql')!;
  const body = model.split('\n').filter((l) => !l.startsWith('--')).join('\n').trim();
  const expected = stripCtas(goldSql)
    .replace('iceberg.personal_amir.silver_orders', "{{ ref('silver_orders') }}")
    .replace('iceberg.sales.silver_customers', "{{ ref('silver_customers') }}");
  assert.equal(body, expected);
  assert.match(expected, /^select t0\."customer_id" as "customer_id", t1\."customer_name" as "customer_name", sum\(t0\."amount"\) as "total_amount" from \{\{ ref\('silver_orders'\) \}\} t0 inner join \{\{ ref\('silver_customers'\) \}\} t1 on t0\."customer_id" = t1\."customer_id" group by t0\."customer_id", t1\."customer_name"$/);
  // The promoted Customers dataset is a domain model; Orders (personal) refs its Bronze source.
  assert.ok(files.has('models/silver/silver_customers.sql'));
  assert.match(files.get('models/personal/amir/silver_orders.sql')!, /\{\{ source\('personal_amir', 'bronze_orders'\) \}\}/);
  // Tests: not_null + range on the composition's gold; the free-text check is an intention, not a test.
  const schema = yaml.load(files.get('models/personal/amir/schema.yml')!) as { models: { name: string; config: { meta: Record<string, unknown> }; columns: { name: string; data_tests?: unknown[] }[] }[] };
  const gold = schema.models.find((m) => m.name === 'gold_order_customer')!;
  assert.deepEqual(gold.columns.find((c) => c.name === 'customer_id')!.data_tests, ['not_null']);
  assert.deepEqual(gold.columns.find((c) => c.name === 'total_amount')!.data_tests, [{ range: { min: 0 } }]);
  assert.deepEqual(gold.config.meta.os_intentions, ['Reconcile monthly with finance']);
  assert.deepEqual(gold.config.meta.os_upstreams, ['ds_cust0001', 'ds_orders1']);
  assert.ok(files.has('tests/generic/range.sql') && files.has('tests/generic/not_blank.sql'));
});

test('shape (c): append = delete+insert on _batch_id with the 15-minute lookback; merge = merge on keys; schedules listed', () => {
  const files = generateProject('sales', shapeAppendSync());
  const append = files.get('models/silver/silver_events.sql')!;
  assert.match(append, /incremental_strategy='delete\+insert', unique_key='_batch_id'/);
  assert.match(append, /where "updated_at" > \(select max\("updated_at"\) from \{\{ this \}\}\) - interval '15' minute/);
  assert.match(append, /'\{\{ var\("os_batch_id", invocation_id\) \}\}' as _batch_id/);
  assert.match(append, /\{\{ source\('wh__public', 'events'\) \}\}/);
  const merge = files.get('models/gold/gold_accounts.sql')!;
  assert.match(merge, /incremental_strategy='merge', unique_key=\['account_id'\]/);
  assert.match(merge, /where "version" > \(select max\("version"\) from \{\{ this \}\}\)\n/);
  const schedules = yaml.load(files.get('os/schedules.yml')!) as { schedules: Record<string, unknown>[] };
  assert.deepEqual(schedules.schedules, [
    { dataset: 'ds_accts001', name: 'gold_accounts', select: 'gold_accounts+', cron: '0 6 * * *', timezone: 'UTC', principal: 'bea', enabled: false },
    { dataset: 'ds_events01', name: 'silver_events', select: 'silver_events+', cron: '*/15 * * * *', timezone: 'UTC', principal: 'bea', enabled: true },
  ]);
  const sources = yaml.load(files.get('models/sources.yml')!) as { sources: { name: string; database: string; schema: string }[] };
  assert.deepEqual(sources.sources.map((s) => [s.name, s.database, s.schema]), [['wh__public', 'wh', 'public']]);
});

test('kafka-offset and API-batch syncs are external assets, never faked as models; unresolved catalogs are flagged', () => {
  const base = shapeAppendSync();
  const kafka = ds({
    id: 'ds_kafka001', name: 'Clicks', owner: 'bea', domain: 'sales',
    sync: { connectionId: 'conn_kafka', source: { schema: 'default', table: 'clicks' }, mode: 'append', cursor: { kind: 'kafka-offsets', column: '_partition_offset' }, schedule: { cron: '* * * * *' }, enabled: true },
    versions: { ...emptyVersions(), bronze: built(null) },
  });
  const sf = ds({
    id: 'ds_sf000001', name: 'Opportunities', owner: 'bea', domain: 'sales',
    sync: { connectionId: 'conn_sf', source: { schema: 'salesforce', table: 'Opportunity' }, mode: 'append', cursor: { kind: 'timestamp', column: 'SystemModstamp' }, schedule: { cron: '0 * * * *' }, enabled: true },
    versions: emptyVersions(),
  });
  const unresolved = ds({
    id: 'ds_unres001', name: 'Mystery', owner: 'bea', domain: 'sales',
    sync: { connectionId: 'conn_x', source: { schema: 's', table: 't' }, mode: 'full-refresh', schedule: { cron: '0 0 * * *' }, enabled: true },
    versions: emptyVersions(),
  });
  const snap: ProjectSnapshot = { ...base, datasets: [...base.datasets, { dataset: kafka, artifacts: {} }, { dataset: sf, artifacts: {} }, { dataset: unresolved, artifacts: {} }], catalogs: { ...base.catalogs, conn_sf: null } };
  const plan = planModels(snap);
  assert.deepEqual(plan.externals.map((e) => [e.dataset, e.kind]), [['ds_kafka001', 'kafka-offsets'], ['ds_sf000001', 'api-batch']]);
  assert.ok(!plan.models.some((m) => m.dataset.id === 'ds_kafka001' || m.dataset.id === 'ds_sf000001'));
  const mystery = plan.models.find((m) => m.dataset.id === 'ds_unres001')!;
  assert.equal(mystery.kind, 'sync-full-refresh');
  assert.equal(mystery.path, 'models/personal/bea/bronze_mystery.sql');
  const src = plan.sources.find((s) => s.source === 'conn_conn_x')!;
  assert.equal(src.database, undefined);
  assert.deepEqual(src.meta, { os_connection: 'conn_x', os_catalog: 'unresolved' });
  const files = generateProject('sales', snap);
  assert.ok(files.has('os/external.yml'));
});

test('rewriteFqns: models → ref, everything else → source (registered once); stripCtas removes the create prefix', () => {
  const seen: string[] = [];
  const map = new Map([['personal_amir.silver_orders', 'silver_orders']]);
  const out = rewriteFqns('select * from iceberg.personal_amir.silver_orders t0 join iceberg.finance.gold_fx t1 on t0."k" = t1."k" join wh.public.rates t2 on 1=1', map, (s) => {
    const name = s.catalog === 'iceberg' ? s.schema : `${s.catalog}__${s.schema}`;
    seen.push(`${name}/${s.table}`);
    return name;
  });
  assert.equal(out, "select * from {{ ref('silver_orders') }} t0 join {{ source('finance', 'gold_fx') }} t1 on t0.\"k\" = t1.\"k\" join {{ source('wh__public', 'rates') }} t2 on 1=1");
  assert.deepEqual(seen, ['finance/gold_fx', 'wh__public/rates']);
  assert.equal(stripCtas('create or replace table iceberg.x.y as select 1'), 'select 1');
  assert.equal(stripCtas('CREATE TABLE iceberg.x.y AS select 2'), 'select 2');
  assert.equal(stripCtas('select 3'), 'select 3');
});
