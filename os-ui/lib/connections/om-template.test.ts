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
} from './schema.ts';

test('the om-catalog template exists and is a service (Builder/Admin) connector', () => {
  const t = templateByKey('om-catalog');
  assert.ok(t, 'om-catalog template is registered');
  assert.equal(t!.auth, 'service');
  assert.equal(t!.type, 'API');
  assert.equal(t!.secretKey, 'om-bot-jwt');
  assert.equal(isPersonalConnectable(t!), false, 'not a personal OAuth connector');
});

// FLAG-OFF INVARIANT: the om-catalog template is NEVER in the default user-facing
// picker set, so with OPENMETADATA_CONNECT_ENABLED off nothing new appears in the
// UI/MCP. The API/MCP add it explicitly ONLY when the flag is on.
test('om-catalog is NOT user-facing by default (flag-off invariant)', () => {
  assert.ok(!USER_FACING_TEMPLATE_KEYS.includes('om-catalog'));
  assert.ok(!userFacingTemplates().some((t) => t.key === 'om-catalog'));
});

// Phase 1 is read/discover ONLY — the preset must expose ONLY read tools and carry
// NO write tool at all (the scoped write path is Phase 2).
test('the om-catalog preset is read-only by construction (no write tool at all)', () => {
  const t = templateByKey('om-catalog')!;
  assert.ok(t.tools.every((x) => x.write === false), 'no write tool is present');
  assert.ok(t.tools.every((x) => x.mode === 'Read'), 'every tool is Read mode');
  // The exact five read tools the phase-1 surface promises.
  assert.deepEqual(
    t.tools.map((x) => x.name).sort(),
    ['get_om_lineage', 'list_data_products', 'list_domains', 'list_tables', 'search_catalog'],
  );
});

test('there is exactly one om-catalog connection template', () => {
  assert.equal(CONNECTION_TEMPLATES.filter((t) => t.key === 'om-catalog').length, 1);
});
