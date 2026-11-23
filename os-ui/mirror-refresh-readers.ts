/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    os-ui reads what the agent worker writes — the one list of stores it re-reads
 * USER STORY: As a user whose agent run saved a note, a file, a dataset or a folder in the run
 *             worker, I see it in the web app without anybody restarting os-ui.
 * ARCHITECTURE:
 *   - Lives beside `instrumentation.ts` (the one place allowed to know both the kernel and the
 *     tabs); `instrumentation.ts` calls {@link enableWebMirrorRefresh} at boot and
 *     `core/infra/mirror-refresh-readers.test.ts` calls the same function, so the test exercises
 *     the wiring that ships.
 *   - Every store switches its refresh on in 'changes' mode (`core/infra/mirror-refresh.ts`):
 *     per read at most every 5 s, only the docs changed since the last read, never waiting more
 *     than a moment; the whole index in the background once a minute (deletes).
 *   - No `server-only`: dynamic imports of the stores only, so it runs under the unit tests.
 */

/** Each reader: a name for the boot log and its store's switch. */
export const WEB_MIRROR_REFRESH_READERS: [string, () => Promise<{ enableMirrorRefresh(on?: boolean, mode?: 'changes'): unknown }>][] = [
  ['files', () => import('@tabs/files/lib/store')],
  ['datasets', () => import('@tabs/data/lib/store')],
  ['metrics', () => import('@tabs/metrics/lib/lifecycle')],
  ['knowledge workflows', () => import('@tabs/knowledge/lib/store')],
  ['personal knowledge', () => import('@tabs/knowledge/lib/personal-store')],
  ['dashboards', () => import('@tabs/dashboards/lib/store')],
  ['connections', () => import('@tabs/connections/lib/store')],
  ['apps', () => import('@tabs/software/lib/apps')],
  ['folders', () => import('@core/folders/folder-store')],
];

/**
 * Switch every reader on in 'changes' mode. Returns the names switched on and those that failed
 * (with the reason) — the caller logs both; a failure is never silent.
 */
export async function enableWebMirrorRefresh(): Promise<{ on: string[]; failed: string[] }> {
  const on: string[] = [];
  const failed: string[] = [];
  for (const [name, load] of WEB_MIRROR_REFRESH_READERS) {
    try {
      // `mode` is read by the files switch (it defaults to 'full' for its historical callers);
      // every other store picks 'changes' itself outside the run worker.
      (await load()).enableMirrorRefresh(true, 'changes');
      on.push(name);
    } catch (err) {
      failed.push(`${name} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { on, failed };
}
