/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { putSecret, hasSecret, deleteSecret } from './secrets.ts';

test('globalThis pin: create survives a fresh vault() call', () => {
  const ref = putSecret('db', 'password', 's3cr3t');

  // Confirm item is visible via the globalThis symbol directly.
  const pinned = (globalThis as any)[Symbol.for('soa.secrets.vault')] as Map<string, unknown>;
  assert.ok(pinned instanceof Map, 'globalThis pin is a Map');
  assert.ok(pinned.has('db/password'), 'secret key visible via globalThis pin');

  // hasSecret() calls vault() afresh — must still return true.
  assert.equal(hasSecret(ref), true);

  deleteSecret(ref);
  assert.equal(pinned.has('db/password'), false, 'delete clears via pinned map');
});
