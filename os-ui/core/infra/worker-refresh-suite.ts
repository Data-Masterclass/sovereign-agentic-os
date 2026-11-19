/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Test suite — the agent worker sees what the web app created and deleted
 * USER STORY: As a maintainer I want one set of scenarios, run against the REAL code of every
 *             store, proving the worker re-reads the shared mirror: new items appear, deleted
 *             items disappear (only after two complete listings), a failed listing removes
 *             nothing, the worker's own write is not rolled back, and the web app does not
 *             re-read at all.
 * ARCHITECTURE:
 *   - TEST-ONLY (imported by `*.test.ts` files; nothing in the app imports it).
 *   - Each store supplies a small adapter ({@link RefreshSubject}); the scenarios run it over two
 *     simulated processes and one fake OpenSearch (`two-process-fixture.ts`).
 *   - The refresh throttle reads `Date.now()`; {@link later} moves that clock past the throttle
 *     window so a scenario can say "the next refresh" without sleeping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCluster, proc, as, type Proc, type FakeCluster } from '@core/infra/two-process-fixture';
import { MIRROR_REFRESH_MIN_MS } from '@core/infra/mirror-refresh';

export type RefreshSubject = {
  /** The store's name in test titles. */
  name: string;
  /** The `Symbol.for(...)` slots the store pins its state to. */
  keys: readonly symbol[];
  /** The mirror index. */
  index: string;
  reset(): void;
  /** The read seam agent tools go through (the store's `ensureHydrated`, or its list call). */
  read(): Promise<unknown>;
  /** Switch the worker refresh on (called inside the worker process). Returns whether it took. */
  enable(): boolean;
  /** In the web app: create an item, return its id. */
  create(label: string): Promise<string> | string;
  /** In the web app: delete it. */
  remove(id: string): Promise<void> | void;
  /** In the calling process: is the item visible through the agent tools' read path? */
  visible(id: string): Promise<boolean> | boolean;
  /** In the worker: an agent edit that sets a value {@link marker} reads back. */
  edit(id: string, value: string): Promise<void> | void;
  marker(id: string): Promise<string | undefined> | string | undefined;
};

const realNow = Date.now;
let offset = 0;
/** Move the clock the throttle reads past the refresh window. */
export function later(): void {
  offset += MIRROR_REFRESH_MIN_MS + 1;
  Date.now = () => realNow() + offset;
}
function resetClock(): void {
  offset = 0;
  Date.now = realNow;
}

async function boot(s: RefreshSubject, opts: { create?: string } = {}) {
  const os = fakeCluster();
  s.reset();
  const web = proc();
  const worker = proc(true);
  await as(web, s.keys, () => s.read());
  const id = opts.create ? await as(web, s.keys, () => s.create(opts.create!)) : undefined;
  await as(worker, s.keys, async () => {
    assert.equal(s.enable(), true, 'the worker switches the refresh on');
    await s.read();
  });
  return { os, web, worker, id };
}

async function inWorker<T>(s: RefreshSubject, worker: Proc, fn: () => T | Promise<T>): Promise<T> {
  return as(worker, s.keys, async () => {
    await s.read();
    return fn();
  });
}

function cleanup(s: RefreshSubject, os: FakeCluster): void {
  os.mode = 'ok';
  os.restore();
  s.reset();
  resetClock();
}

export function workerRefreshSuite(s: RefreshSubject): void {
  test(`${s.name}: an item created in the web app after the worker booted is visible to the worker within one refresh`, async () => {
    const { os, web, worker } = await boot(s);
    try {
      const id = await as(web, s.keys, () => s.create('Created after boot'));
      later();
      assert.equal(await inWorker(s, worker, () => s.visible(id)), true, 'the worker sees it after one refresh');
    } finally {
      cleanup(s, os);
    }
  });

  test(`${s.name}: an item deleted in the web app disappears from the worker after two complete listings, not before`, async () => {
    const { os, web, worker, id } = await boot(s, { create: 'To be deleted' });
    try {
      assert.equal(await inWorker(s, worker, () => s.visible(id!)), true, 'the worker held it at boot');
      await as(web, s.keys, () => s.remove(id!));
      later();
      assert.equal(await inWorker(s, worker, () => s.visible(id!)), true, 'one listing without it is not enough');
      later();
      assert.equal(await inWorker(s, worker, () => s.visible(id!)), false, 'the second complete listing drops it');
    } finally {
      cleanup(s, os);
    }
  });

  test(`${s.name}: a failed, truncated or unreachable listing removes nothing`, async () => {
    const { os, web, worker, id } = await boot(s, { create: 'Kept through outages' });
    try {
      await as(web, s.keys, () => s.remove(id!));
      for (const mode of ['error', 'truncated', 'down'] as const) {
        os.mode = mode;
        for (let i = 0; i < 3; i++) {
          later();
          await inWorker(s, worker, () => undefined);
        }
        // Checked while still degraded (inside the throttle window, so this read lists nothing).
        assert.equal(await inWorker(s, worker, () => s.visible(id!)), true, `nothing dropped while the listing is '${mode}'`);
      }
      os.mode = 'ok';
      // None of those nine listings counted: the first complete one is still only the first…
      later();
      assert.equal(await inWorker(s, worker, () => s.visible(id!)), true, 'degraded listings never count as absences');
      // …and the second drops it, so the delete still propagates once the mirror answers.
      later();
      assert.equal(await inWorker(s, worker, () => s.visible(id!)), false, 'two complete listings later it is gone');
    } finally {
      cleanup(s, os);
    }
  });

  test(`${s.name}: a record the worker just wrote is not rolled back by an older mirror copy`, async () => {
    const { os, worker, id } = await boot(s, { create: 'Edited by an agent' });
    try {
      const older = structuredClone(os.doc(s.index, id!));
      assert.ok(older, 'the mirror holds the item');
      await inWorker(s, worker, () => s.edit(id!, 'written by the agent'));
      // The worker's write has not landed (or a stale copy is what a listing returns).
      os.put(s.index, id!, older!);
      later();
      assert.equal(await inWorker(s, worker, () => s.marker(id!)), 'written by the agent');
    } finally {
      cleanup(s, os);
    }
  });

  test(`${s.name}: the web app does not re-read the mirror, even if asked to switch the refresh on`, async () => {
    const os = fakeCluster();
    s.reset();
    const web = proc();
    try {
      await as(web, s.keys, () => s.read());
      const searches = () => os.calls.filter((c) => c === `POST /${s.index}/_search`).length;
      const before = searches();
      await as(web, s.keys, async () => {
        assert.equal(s.enable(), false, 'the switch is refused outside the run worker');
        for (let i = 0; i < 3; i++) {
          later();
          await s.read();
        }
      });
      assert.equal(searches(), before, 'no extra mirror listing per read in the web app');
    } finally {
      cleanup(s, os);
    }
  });
}
