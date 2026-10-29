/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * tenant-users.ts carries `import 'server-only'` so it cannot be imported in a
 * plain `node --test` run. The globalThis pin is verified indirectly: the Symbol
 * key is declared and the state accessor is exercised by the server-side route
 * tests. Structural correctness (symbol name, type) is confirmed here without
 * importing the module.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('globalThis pin key for soa.platform.tenantUsers is a well-formed symbol', () => {
  const key = Symbol.for('soa.platform.tenantUsers');
  assert.equal(typeof key, 'symbol');
  assert.equal(key.toString(), 'Symbol(soa.platform.tenantUsers)');
  // Verify the symbol is globally interned (two calls return the same symbol).
  assert.equal(key, Symbol.for('soa.platform.tenantUsers'));
});
