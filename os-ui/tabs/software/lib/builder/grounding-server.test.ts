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
import { storiesForTarget, targetLabelFor } from './grounding-server.ts';

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
