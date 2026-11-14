/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Tests for the grounding pack's governed gathering
 * USER STORY: As the signed-in user whose app is being built I want the builder to see exactly the
 *             stories this build is for, with my acceptance text intact — and to reach the OS only
 *             through the governed door.
 * ARCHITECTURE:
 *   - `storiesForTarget` / `targetLabelFor` are pure and tested directly.
 *   - The identity property is asserted STRUCTURALLY over this module's own source: the only path
 *     to the OS is `handleRpc(user, …)` (the governed in-process MCP door), there is no store
 *     reached around it, and the `handleRpc` edge is LAZY so the Build dispatch cannot deadlock
 *     the process (deviation H-12).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App, AppEpic } from '../apps.ts';
import { MASKED_CELL, isSensitiveColumn, maskSensitiveSample } from './grounding.ts';
import { SAFE_FQN, storiesForTarget, targetLabelFor } from './grounding-server.ts';

const SOURCE = readFileSync(join(process.cwd(), 'tabs', 'software', 'lib', 'builder', 'grounding-server.ts'), 'utf8');

const epics: AppEpic[] = [
  {
    id: 'e1',
    title: 'Invoices',
    description: '',
    requirements: { technical: '', ux: '', governance: '' },
    stories: [
      {
        id: 's1',
        title: 'See every open invoice',
        asA: 'finance lead',
        iWant: 'to see open invoices',
        soThat: 'I can chase them',
        acceptance: 'The table shows only open invoices.',
        spec: { features: ['a table'], nfrs: ['under two seconds'], rules: ['my domain only'] },
      },
      { id: 's2', title: 'Submit a claim', asA: '', iWant: '', soThat: '', acceptance: '' },
    ],
  },
  {
    id: 'e2',
    title: 'Reporting',
    description: '',
    requirements: { technical: '', ux: '', governance: '' },
    stories: [{ id: 's3', title: 'Monthly totals', asA: '', iWant: '', soThat: '', acceptance: '' }],
  },
];

const app = { epics } as unknown as App;

test('storiesForTarget flattens the spec lists and folds the ACCEPTANCE text into the rules', () => {
  const all = storiesForTarget(app, { kind: 'app' });
  assert.deepEqual(all.map((s) => `${s.epicId}/${s.storyId}`), ['e1/s1', 'e1/s2', 'e2/s3']);
  const s1 = all[0];
  assert.deepEqual(s1.features, ['a table']);
  assert.deepEqual(s1.nfrs, ['under two seconds']);
  assert.deepEqual(s1.rules, ['my domain only', 'acceptance: The table shows only open invoices.']);
  assert.equal(s1.narrative, 'As a finance lead I want to see open invoices so that I can chase them');
  // A story with no narrative fields carries no narrative at all (never an invented sentence).
  assert.equal(all[1].narrative, undefined);
  assert.deepEqual(all[1].rules, []);
});

test('storiesForTarget respects the build target', () => {
  assert.deepEqual(storiesForTarget(app, { kind: 'epic', epicId: 'e2' }).map((s) => s.storyId), ['s3']);
  assert.deepEqual(storiesForTarget(app, { kind: 'story', epicId: 'e1', storyId: 's2' }).map((s) => s.storyId), ['s2']);
  assert.deepEqual(storiesForTarget(app, { kind: 'story', epicId: 'e2', storyId: 's1' }), [], 'a story id from another epic matches nothing');
  assert.deepEqual(storiesForTarget({ epics: [] } as unknown as App, { kind: 'app' }), []);
});

test('targetLabelFor names the build target', () => {
  assert.equal(targetLabelFor({ kind: 'app' }), 'all');
  assert.equal(targetLabelFor({ kind: 'epic', epicId: 'e1' }), 'e1');
  assert.equal(targetLabelFor({ kind: 'story', epicId: 'e1', storyId: 's1' }), 'e1/s1');
});

test('H2 the ONLY path to the OS is the governed door, called as the signed-in user', () => {
  // One CALL site, and it passes the caller through.
  assert.equal(SOURCE.split('await handleRpc(').length - 1, 1);
  assert.ok(SOURCE.includes('await handleRpc(user, req)'));
  // The reads are the governed tools, not a store import.
  assert.ok(SOURCE.includes("callGoverned(user, 'get_dataset'"));
  assert.ok(SOURCE.includes("callGoverned(user, 'query_data'"));
  assert.ok(SOURCE.includes("callGoverned(user, 'get_metric'"));
  // No cross-tab store import, and no service principal anywhere.
  assert.ok(!/from '@tabs\/(data|metrics)\//.test(SOURCE), 'the grounding pack must not reach another tab\'s store');
  assert.ok(!/service|principal:/.test(SOURCE.replace(/No service principal[^\n]*/g, '')));
});

