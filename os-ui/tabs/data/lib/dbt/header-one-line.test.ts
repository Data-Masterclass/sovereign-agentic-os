/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    The generated model header comment stays one line, whatever the dataset is called
 * USER STORY: As a builder I want any dataset name — including one pasted with odd line breaks — to
 *             appear in the generated dbt model only as text in its header comment, so the model's
 *             SQL is exactly what the OS compiled.
 * ARCHITECTURE:
 *   - Pure: a literal snapshot into `generateProject`, the SQL out. Every character a SQL engine or
 *     editor may treat as a line end (CR, LF, NEL, U+2028, U+2029) is replaced inside `--` comments.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyVersions, type Dataset } from '@tabs/data/lib/dataset-schema';
import { generateProject } from '@tabs/data/lib/dbt/generate';
import type { ProjectSnapshot } from '@tabs/data/lib/dbt/snapshot';

const built = (artifact: string, passThrough = false) => ({ built: true, passThrough, quality: 'unknown' as const, updatedAt: '2026-11-13T00:00:00.000Z', artifact });

const LINE_ENDS = ['\r', '\n', '\r\n', '\u0085', '\u2028', '\u2029'];

test('a dataset name with any line terminator stays inside the one-line header comment', () => {
  for (const le of LINE_ENDS) {
    const d = {
      version: '1', tier: 'dataset', visibility: 'private', folder: '/', description: '', grants: [], measures: [], viewNamespaced: true,
      id: 'ds_x1', name: `Orders${le}select 1 as injected --`, owner: 'amir', domain: 'sales',
      columns: [{ name: 'order_id', description: '' }],
      versions: { ...emptyVersions(), bronze: built('bronze/orders.dlt.yml'), silver: built('silver/x.sql', true), gold: built('gold/y.sql', true) },
    } as unknown as Dataset;
    const snapshot = { domain: 'sales', datasets: [{ dataset: d, artifacts: {} }], catalogs: {} } as unknown as ProjectSnapshot;
    const files = generateProject('sales', snapshot);
    const sql = [...files.entries()].filter(([p]) => p.endsWith('.sql'));
    assert.ok(sql.length > 0);
    for (const [p, c] of sql) {
      assert.equal(/[\r\u0085\u2028\u2029]/.test(c), false, `${JSON.stringify(le)}: ${p} carries a line terminator`);
      for (const line of c.split('\n')) {
        if (line.includes('select 1 as injected')) assert.match(line, /^-- /, `${JSON.stringify(le)}: ${p}: the name left the comment: ${line}`);
      }
    }
  }
});
