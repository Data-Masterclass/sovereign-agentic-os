/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    Commits reduce the FRESH document — no lost update from a stale snapshot
 * USER STORY: As a process owner removing two links in a row I must end up without both, instead of
 *             the first one reappearing because the second save carried a pre-edit copy of the file.
 * ARCHITECTURE:
 *   - The editor used to serialise a WHOLE document from the render the click happened in and send
 *     it with a sha re-read immediately before the PATCH — so the sha check could never fire and
 *     the later write silently reverted the earlier one.
 *   - A commit is now a REDUCER applied to the document the store just handed back, committed with
 *     THAT read's sha. These tests drive it against a fake store, which is the only way to prove
 *     ordering + freshness without a server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow, serializeWorkflow, type Workflow } from '@tabs/knowledge/lib/schema';
import { commitReducer, type WorkflowStore } from '@tabs/knowledge/lib/workflow-commit';
import { createCommitQueue } from '@tabs/knowledge/lib/commit-queue';
import { removeStepLink, addStep } from '@tabs/knowledge/lib/step-edit';

const BASE = `---
id: wf
title: WF
domain: sales
visibility: Personal
status: draft
version: "1"
actors: []
---

\`\`\`step
id: one
title: One
actor: Human
links:
  - type: data
    ref: A
  - type: data
    ref: B
\`\`\`
`;

/** A store with the server's optimistic concurrency: a write must carry the sha it read. */
function fakeStore(md: string) {
  let current = md;
  let sha = 'sha-1';
  let n = 1;
  const sentShas: string[] = [];
  const store: WorkflowStore = {
    async read() {
      return { workflow: parseWorkflow(current), sha };
    },
    async patch(nextMd: string, withSha: string) {
      sentShas.push(withSha);
      if (withSha !== sha) throw new Error('409 workflow.md changed since you loaded it');
      current = nextMd;
      sha = `sha-${++n}`;
    },
  };
  return { store, sentShas, get md() { return current; } };
}

test('two edits queued back to back BOTH land — the second reduces the FRESH document', async () => {
  const s = fakeStore(BASE);
  const q = createCommitQueue();
  // Both are enqueued before the first has run: each reducer must see the document as it is
  // when its turn comes, not as it was when the click happened.
  const first = q.enqueue(() => commitReducer(s.store, (fresh) => removeStepLink(fresh, 'one', { type: 'data', ref: 'A' })));
  const second = q.enqueue(() => commitReducer(s.store, (fresh) => removeStepLink(fresh, 'one', { type: 'data', ref: 'B' })));
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }]);
  const after = parseWorkflow(s.md);
  assert.deepEqual(after.steps[0].links, [], 'neither removed link may come back');
  assert.deepEqual(s.sentShas, ['sha-1', 'sha-2'], 'each commit carries the sha of its own read');
});

test('an add and a remove queued together both survive (no whole-document overwrite)', async () => {
  const s = fakeStore(BASE);
  const q = createCommitQueue();
  const a = q.enqueue(() => commitReducer(s.store, (fresh) => addStep(fresh, { title: 'Two', actor: 'Agent' })));
  const b = q.enqueue(() => commitReducer(s.store, (fresh) => removeStepLink(fresh, 'one', { type: 'data', ref: 'A' })));
  assert.deepEqual(await Promise.all([a, b]), [{ ok: true }, { ok: true }]);
  const after = parseWorkflow(s.md);
  assert.deepEqual(after.steps.map((x) => x.id), ['one', 'two']);
  assert.deepEqual(after.steps[0].links.map((l) => l.ref), ['B']);
});

test('commitReducer PATCHes with the sha it just read, so a genuine conflict still 409s', async () => {
  const store: WorkflowStore = {
    async read() { return { workflow: parseWorkflow(BASE), sha: 'sha-OLD' }; },
    async patch(_md: string, withSha: string) {
      if (withSha !== 'sha-NEW') throw new Error('409 workflow.md changed since you loaded it');
    },
  };
  await assert.rejects(() => commitReducer(store, (w: Workflow) => w), /409/);
});

test('commitReducer sends exactly the serialisation of the reduced fresh document', async () => {
  const s = fakeStore(BASE);
  await commitReducer(s.store, (fresh) => removeStepLink(fresh, 'one', { type: 'data', ref: 'A' }));
  const expected = serializeWorkflow(removeStepLink(parseWorkflow(BASE), 'one', { type: 'data', ref: 'A' }));
  assert.equal(s.md, expected);
});