test('H12 the handleRpc edge is LAZY — a static one deadlocks every MCP test', () => {
  assert.ok(SOURCE.includes("await import('@core/mcp/server')"), 'the import must be at the call site');
  assert.ok(
    SOURCE.includes("import type { JsonRpcRequest } from '@core/mcp/server';"),
    'the top-level edge must be TYPE-ONLY',
  );
  assert.ok(!/^import \{[^}]*handleRpc/m.test(SOURCE), 'a value import of handleRpc at module scope is the deadlock');
});

test('the sample is BOUNDED by a literal LIMIT in the SQL — never an unbounded scan', () => {
  assert.ok(SOURCE.includes('SELECT * FROM ${fqn} LIMIT ${GROUNDING_SAMPLE_ROWS}'));
});

test('M-1 only a safe table name is interpolated into the sample SQL', () => {
  for (const good of ['iceberg', 'iceberg.sales', 'iceberg.sales.gold_orders', 'personal_abc.bronze_x1']) {
    assert.equal(SAFE_FQN.test(good), true, good);
  }
  for (const bad of [
    'iceberg.sales.orders; DROP TABLE x',
    'iceberg.sales.orders--',
    'iceberg."sales".orders',
    "iceberg.sales.o'rders",
    'iceberg.sales.orders UNION SELECT 1',
    'a.b.c.d',
    'iceberg.sales.orders ',
    '',
    'ice berg.sales',
    'iceberg.sales.*',
  ]) {
    assert.equal(SAFE_FQN.test(bad), false, bad);
  }
  // And the gatherer refuses rather than interpolating — asserted over its own source.
  assert.ok(SOURCE.includes('if (!SAFE_FQN.test(fqn)) {'));
  assert.ok(SOURCE.includes('will not interpolate into SQL'));
  const guardAt = SOURCE.indexOf('if (!SAFE_FQN.test(fqn)) {');
  const sqlAt = SOURCE.indexOf('SELECT * FROM ${fqn}');
  assert.ok(guardAt > 0 && guardAt < sqlAt, 'the guard must run BEFORE the interpolation');
});

test('M-2 sample VALUES of heuristically-sensitive columns are masked, names kept', () => {
  const columns = ['order_id', 'customer_email', 'amount_eur', 'iban', 'notes'];
  const rows = [['o-1', 'a@b.com', '12.50', 'DE89370400440532013000', 'ok']];
  const { rows: out, masked } = maskSensitiveSample(columns, rows);
  assert.deepEqual(masked, ['customer_email', 'iban']);
  assert.deepEqual(out, [['o-1', MASKED_CELL, '12.50', MASKED_CELL, 'ok']]);
  // The real value never survives anywhere in the masked sample.
  assert.ok(!JSON.stringify(out).includes('a@b.com'));
  assert.ok(!JSON.stringify(out).includes('DE89370400440532013000'));
  // A clean dataset is untouched and reports nothing masked.
  const clean = maskSensitiveSample(['order_id', 'amount_eur'], [['o-1', '12.50']]);
  assert.deepEqual(clean.masked, []);
  assert.deepEqual(clean.rows, [['o-1', '12.50']]);
});

test('M-2 the heuristic covers the obvious personal and secret column families', () => {
  for (const name of [
    'email', 'e_mail', 'customer_email', 'phone', 'mobile_number', 'ssn', 'national_id',
    'passport_no', 'iban', 'card_no', 'cvv', 'password', 'api_key', 'private_key',
    'salary', 'dob', 'date_of_birth', 'street_name', 'post_code', 'patient_id', 'diagnosis',
  ]) {
    assert.equal(isSensitiveColumn(name), true, name);
  }
  for (const name of ['order_id', 'amount_eur', 'status', 'created_at', 'product_name', 'category']) {
    assert.equal(isSensitiveColumn(name), false, name);
  }
});

test('M-2 the honest limits are RECORDED, not implied', () => {
  // There is no column-classification facility to consult, and no trace redaction on this path.
  assert.ok(/NO column-classification facility to consult/.test(SOURCE));
  assert.ok(/NO trace-redaction\s+\*\s+facility on this path/.test(SOURCE) || SOURCE.includes('NO trace-redaction'));
  assert.ok(SOURCE.includes('no column-classification facility, so this is a conservative name heuristic'));
  // A masked sample is surfaced to the user as a gap, naming the columns.
  assert.ok(SOURCE.includes('sample values masked for'));
  assert.ok(SOURCE.includes('conservative name heuristic'));
});
