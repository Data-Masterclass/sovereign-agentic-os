/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Four eyes in the Connections tab's held-write card
 * USER STORY: As the person whose call was held I am not offered "Approve once" / "Approve &
 *             remember" (the server would refuse them); I am told the write waits in the Governance inbox.
 * ARCHITECTURE: a source-level check of `ConnectionBuilder.tsx` (the tab has no component test
 *   harness): the card shown for the viewer's OWN call (`ownCall`) renders no approve button and
 *   points at the Governance inbox; the approve buttons live only in the other branch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('./ConnectionBuilder.tsx', import.meta.url)), 'utf8');

test('the card for the viewer’s own held call is marked ownCall', () => {
  assert.match(SRC, /setApprovalState\(\{[^}]*ownCall: true[^}]*\}\)/);
});

test('the ownCall branch offers no approve button and names the Governance inbox', () => {
  const start = SRC.indexOf('{approvalState.ownCall ? (');
  assert.ok(start > 0, 'the card branches on ownCall');
  const end = SRC.indexOf(') : (', start);
  const ownBranch = SRC.slice(start, end);
  assert.doesNotMatch(ownBranch, /onClick=\{approveOnce\}|onClick=\{approveRemember\}/);
  assert.match(ownBranch, /Governance inbox/);
  assert.match(ownBranch, /href="\/governance"/);
  // The approve buttons exist only in the other branch.
  const other = SRC.slice(end, SRC.indexOf(')}', end));
  assert.match(other, /onClick=\{approveOnce\}/);
});
