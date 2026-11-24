/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Four eyes in the Connections tab's held-write card
 * USER STORY: As the person whose call was held I am not offered "Approve once" / "Approve &
 *             remember" (the server would refuse them); I am told the write waits in the Governance inbox.
 * ARCHITECTURE: a source-level check of `ConnectionBuilder.tsx` (the tab has no component test
 *   harness). The held-write card is always the viewer's OWN call, so it has no approve control at all
 *   and points at the Governance inbox.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('./ConnectionBuilder.tsx', import.meta.url)), 'utf8');

test('the held-write card offers no inline approve, and never posts to the approve / remember routes', () => {
  assert.doesNotMatch(SRC, /Approve once|Approve &amp; remember/);
  assert.doesNotMatch(SRC, /\/approve`|\/remember`/);
});

test('the held-write card names the Governance inbox and offers only Dismiss', () => {
  const start = SRC.indexOf('Write approval required');
  assert.ok(start > 0);
  const card = SRC.slice(start, SRC.indexOf('Attach to a specific agent', start));
  assert.match(card, /Governance inbox/);
  assert.match(card, /href="\/governance"/);
  assert.match(card, />Dismiss</);
});
