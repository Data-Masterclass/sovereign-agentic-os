/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The generated `schema.yml` is inert — no SQL and no Jinja injection from authored text
 * USER STORY: As a platform owner I want proof that nothing a user types into a dataset can become
 *             SQL inside a dbt test that runs as the dataset's owner, or a Jinja expression dbt
 *             evaluates in the parsing pod — where the only secret that pod holds is the OS's
 *             cluster-internal runtime bearer.
 * ARCHITECTURE:
 *   - Pure renderer, pure assertions: `checkToTest` / `renderSchemas` take data and return bytes.
 *   - Review B2-review-H2 (`accepted_values` SQL injection) and B2-review-H3 (Jinja in authored
 *     descriptions and names). The store-side half of the same pair lives in `store.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkToTest, checksToColumnTests, columnDocs, renderSchemas } from '@tabs/data/lib/dbt/schema';
import { stripJinja } from '@tabs/data/lib/dbt/emit';
import { isSafeCheckValue, parseDataset, type DataCheck, type Dataset } from '@tabs/data/lib/dataset-schema';
import type { ModelPlan } from '@tabs/data/lib/dbt/models';

function check(over: Partial<DataCheck> = {}): DataCheck {
  return {
    id: 'chk_1', name: 'Status is known', description: '', createdBy: 'bea', createdAt: '2026-11-13T06:00:00.000Z',
    rule: 'accepted_values', column: 'status', values: ['open', 'closed'], ...over,
  };
}

function dataset(over: Record<string, unknown> = {}): Dataset {
  return parseDataset(
    JSON.stringify({
      id: 'ds_1', name: 'Events', domain: 'sales', owner: 'bea', tier: 'dataset', origin: 'ingested',
      description: 'Order events.', columns: [{ name: 'status', description: 'The state.' }],
      versions: { bronze: { built: true }, silver: { built: false }, gold: { built: false } },
      ...over,
    }),
  );
}

function plan(d: Dataset): ModelPlan {
  return { name: 'bronze_events', dir: 'models/bronze', layer: 'bronze', path: 'models/bronze/bronze_events.sql', sql: '', schema: 'personal_bea', dataset: d, tested: true } as ModelPlan;
}

test('accepted_values: a clean value set becomes a test', () => {
  assert.deepEqual(checkToTest(check()), { accepted_values: { values: ['open', 'closed'] } });
});

test('accepted_values: a quote-bearing value disqualifies the WHOLE check, it never becomes a test', () => {
  // dbt emits each value as `'{{ value }}'` with no escaping, so this closes the literal and
  // appends a predicate to a query that runs AS the dataset's owner (review B2-review-H2).
  const injected = check({ values: ["x' or 1=1 or 'y", 'open'] });
  assert.equal(checkToTest(injected), null, 'an unsafe value must not yield a test');
  const { tests, intentions } = checksToColumnTests([injected]);
  assert.equal(tests.size, 0);
  assert.deepEqual(intentions, ['Status is known'], 'it is recorded as an intention instead');
  // And the partial set is NOT emitted: enforcing a narrower rule than the author wrote would
  // look like their rule and silently be a different one.
  const yaml = [...renderSchemas([plan(dataset({ checks: [injected] }))]).values()].join('\n');
  assert.ok(!yaml.includes('accepted_values'), 'no test at all');
  assert.ok(!yaml.includes('1=1'), 'the injected value never reaches the tree');
  assert.ok(yaml.includes('os_intentions'));
});

test('accepted_values: Jinja, control characters and over-long values are refused too', () => {
  for (const bad of ["{{ env_var('AGENT_RUNTIME_TOKEN') }}", '{% for x in y %}', 'a\nb', 'a\\b', 'a`b', 'x'.repeat(201)]) {
    assert.equal(isSafeCheckValue(bad), false, `unsafe value accepted: ${JSON.stringify(bad)}`);
    assert.equal(checkToTest(check({ values: [bad] })), null, `unsafe value emitted: ${JSON.stringify(bad)}`);
  }
  assert.equal(isSafeCheckValue('open'), true);
  assert.equal(isSafeCheckValue('x'.repeat(200)), true);
  assert.equal(isSafeCheckValue(''), false);
  assert.equal(isSafeCheckValue(42), false);
});

