/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The grant check's deadline really fires — even when nothing else is alive
 * USER STORY: As a builder whose save hits a door that never answers, I want the check to give
 *             up at its deadline and say so — not hang, and not vanish with the process.
 * ARCHITECTURE:
 *   - Deliberately imports ONLY the pure module: no store, no timer, no socket is alive in this
 *     process except the check's own deadline. A deadline timer that is `unref()`'d holds no
 *     handle, so with a never-answering probe the event loop drains before it fires and the
 *     test is cancelled ("Promise resolution is still pending but the event loop has already
 *     resolved") — the CI failure on #324. This file is that reproduction, kept as a guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkGrantAccessReport } from './grant-access.ts';
import type { System } from './system-schema.ts';

const sys = {
  system: { name: 't', domain: 'sales', visibility: 'Personal' },
  grants: {
    data: [{ id: 'ds_hung', capability: 'Read' }],
    knowledge: [], metrics: [], tools: [], connections: [], files: [], workflows: [], plan: [],
  },
} as unknown as System;

test('a probe that never answers, in an otherwise idle process: the deadline fires and counts it timed out', async () => {
  const r = await checkGrantAccessReport({ domains: ['sales'] }, sys, () => new Promise(() => {}), { deadlineMs: 50 });
  assert.deepEqual(r, { warnings: [], probed: 1, timedOut: 1, unknown: 0 });
});
