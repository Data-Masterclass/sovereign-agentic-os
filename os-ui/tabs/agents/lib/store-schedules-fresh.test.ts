/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The schedule CronJob resync and receiver read schedules FRESH from the mirror
 * USER STORY: As the owner I want a schedule CronJob to be created, kept or deleted only on what
 *             the durable store says NOW — never on a pod's stale registry, and never on a mirror
 *             that answered only partly (which would read as "no schedules: delete them all").
 * ARCHITECTURE:
 *   - `readSchedulesFresh` / `readScheduleFresh` over a fake OpenSearch (`_count`, `_search`,
 *     `_doc`), the REST calls the mirror makes. This process's registry is never hydrated here:
 *     the fresh reads must not depend on it (review R-1, R-3).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opensearchBaseUrl } from '@core/adapters/opensearch/client';
import { readSchedulesFresh, readScheduleFresh, hydrationState } from '@tabs/agents/lib/store';

type Mode = 'ok' | 'down' | 'partial' | 'error';

function fakeMirror(docs: Record<string, unknown>[], mode: () => Mode) {
  const orig = globalThis.fetch;
  const base = opensearchBaseUrl();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith(base)) return json({});
    const m = mode();
    if (m === 'down') throw new Error('connect ECONNREFUSED');
    const path = url.slice(base.length).split('?')[0];
    if (path === '/os-agent-systems/_count') return m === 'error' ? json({}, 503) : json({ count: docs.length });
    if (path === '/os-agent-systems/_search') {
      if (m === 'error') return json({}, 503);
      const hits = docs.map((_source) => ({ _source }));
      // A partial answer: one shard failed — the read is not complete.
      return json({ hits: { total: { value: docs.length, relation: 'eq' }, hits }, ...(m === 'partial' ? { _shards: { total: 2, successful: 1, failed: 1 } } : {}) });
    }
    const id = decodeURIComponent(path.replace('/os-agent-systems/_doc/', ''));
    const doc = docs.find((d) => d.id === id);
    if (m === 'error') return json({}, 503);
    return doc ? json({ _source: doc }) : json({ found: false }, 404);
  }) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

const DOCS = [
  { id: 'sys_a', yaml: 'y', schedule: { kind: 'cron', cron: '0 8 * * *' } },
  { id: 'sys_b', yaml: 'y', schedule: { kind: 'manual' }, archived: true },
  { id: 'sys_c', yaml: 'y' },
];

test('R-3: with the registry never hydrated, the fresh read still answers from the mirror (not from memory)', async () => {
  let mode: Mode = 'ok';
  const restore = fakeMirror(DOCS, () => mode);
  try {
    assert.notEqual(hydrationState(), 'hydrated', 'this process never hydrated');
    const rows = await readSchedulesFresh();
    assert.deepEqual(rows, [
      { id: 'sys_a', schedule: { kind: 'cron', cron: '0 8 * * *' }, archived: false },
      { id: 'sys_b', schedule: { kind: 'manual' }, archived: true },
      { id: 'sys_c', schedule: { kind: 'manual' }, archived: false },
    ]);
  } finally {
    restore();
  }
});

test('R-3: an unreachable, erroring or PARTIAL mirror read is null — never an empty list', async () => {
  let mode: Mode = 'partial';
  const restore = fakeMirror(DOCS, () => mode);
  try {
    assert.equal(await readSchedulesFresh(), null, 'a shard failure is not a complete read');
    mode = 'ok';
    assert.equal((await readSchedulesFresh())?.length, 3, 'the same mirror, complete, answers');
    mode = 'error';
    assert.equal(await readSchedulesFresh(), null);
    mode = 'down';
    assert.equal(await readSchedulesFresh(), null);
  } finally {
    restore();
  }
});

test('one system, fresh: found / absent / unreachable', async () => {
  let mode: Mode = 'ok';
  const restore = fakeMirror(DOCS, () => mode);
  try {
    assert.deepEqual(await readScheduleFresh('sys_a'), { state: 'found', system: { id: 'sys_a', schedule: { kind: 'cron', cron: '0 8 * * *' }, archived: false } });
    assert.deepEqual(await readScheduleFresh('sys_zz'), { state: 'absent' });
    mode = 'down';
    assert.deepEqual(await readScheduleFresh('sys_a'), { state: 'unreachable' });
  } finally {
    restore();
  }
});
