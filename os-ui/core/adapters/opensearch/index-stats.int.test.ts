/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    unitRowStats / indexSearchCounters on the REAL OpenSearch (the image the chart ships, 3.7.0)
 * USER STORY: As a Monitoring viewer I want a file's or workflow's indexed row count to be what OpenSearch
 *             answers for it, and never another unit's.
 * ARCHITECTURE: tests/monitoring/up.sh starts OpenSearch on 19200. Negative twins: a look-alike id
 *   (`<id>x`) and an unasked unit are not counted; a missing index is an empty map; a closed port is ok:false.
 *   Run: MON_IT=1 node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test core/adapters/opensearch/index-stats.int.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const on = process.env.MON_IT === '1';
const OS = process.env.MON_OS_URL ?? 'http://127.0.0.1:19200';
process.env.OPENSEARCH_URL = OS;
const { unitRowStats, indexSearchCounters } = await import('./index-stats');

async function put(index: string, docs: Record<string, unknown>[]): Promise<void> {
  const body = docs.flatMap((d, i) => [JSON.stringify({ index: { _index: index, _id: `${index}-${i}` } }), JSON.stringify(d)]).join('\n') + '\n';
  const r = await fetch(`${OS}/_bulk?refresh=true`, { method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body });
  assert.equal(r.status, 200, await r.text());
}

test('row counts and newest ingest time are OpenSearch’s own, for the asked units only', { skip: !on }, async () => {
  const idx = `mon-${randomUUID().slice(0, 8)}`;
  assert.equal((await fetch(`${OS}/${idx}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mappings: { properties: { workflow_id: { type: 'keyword' }, ingested_at: { type: 'date' } } } }) })).status, 200);
  await put(idx, [
    { workflow_id: 'wfA', ingested_at: '2026-11-01T10:00:00Z' },
    { workflow_id: 'wfA', ingested_at: '2026-11-03T10:00:00Z' },
    { workflow_id: 'wfAx', ingested_at: '2026-11-09T10:00:00Z' },
    { workflow_id: 'wfOther', ingested_at: '2026-11-09T10:00:00Z' },
  ]);
  const r = await unitRowStats(idx, 'workflow_id', ['wfA', 'wfNone'], 'ingested_at');
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([...r.value.keys()], ['wfA'], 'wfAx and wfOther must not appear; wfNone has no rows');
  assert.equal(r.value.get('wfA')!.rows, 2);
  assert.equal(new Date(r.value.get('wfA')!.newest!).toISOString(), '2026-11-03T10:00:00.000Z');
  const c = await indexSearchCounters(idx);
  assert.ok(c.ok && c.value && c.value.queries >= 1, JSON.stringify(c));
});

test('a missing index is not_found (never an empty map); an index with no rows for the unit is a live empty map; an unreachable cluster is ok:false', { skip: !on }, async () => {
  const absent = `mon-absent-${randomUUID().slice(0, 8)}`;
  const none = await unitRowStats(absent, 'file_id', ['f1']);
  assert.equal(none.ok, false, 'an absent index must not read as "0 rows"');
  assert.ok(!none.ok && none.reason === 'not_found' && none.detail.includes(absent), JSON.stringify(none));
  const noCounters = await indexSearchCounters(absent);
  assert.ok(!noCounters.ok && noCounters.reason === 'not_found', JSON.stringify(noCounters));
  // Negative twin: the index exists, the unit has no rows in it ⇒ an honest, live, empty answer.
  const idx = `mon-empty-${randomUUID().slice(0, 8)}`;
  assert.equal((await fetch(`${OS}/${idx}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mappings: { properties: { file_id: { type: 'keyword' } } } }) })).status, 200);
  const empty = await unitRowStats(idx, 'file_id', ['f1']);
  assert.ok(empty.ok && empty.value.size === 0, JSON.stringify(empty));
  process.env.OPENSEARCH_URL = 'http://127.0.0.1:1';
  try {
    const down = await unitRowStats('x', 'file_id', ['f1']);
    assert.ok(!down.ok && down.reason === 'unreachable');
  } finally {
    process.env.OPENSEARCH_URL = OS;
  }
});
