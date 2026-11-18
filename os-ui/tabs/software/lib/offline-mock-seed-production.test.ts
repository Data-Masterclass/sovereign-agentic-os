/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    NODE_ENV=production ⇒ a non-live app answers with a refusal, not "Sample record A"
 * USER STORY: As an agent, or a person, calling an app's tool I must not be handed two invented
 *             rows when the app runner answered nothing. `assertNotSeeded` already keeps a
 *             demo-seed out of the deploy GATES, but the tool RESULT still reached the caller —
 *             and `source: 'demo-seed'` is a response FIELD, which is exactly the kind of label
 *             the 2026-11-18 incident proved callers drop.
 * ARCHITECTURE:
 *   - `executeAppTool` ended in `result ?? seedToolResult(tool, args)`. Found in the re-review
 *     because the marker set did not include `seedToolResult(`.
 *   - Drives `executeAppTool` with the k8s runner unreachable (`fetch` rejects), which is what a
 *     deployment with no live app pod looks like — and what a laptop looks like too, so the same
 *     call proves both halves.
 *   - Asserts the ABSENCE of the invented rows: no `items`, no `Sample record`, nothing with
 *     `source: 'demo-seed'`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_UNAVAILABLE, OFFLINE_MOCK_ENV } from '@core/kernel/offline-mock';
import { executeAppTool } from '@tabs/software/lib/app-records';
import type { App } from '@tabs/software/lib/model';

const realFetch = globalThis.fetch;
// No reachable k8s API and no reachable app pod — `runnerStatus` reports not-live.
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const app = {
  id: 'app_1',
  slug: 'records-demo',
  name: 'Records demo',
  domain: 'sales',
  owner: 'cara',
  template: 'records',
} as unknown as App;

async function withEnv(nodeEnv: string, flag: string | undefined, body: () => Promise<void>): Promise<void> {
  const prevNode = process.env.NODE_ENV;
  const prevFlag = process.env[OFFLINE_MOCK_ENV];
  (process.env as Record<string, string>).NODE_ENV = nodeEnv;
  if (flag === undefined) delete process.env[OFFLINE_MOCK_ENV];
  else process.env[OFFLINE_MOCK_ENV] = flag;
  try {
    await body();
  } finally {
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else (process.env as Record<string, string>).NODE_ENV = prevNode;
    if (prevFlag === undefined) delete process.env[OFFLINE_MOCK_ENV];
    else process.env[OFFLINE_MOCK_ENV] = prevFlag;
  }
}

test('PRODUCTION: a non-live app REFUSES — no "Sample record A", no demo-seed envelope', async () => {
  await withEnv('production', undefined, async () => {
    for (const tool of ['list_records', 'get_record', 'add_record', 'export_records', 'ping']) {
      await assert.rejects(
        () => executeAppTool(app, tool, { id: 'r1' }),
        (e: Error & { code?: string; status?: number }) => {
          assert.equal(e.code, ENGINE_UNAVAILABLE, `${tool} must refuse`);
          assert.equal(e.status, 503);
          assert.equal(/Sample record/.test(e.message), false, 'the refusal must not carry the seed rows');
          return true;
        },
      );
    }
  });
});

test('PRODUCTION: the refusal names the app and the tool, so the caller knows what to start', async () => {
  await withEnv('production', undefined, async () => {
    await assert.rejects(
      () => executeAppTool(app, 'list_records'),
      (e: Error) => {
        assert.match(e.message, /Records demo|records-demo/, 'names the app');
        assert.match(e.message, /list_records/, 'names the tool');
        return true;
      },
    );
  });
});

test('a laptop keeps the honestly-labelled demo seed — the teaching flow is untouched', async () => {
  await withEnv('development', undefined, async () => {
    const r = (await executeAppTool(app, 'list_records')) as { source?: string; items?: { name: string }[] };
    assert.equal(r.source, 'demo-seed');
    assert.equal(r.items?.[0]?.name, 'Sample record A');
  });
});

test('PRODUCTION + an explicit `allow` is the deliberate opt-in, and it stays labelled', async () => {
  await withEnv('production', 'allow', async () => {
    const r = (await executeAppTool(app, 'list_records')) as { source?: string };
    assert.equal(r.source, 'demo-seed', 'still labelled, and only because somebody asked for it');
  });
});

test.after(() => {
  globalThis.fetch = realFetch;
});
