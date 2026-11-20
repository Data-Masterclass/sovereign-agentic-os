/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    Literal safety — strict identifiers, strict cron, free-text encoding, write-time refusal
 * USER STORY: As a domain owner I want a name or schedule that could become code to be refused when
 *             I save it, with the field named, and everything else to keep working unchanged.
 * ARCHITECTURE:
 *   - Pure unit tests of `literal.ts` and the core cron grammar, the store write paths (setDocs,
 *     setDatasetSync, addCheck) and the read-only preflight. The MCP half is in
 *     tabs/data/lib/dbt/literal-mcp.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidCron } from '@core/kernel/cron-util';
import {
  assertIdentifier,
  commentText,
  datasetLiteralIssues,
  decodeFreeText,
  freeText,
  isIdentifier,
  jinjaFreeSql,
  LiteralSafetyError,
  needsQuote,
} from '@tabs/data/lib/dbt/literal';
import { preflightDatasets, datasetsFromJson } from '@tabs/data/lib/dbt/literal-preflight';
import { DatasetError, emptyVersions, type Dataset } from '@tabs/data/lib/dataset-schema';
import { __resetStore, __seedDatasetForTest, addCheck, setDatasetSync, setDocs } from '@tabs/data/lib/store';
import { generateProject } from '@tabs/data/lib/dbt/generate';
import { baseSnapshot } from '@tabs/data/lib/dbt/literal-fuzz';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

test('cron: the strict 5-field grammar accepts the shapes the OS and operators write', () => {
  for (const ok of ['0 6 * * *', '*/15 * * * *', '0 * * * *', '30 2 1 * *', '0 6 * * 1-5', '0 6 * * MON-FRI', '0 0 1 JAN *', '5,35 8-18/2 * * 0,6', '0 0 * * 7']) {
    assert.equal(isValidCron(ok), true, ok);
  }
});

test('cron: everything else is refused — braces, control characters, extra fields, out-of-range values', () => {
  for (const bad of ['0 6 * * {{x}}', '{}}{x}%}} 6 * * *', '0\r6 * * *', '0 6 * * *\n', ' 0 6 * * *', '0  6 * * *', '0 6 * *', '0 6 * * * *', '@daily', '0 6 ? * *', '0 6 L * *', '60 * * * *', '0 24 * * *', '0 0 0 * *', '0 0 * 13 *', '0 0 * * 8', '5/10 * * * *', '*/0 * * * *', '0 6 * * MON#2', "0 6 * * '1'", '0 6 * * 1 ']) {
    assert.equal(isValidCron(bad), false, JSON.stringify(bad));
  }
});

test('identifiers: closed allow-lists, typed refusal naming the field', () => {
  assert.ok(isIdentifier('sql', 'order_id'));
  assert.ok(isIdentifier('sql', '_loaded_at'));
  assert.ok(isIdentifier('domain', 'agentic-leader-q3-2026'));
  assert.ok(isIdentifier('principal', 'alice.smith@example.com'));
  assert.ok(isIdentifier('connection_id', 'conn-postgres'));
  assert.ok(isIdentifier('dataset_id', 'ds_ab12cd'));
  for (const bad of ['', '1abc', 'order id', 'a-b', 'x{{y}}', "a'b", 'a"b', 'a\nb', 'a b', 'é', 'a'.repeat(129)]) {
    assert.equal(isIdentifier('sql', bad), false, JSON.stringify(bad));
  }
  assert.equal(isIdentifier('domain', 'Sales'), false);
  assert.equal(isIdentifier('principal', 'a b'), false);
  assert.equal(isIdentifier('connection_id', 'conn{x}'), false);
  assert.throws(() => assertIdentifier('sql', 'sync.source.table', 'x{{y}}'), (e: unknown) => e instanceof LiteralSafetyError && e.code === 'invalid_identifier' && e.field === 'sync.source.table');
});

test('freeText: no ASCII brace survives any input, the words stay, and decoding restores the text', () => {
  for (const s of ['{{ a }}', '{}}{ x }%}}', '}%}}', '{}}%', '%{%}', '{#}{{ x }}{#}', 'plain prose, 100% fine', '']) {
    const out = freeText(s);
    assert.doesNotMatch(out, /[{}]/, s);
    assert.equal(decodeFreeText(out), s);
  }
  assert.equal(commentText('a\r\nb c d\u0085e{{f}}'), 'a b c d e｛｛f｝｝');
});

test('jinjaFreeSql: a braced string literal becomes the equivalent Trino Unicode literal; a stray brace is refused', () => {
  assert.equal(jinjaFreeSql("select 1 where a = '{x}' and b = 'it''s'", 'body'), "select 1 where a = U&'\\007Bx\\007D' and b = 'it''s'");
  assert.equal(jinjaFreeSql("where a = 'a\\b{'", 'body'), "where a = U&'a\\\\b\\007B'");
  assert.equal(jinjaFreeSql("where a = 'q''{'", 'body'), "where a = U&'q''\\007B'");
  assert.throws(() => jinjaFreeSql('select {{ x }}', 'body'), LiteralSafetyError);
  assert.throws(() => jinjaFreeSql("select 'open", 'body'), LiteralSafetyError);
});

