/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTION_TEMPLATES,
  USER_FACING_TEMPLATE_KEYS,
  userFacingTemplates,
  templateByKey,
  isPersonalConnectable,
} from '../schema.ts';
import { WAREHOUSE_PROVIDERS } from './registry.ts';
import { WAREHOUSE_PLATFORMS } from './types.ts';

test('the warehouse template exists and is a service (Builder/Admin) connector', () => {
  const t = templateByKey('warehouse');
  assert.ok(t, 'warehouse template is registered');
  assert.equal(t!.auth, 'service');
  assert.equal(isPersonalConnectable(t!), false, 'not a personal OAuth connector');
});

// FLAG-OFF INVARIANT: the warehouse template is NEVER in the default user-facing
// picker set, so with EXTERNAL_CONNECTORS_ENABLED off nothing new appears. When the
// flag is on, the API/MCP add it explicitly (tested at those layers) — the default
// picker list is unchanged regardless.
test('warehouse is NOT user-facing by default (flag-off invariant)', () => {
  assert.ok(!USER_FACING_TEMPLATE_KEYS.includes('warehouse'));
  assert.ok(!userFacingTemplates().some((t) => t.key === 'warehouse'));
});

// Federation is read-only; the preset must expose only read tools + a blocked/off write.
test('the warehouse preset is read-only by construction', () => {
  const t = templateByKey('warehouse')!;
  const writes = t.tools.filter((x) => x.write);
  for (const w of writes) {
    assert.ok(w.mode === 'Off' || w.mode === 'Blocked', `${w.name} write must not be enabled by default`);
  }
  assert.ok(t.tools.some((x) => !x.write && x.mode === 'Read'), 'at least one read tool is exposed');
});

// The picker (API/MCP) renders fields generically FROM the provider registry — so
// every platform the union names has renderable credential fields with a valid split.
test('every warehouse platform has renderable credential fields', () => {
  for (const p of WAREHOUSE_PLATFORMS) {
    const pr = WAREHOUSE_PROVIDERS[p];
    assert.ok(pr.credentialFields.length > 0, `${p} exposes credential fields`);
    // Every declared secret key corresponds to a real credential field (no orphan secret).
    for (const key of pr.secretMaterial.secretKeys) {
      assert.ok(pr.credentialFields.some((f) => f.key === key), `${p}: secret key ${key} has a field`);
    }
  }
});

// The single generic template + the discriminated union is the whole surface —
// there is exactly ONE warehouse template, not one-per-platform (the design choice).
test('there is exactly one warehouse connection template', () => {
  assert.equal(CONNECTION_TEMPLATES.filter((t) => t.key === 'warehouse').length, 1);
});
