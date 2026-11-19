/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The worker boot switches on the mirror refresh of every store an agent tool reads
 * USER STORY: As an operator I read ONE boot line in the worker log that names every store the
 *             agent tools re-read from the shared mirror, so a stale-data report starts from fact.
 * ARCHITECTURE:
 *   - Runs the REAL `bootWorker()` against a fake OpenSearch (no database: in-memory checkpoints
 *     and queue, which the boot reports and tolerates) and captures its log.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCluster } from '@core/infra/two-process-fixture';
import { __clearRunWorkerProcess } from '@core/kernel/process-role';

test('worker boot: one log line lists every store whose mirror refresh is ON, and none is refused', async () => {
  const os = fakeCluster();
  const info: string[] = [];
  const warns: string[] = [];
  const origInfo = console.info;
  const origWarn = console.warn;
  console.info = (...a: unknown[]) => { info.push(a.join(' ')); };
  console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
  try {
    const { bootWorker } = await import('./agent-runs');
    await bootWorker();
    const lines = info.filter((l) => l.includes('mirror refresh ON for'));
    assert.equal(lines.length, 1, 'exactly one boot line');
    for (const name of ['files', 'datasets', 'metrics', 'knowledge workflows', 'personal knowledge', 'dashboards', 'connections', 'apps']) {
      assert.ok(lines[0].includes(name), `the boot line names ${name}`);
    }
    assert.match(lines[0], /ON for 8 stores/);
    assert.equal(warns.filter((w) => w.includes('mirror refresh NOT enabled')).length, 0, 'no store refused');
    const stores = await Promise.all([
      import('@tabs/data/lib/store'), import('@tabs/metrics/lib/lifecycle'), import('@tabs/knowledge/lib/store'),
      import('@tabs/knowledge/lib/personal-store'), import('@tabs/dashboards/lib/store'), import('@tabs/connections/lib/store'),
      import('@tabs/software/lib/apps'),
    ]);
    for (const s of stores) s.enableMirrorRefresh(false); // leave the process as the next test expects
  } finally {
    console.info = origInfo;
    console.warn = origWarn;
    __clearRunWorkerProcess();
    os.restore();
  }
});
