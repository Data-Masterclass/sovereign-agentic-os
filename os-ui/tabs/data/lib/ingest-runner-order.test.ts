/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    An upload works whichever of os-ui and the data-runner is rolled out first
 * USER STORY: As someone uploading a CSV during a release I want the upload to land, whether the
 *             ingest service is still the old one (ignores the column names) or already the new
 *             one (refuses a list that does not fit the file).
 * ARCHITECTURE:
 *   - The real `realDlt()` client against a stubbed `fetch` that answers like each runner version
 *     (`images/extensions/data-runner/app.py`); then the real `landedColumnDocs` on what landed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

type Call = { url: string; body: Record<string, unknown> };
const calls: Call[] = [];
let runner: 'old' | 'new-mismatch' | 'new' = 'old';
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  calls.push({ url: String(url), body });
  const raw = ['Order Date', 'größe'];
  const json = (status: number, o: unknown) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (runner === 'new-mismatch' && body.columnNames) return json(400, { error: 'columnNames has 2 names but the file has 3 columns' });
  const names = runner !== 'old' && Array.isArray(body.columnNames) ? (body.columnNames as string[]) : raw;
  return json(200, { ok: true, table: 'iceberg.personal_cara.bronze_b', rowCount: 1, columns: names.map((name) => ({ name, type: 'string' })) });
}) as typeof fetch;

const { realDlt } = await import('./build/live-clients.ts');
const { landedColumnDocs, planUploadColumns } = await import('./upload-columns.ts');
const { isColumnName } = await import('./dbt/literal.ts');

const plan = planUploadColumns(['Order Date', 'größe'], []);
async function land(): Promise<{ name: string }[]> {
  const dlt = realDlt();
  dlt.columnNames = plan.columnNames;
  await dlt.load('t', 'b', { objectKey: 'uploads/cara/b.csv', principal: 'cara' } as never);
  return dlt.lastIngest!.columns;
}

test('new os-ui + OLD runner: raw headers land and are recorded as valid physical names', async () => {
  runner = 'old';
  calls.length = 0;
  const docs = landedColumnDocs(await land(), plan);
  assert.deepEqual(docs, [{ name: 'Order Date', description: '' }, { name: 'größe', description: '' }]);
  assert.ok(docs.every((d) => isColumnName(d.name)));
});

test('new os-ui + NEW runner: the mapped names land, with their source headers', async () => {
  runner = 'new';
  calls.length = 0;
  assert.deepEqual(landedColumnDocs(await land(), plan), [
    { name: 'order_date', description: '', source: 'Order Date' },
    { name: 'groesse', description: '', source: 'größe' },
  ]);
  assert.deepEqual(calls[0].body.columnNames, ['order_date', 'groesse']);
});

test('a NEW runner refusing a list that does not fit: retried once under the file\'s own names, never failed', async () => {
  runner = 'new-mismatch';
  calls.length = 0;
  const docs = landedColumnDocs(await land(), plan);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].body.columnNames && !('columnNames' in calls[1].body));
  assert.deepEqual(docs.map((d) => d.name), ['Order Date', 'größe']);
});