test('an authored description or name never reaches schema.yml as Jinja', () => {
  // dbt renders schema.yml THROUGH JINJA before reading it, so `env_var` in a description would be
  // evaluated by `dbt parse` and land in target/manifest.json, which the OS reads back.
  const payload = "{{ env_var('AGENT_RUNTIME_TOKEN') }}";
  const d = dataset({
    name: `Events ${payload}`,
    description: `Orders ${payload}`,
    columns: [{ name: 'status', description: `State ${payload}` }],
    checks: [check({ rule: undefined, column: undefined, values: undefined, name: `Intention ${payload}` })],
  });
  const yaml = [...renderSchemas([plan(d)]).values()].join('\n');
  assert.ok(!yaml.includes(payload), 'the verbatim Jinja expression reached schema.yml');
  assert.ok(!yaml.includes('{{') && !yaml.includes('}}'), 'a Jinja delimiter reached schema.yml');
  assert.ok(yaml.includes("env_var('AGENT_RUNTIME_TOKEN')"), 'the text itself is kept — only the delimiters go');
  const docs = columnDocs(d, true);
  assert.ok(!JSON.stringify(docs).includes('{{'));
});

test('stripJinja removes every delimiter kind and leaves clean prose alone', () => {
  assert.equal(stripJinja('{{ a }}{% b %}{# c #}'), ' a  b  c ');
  assert.equal(stripJinja('Order events, 99% of them.'), 'Order events, 99% of them.');
  assert.equal(stripJinja(''), '');
});

// -------------------------------- D5 follow-up: `reference` → dbt `relationships` --

/** A `reference` rule, by default pointing at a dataset the resolver below knows. */
function ref(over: Partial<DataCheck> = {}): DataCheck {
  return check({ name: 'Customer exists', rule: 'reference', column: 'customer_id', values: undefined, toDataset: 'ds_cust01', toColumn: 'customer_id', ...over });
}

/** The plan's dataset → model-name map, as `modelRefResolver` builds it. */
const resolve = (id: string) => (id === 'ds_cust01' ? 'silver_customers' : null);

test('reference: a resolvable target becomes dbt’s own relationships test, pointed at the MODEL', () => {
  assert.deepEqual(checkToTest(ref(), resolve), {
    relationships: { to: "ref('silver_customers')", field: 'customer_id' },
  });
});

test('reference: a target with no model in THIS project is an intention, never a broken ref()', () => {
  // `ref('…')` on an unknown name fails `dbt parse` — which takes the WHOLE domain's project down,
  // not just this test. Degrading to an intention is the only safe answer.
  const far = ref({ toDataset: 'ds_elsewhere' });
  assert.equal(checkToTest(far, resolve), null);
  const { tests, intentions } = checksToColumnTests([far], resolve);
  assert.equal(tests.size, 0);
  assert.deepEqual(intentions, ['Customer exists']);
});

test('reference: with NO resolver nothing is emitted — a caller that cannot name models gets intentions', () => {
  assert.equal(checkToTest(ref()), null);
});

test('reference: the referenced COLUMN gets the same identifier gate as the checked one', () => {
  // `field` is interpolated unquoted into the relationships test's SQL, so it is the same class of
  // hole as `accepted_values`' values — and must fail the same way: no test at all.
  for (const bad of ['customer_id; drop table x', "id' or '1'='1", '{{ env_var("X") }}', 'has space', '1leading']) {
    assert.equal(checkToTest(ref({ toColumn: bad }), resolve), null, `toColumn '${bad}' must not become a test`);
  }
  // A missing target is equally inert.
  assert.equal(checkToTest(ref({ toColumn: '' }), resolve), null);
  assert.equal(checkToTest(ref({ toDataset: '' }), resolve), null);
});

test('reference: the model name comes from the PLAN, so authored text can never reach ref()', () => {
  // Even if a resolver somehow returned a hostile name, the identifier gate refuses it rather
  // than writing Jinja the parse pod would evaluate.
  const hostile = () => "x') }}{{ env_var('OS_RUNTIME_BEARER";
  assert.equal(checkToTest(ref(), hostile), null);
});

test('reference: a rendered schema.yml carries the relationships test and still parses as YAML', () => {
  const d = dataset({
    columns: [{ name: 'customer_id', description: 'FK' }],
    checks: [ref()],
  });
  const customers = { ...plan(d), name: 'silver_customers', dataset: parseDataset(JSON.stringify({ id: 'ds_cust01', name: 'Customers', owner: 'bea', domain: 'sales', columns: [], versions: {} })) } as ModelPlan;
  const files = renderSchemas([plan(d), customers]);
  const yml = files.get('models/bronze/schema.yml')!;
  assert.match(yml, /relationships:/);
  assert.match(yml, /to: ref\('silver_customers'\)/);
  assert.match(yml, /field: customer_id/);
});
