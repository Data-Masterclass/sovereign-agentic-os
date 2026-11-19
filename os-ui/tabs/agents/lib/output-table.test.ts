/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    The table contract of a Data output — found, validated, never invented
 * USER STORY: As an author with a Dataset output I want my agent's rows to become the dataset
 *             when they are really there, and a plain "no table in the result" when they are not.
 * ARCHITECTURE:
 *   - `extractTable` (`output-table.ts`) is pure; these cases pin the contract the prompt states
 *     (`dataFormatBrief`): one JSON list, flat objects, the same keys, plain values, size caps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataFormatBrief, extractTable, instructionsAskForTable, TABLE_MAX_ROWS } from '@tabs/agents/lib/output-table';

const ROWS = '[{"invoice_no":"R-1001","net_amount":250.5,"paid":true,"note":null},{"invoice_no":"R-1002","net_amount":90,"paid":false,"note":"late, \\"urgent\\""}]';

test('a bare JSON list of flat objects is the table, with its CSV', () => {
  const t = extractTable(ROWS);
  assert.ok(t.ok);
  if (!t.ok) return;
  assert.deepEqual(t.columns, ['invoice_no', 'net_amount', 'paid', 'note']);
  assert.equal(t.rows.length, 2);
  assert.equal(t.csv, 'invoice_no,net_amount,paid,note\nR-1001,250.5,true,\nR-1002,90,false,"late, ""urgent"""\n');
});

test('the list is found inside a report: fenced, after prose, or wrapped in an object', () => {
  const fenced = `# Report\n\nTwo invoices were read. See [the policy](https://example.org).\n\n\`\`\`json\n${ROWS}\n\`\`\`\n\nDone.`;
  assert.ok(extractTable(fenced).ok);
  assert.ok(extractTable(`Totals: [1, 2, 3]. Rows: ${ROWS}`).ok, 'a list that is not made of objects is not a table');
  assert.ok(extractTable(`{"invoices": ${ROWS}}`).ok);
});

test('no table is said, not invented', () => {
  assert.deepEqual(extractTable('All twelve invoices were paid on time.'), { ok: false, reason: 'no table in the result' });
  assert.deepEqual(extractTable('| a | b |\n|---|---|\n| 1 | 2 |'), { ok: false, reason: 'no table in the result' });
  assert.deepEqual(extractTable('Rows: []'), { ok: false, reason: 'the JSON list in the result is empty' });
  assert.deepEqual(extractTable(''), { ok: false, reason: 'no table in the result' });
});

test('two tables are refused rather than one being picked', () => {
  const t = extractTable(`${ROWS}\n\nand also\n\n[{"a":1}]`);
  assert.equal(t.ok, false);
  if (!t.ok) assert.match(t.reason, /contains 2 JSON lists — exactly one is expected/);
});

test('rows must share their keys and hold plain values', () => {
  const missing = extractTable('[{"a":1,"b":2},{"a":3}]');
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.reason, /row 2 does not have the same keys as row 1 \(it misses "b"\) — use null/);
  const extra = extractTable('[{"a":1},{"a":3,"c":4}]');
  if (!extra.ok) assert.match(extra.reason, /row 2 .* adds "c"/);
  const nested = extractTable('[{"a":1,"items":[{"x":1}]}]');
  assert.equal(nested.ok, false);
  if (!nested.ok) assert.match(nested.reason, /row 1, column "items" is not a plain value/);
  const mixed = extractTable('[{"a":1},"oops"]');
  if (!mixed.ok) assert.match(mixed.reason, /row 2 is not an object/);
  const dup = extractTable('[{"Name":1,"name ":2}]');
  if (!dup.ok) assert.match(dup.reason, /appears twice/);
});

test('the size caps are enforced', () => {
  const big = JSON.stringify(Array.from({ length: TABLE_MAX_ROWS + 1 }, (_, i) => ({ n: i })));
  const t = extractTable(big);
  assert.equal(t.ok, false);
  if (!t.ok) assert.match(t.reason, new RegExp(`at most ${TABLE_MAX_ROWS} can be saved`));
});

test('the prompt states the rule the check enforces, and the builder test is a vocabulary test', () => {
  const brief = dataFormatBrief('Invoices');
  assert.match(brief, /exactly one JSON list/);
  assert.match(brief, new RegExp(`At most ${TABLE_MAX_ROWS} rows`));
  assert.equal(instructionsAskForTable('Return a JSON list with one object per invoice.'), true);
  assert.equal(instructionsAskForTable('Write a friendly summary for the finance team.'), false);
});
