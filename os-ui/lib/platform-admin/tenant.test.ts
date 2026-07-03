/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTenant, updateTenant, currentTenantId } from './tenant.ts';

test('globalThis pin: tenantState is shared under soa.platform.tenants', () => {
  const before = getTenant();
  updateTenant({ envelopeEUR: 9999 });
  const pinned = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.platform.tenants')] as { tenants: Map<string, { envelopeEUR: number }> };
  assert.ok(pinned, 'state must be present on globalThis');
  const t = pinned.tenants.get(currentTenantId());
  assert.ok(t, 'tenant must exist in globalThis state');
  assert.equal(t!.envelopeEUR, 9999, 'update must be reflected in globalThis state');
  // restore
  updateTenant({ envelopeEUR: before.envelopeEUR });
});
