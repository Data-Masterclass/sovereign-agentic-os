/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The delete-domain plan card says, in words, whether the run can go and why not
 * USER STORY: As the admin who clicked "Delete…" I want to see straight away whether the delete
 *             can run, and if not, exactly what stops it — never a button that does nothing.
 * ARCHITECTURE:
 *   - Pure, client-safe helper the plan card (tabs/admin/ui/DomainsAdmin.tsx) renders from.
 *   - Dev, 2026-11-24: every plan carried a block the card showed only as a count in a hint line,
 *     below the domains table and out of view, so the owner saw "nothing happened".
 *   - Negative twin: a clean plan (something to remove, nothing blocked) can run, with no reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteRunGate } from '@tabs/admin/lib/domain-delete-view';

const comp = (component: string, remove: number, blocked: { kind: string; label: string; reason: string }[] = []) => ({
  component,
  remove: Array.from({ length: remove }, (_, i) => ({ kind: 'x', label: `${component}-${i}` })),
  keep: [],
  blocked,
});

test('a blocked plan cannot run, and the reason names each block', () => {
  const plan = {
    totals: { remove: 12, keep: 0, blocked: 1 },
    components: [comp('os.files', 1), comp('trino', 0, [{ kind: 'purge-window', label: 'Trino catalog iceberg_purge', reason: 'the purge window is closed' }])],
  };
  const g = deleteRunGate(plan);
  assert.equal(g.canRun, false);
  assert.match(g.why ?? '', /trino/);
  assert.match(g.why ?? '', /the purge window is closed/);
});

test('nothing to remove → cannot run, and says so', () => {
  const g = deleteRunGate({ totals: { remove: 0, keep: 2, blocked: 0 }, components: [] });
  assert.equal(g.canRun, false);
  assert.match(g.why ?? '', /nothing to remove/i);
});

test('negative twin: a clean plan can run, with no reason', () => {
  const g = deleteRunGate({ totals: { remove: 3, keep: 0, blocked: 0 }, components: [comp('os.files', 3)] });
  assert.deepEqual(g, { canRun: true });
});
