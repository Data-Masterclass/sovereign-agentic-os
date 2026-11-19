/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    A saved schedule says it will not run while scheduled runs are switched off
 * USER STORY: As an agent builder I want saving a schedule to tell me when scheduled runs are
 *             switched off on this install (the default), instead of "runs on schedule", so I
 *             do not wait for a run that every firing will refuse.
 * ARCHITECTURE:
 *   - `runScheduledSystem` refuses every firing while `autonomousAgentsEnabled` is false (the
 *     shipped default). The schedule route now returns that flag beside the CronJob outcome, and
 *     both builder views word the result with `scheduleSavedNote` (a `.tsx` cannot be tested).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const cron = { ok: true, live: true, action: 'created', detail: '', name: 'agent-sys' };

test('a live CronJob with scheduled runs switched off does NOT say "runs on schedule"', async () => {
  const { scheduleSavedNote } = await import('@tabs/agents/lib/schedule-note');
  const note = scheduleSavedNote(cron, false);
  assert.doesNotMatch(note, /runs on schedule/);
  assert.match(note, /Scheduled, but scheduled runs are switched off on this install/);
});

test('with scheduled runs on, a live CronJob does run on schedule', async () => {
  const { scheduleSavedNote } = await import('@tabs/agents/lib/schedule-note');
  assert.match(scheduleSavedNote(cron, true), /runs on schedule/);
  assert.match(scheduleSavedNote({ ...cron, ok: false, live: false, detail: 'cluster unreachable' }, true), /saved but not scheduled — cluster unreachable/);
});

test('both builder views use the shared note, and the route returns the flag', () => {
  for (const f of ['tabs/agents/ui/SystemView.tsx', 'tabs/agents/ui/SimpleBuilder.tsx']) {
    const src = readFileSync(join(process.cwd(), f), 'utf8');
    assert.doesNotMatch(src, /runs on schedule/, f);
    assert.match(src, /scheduleSavedNote\(/, f);
  }
  const route = readFileSync(join(process.cwd(), 'app/api/agents/systems/[id]/schedule/route.ts'), 'utf8');
  assert.match(route, /autonomousEnabled/);
});
