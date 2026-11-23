/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The web app lists a file an agent run saved in the run worker — without a restart
 * USER STORY: As the owner of an agent run that reported "Saved to My files /reports/…" I open
 *             Files and find the file there.
 * ARCHITECTURE:
 *   - Two simulated processes (`two-process-fixture.ts`) over one fake OpenSearch: os-ui with the
 *     refresh it switches on at boot ('changes' mode, `instrumentation.ts`) and the run worker.
 *     The REAL files store; the reads are the ones the Files routes make.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCluster, proc, as } from '@core/infra/two-process-fixture';
import { later } from '@core/infra/worker-refresh-suite';
import * as files from '@tabs/files/lib/store';

const nova = { id: 'nova-admin', domains: ['finance'], role: 'admin' as const };
const FILE_KEYS = [Symbol.for('soa.files.store'), Symbol.for('soa.files.deleting'), Symbol.for('soa.versions.file')];

test('a file the WORKER saves is listed in the web app\'s Files without a restart', async () => {
  const os = fakeCluster();
  files.__resetStore();
  const web = proc();
  const worker = proc(true);
  try {
    await as(web, FILE_KEYS, async () => {
      await files.ensureHydrated();
      files.enableMirrorRefresh(true, 'changes');
    });
    await as(worker, FILE_KEYS, async () => {
      files.enableMirrorRefresh();
      await files.ensureHydrated();
    });
    const id = await as(worker, FILE_KEYS, () => files.createFile(nova, { name: 'report.md', text: 'x', folder: '/reports' }).id);
    later();
    const listed = await as(web, FILE_KEYS, async () => {
      await files.ensureHydrated();
      const g = files.listFiles(nova);
      return Object.values(g).flat().map((a) => (a as { id: string }).id);
    });
    assert.ok(listed.includes(id), 'the web app lists the worker\'s file');
  } finally {
    os.restore();
    files.__resetStore();
  }
});
