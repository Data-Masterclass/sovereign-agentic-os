/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Request surface context tests
 * USER STORY: As a maintainer I want the ambient `ui:<route>` / `mcp:<tool>` surface to survive
 *             async hops inside a scope and to be absent outside one.
 * ARCHITECTURE:
 *   - Pure node:test over AsyncLocalStorage; no I/O.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithSurface, currentSurface, uiSurfaceFor, newRequestId } from '@core/infra/request-surface';
import { tarArchive, tarList } from '@core/infra/tar';

test('currentSurface is null outside a scope and set (with a request id) inside, across awaits', async () => {
  assert.equal(currentSurface(), null);
  const seen = await runWithSurface('mcp:build_gold_join', async () => {
    await new Promise((r) => setTimeout(r, 1));
    return currentSurface();
  });
  assert.equal(seen?.surface, 'mcp:build_gold_join');
  assert.match(seen?.requestId ?? '', /^req_[0-9a-f]{16}$/);
  assert.equal(currentSurface(), null);
  const fixed = runWithSurface('ui:data', () => currentSurface(), 'req_fixed');
  assert.deepEqual(fixed, { surface: 'ui:data', requestId: 'req_fixed' });
});

test('uiSurfaceFor strips /api/ and the leading slash', () => {
  assert.equal(uiSurfaceFor('http://os-ui:3000/api/data/datasets/ds_1/checks?x=1'), 'ui:data/datasets/ds_1/checks');
  assert.equal(uiSurfaceFor('/api/data/datasets'), 'ui:data/datasets');
  assert.equal(uiSurfaceFor('/health'), 'ui:health');
  assert.match(newRequestId(), /^req_[0-9a-f]{16}$/);
});

test('tar round-trips files, pads to 512 and handles a >100-byte path via the prefix field', () => {
  const long = `${'d'.repeat(60)}/${'e'.repeat(60)}/file.sql`;
  const tar = tarArchive([
    { path: 'a.txt', content: Buffer.from('hello'), mtime: 1_700_000_000 },
    { path: long, content: Buffer.alloc(513, 1), mtime: 1_700_000_000 },
  ]);
  assert.equal(tar.length % 512, 0);
  const back = tarList(tar);
  assert.deepEqual(back.map((e) => e.path), ['a.txt', long]);
  assert.equal(back[0].content.toString(), 'hello');
  assert.equal(back[1].content.length, 513);
  const same = tarArchive([{ path: 'a.txt', content: Buffer.from('hello'), mtime: 1_700_000_000 }]);
  assert.ok(same.equals(tarArchive([{ path: 'a.txt', content: Buffer.from('hello'), mtime: 1_700_000_000 }])), 'deterministic');
});