test('a Trino reserved word as a column name is emitted with dbt\'s documented `quote: true`', () => {
  assert.ok(needsQuote('order') && needsQuote('DATE') === false && needsQuote('user') === false);
  const s = baseSnapshot();
  s.datasets[0].dataset.columns[1].name = 'order';
  s.datasets[0].dataset.checks![1].column = 'order';
  const schema = [...generateProject('sales', s).entries()].find(([p]) => p.endsWith('schema.yml') && p.includes('silver'))![1];
  assert.match(schema, /- name: order\n\s+description: Sales region\n\s+quote: true/);
});

const user = { id: 'amir', domains: ['sales'], role: 'creator' as const };
function seeded(): string {
  __resetStore();
  __seedDatasetForTest({ id: 'ds_lit1', name: 'Lit', owner: 'amir', domain: 'sales' });
  return 'ds_lit1';
}
const isTyped = (code: string, field: RegExp) => (e: unknown) => e instanceof DatasetError && e.status === 400 && e.code === code && field.test(e.field ?? '');
const goodSync = () => ({ connectionId: 'conn-crm', source: { schema: 'crm', table: 'customers' }, mode: 'full-refresh' as const, schedule: { cron: '0 6 * * *' }, enabled: true });

test('write time: setDocs refuses a non-identifier column name with a typed error', () => {
  const id = seeded();
  assert.throws(() => setDocs(id, user, { columns: [{ name: "x {{ log('a') }}", description: '' }] }), isTyped('invalid_identifier', /^columns\[0\]\.name$/));
  assert.throws(() => setDocs(id, user, { columns: [{ name: 'order id', description: '' }] }), isTyped('invalid_identifier', /columns/));
  // Free text in a description is accepted (it is encoded on the way into dbt).
  setDocs(id, user, { description: '{{ x }}', columns: [{ name: 'order_id', description: '{% do x %}' }] });
});

test('write time: setDatasetSync refuses every non-identifier and a non-strict cron', () => {
  const id = seeded();
  setDatasetSync(id, user, goodSync());
  const bad: [Record<string, unknown>, string, RegExp][] = [
    [{ connectionId: 'c{{x}}' }, 'invalid_identifier', /sync\.connectionId/],
    [{ source: { schema: 'crm{{x}}', table: 'customers' } }, 'invalid_identifier', /sync\.source\.schema/],
    [{ source: { schema: 'crm', table: "customers\r' or 1" } }, 'invalid_identifier', /sync\.source\.table/],
    [{ schedule: { cron: '0 6 * * {{x}}' } }, 'invalid_cron', /sync\.schedule\.cron/],
    [{ schedule: { cron: '0\r6 * * *' } }, 'invalid_cron', /cron/],
    [{ mode: 'merge', mergeKeys: ['id}}'], cursor: { kind: 'number', column: 'id' } }, 'invalid_identifier', /sync\.mergeKeys\[0\]/],
    [{ mode: 'append', cursor: { kind: 'timestamp', column: 'updated at' } }, 'invalid_identifier', /sync\.cursor\.column/],
  ];
  for (const [patch, code, field] of bad) {
    assert.throws(() => setDatasetSync(id, user, { ...goodSync(), ...patch } as never), isTyped(code, field), JSON.stringify(patch));
  }
});

test('write time: a reference rule must point at a dataset id', () => {
  const id = seeded();
  assert.throws(() => addCheck(id, user, { rule: 'reference', column: 'a', toDataset: "ds_x' }}", toColumn: 'b' }), isTyped('invalid_identifier', /toDataset/));
});

test('preflight: lists every refused value with a plan; a conformant export yields nothing', () => {
  const s = baseSnapshot();
  const clean = s.datasets.map((e) => e.dataset);
  assert.deepEqual(preflightDatasets(clean), []);
  const dirty = structuredClone(clean) as Dataset[];
  dirty[0].columns[0].name = 'Order ID';
  dirty[1].sync!.schedule.cron = '0  6 * * *';
  const f = preflightDatasets(dirty);
  assert.deepEqual(f.map((x) => [x.dataset, x.field]), [['ds_orders1', 'columns[0].name'], ['ds_synced1', 'sync.schedule.cron']]);
  assert.match(f[0].plan, /rename the column to 'order_id'/);
  assert.match(f[1].plan, /'0 6 \* \* \*'/);
  // The OpenSearch `_search` export shape is read too (store records carry the yaml).
  const rec = { hits: { hits: [{ _source: { yaml: 'version: "1"\nid: ds_y1\nname: Y\nowner: amir\ndomain: sales\ntier: dataset\nvisibility: private\ndescription: ""\ncolumns:\n  - name: bad col\n    description: ""\n' } }] } };
  const parsed = datasetsFromJson(JSON.stringify(rec));
  assert.equal(parsed[0].id, 'ds_y1');
  assert.equal(preflightDatasets(parsed)[0].field, 'columns[0].name');
});

test('the generator refuses what the store refuses (defence in depth), per dataset', () => {
  const d = { ...baseSnapshot().datasets[0].dataset, versions: emptyVersions() } as Dataset;
  assert.deepEqual(datasetLiteralIssues(d), []);
  assert.deepEqual(datasetLiteralIssues({ ...d, owner: 'a {{ b }}' }).map((i) => i.field), ['owner']);
});
