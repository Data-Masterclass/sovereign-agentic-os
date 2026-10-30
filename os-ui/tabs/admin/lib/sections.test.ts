/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests for the admin menu's single source of truth.
 *
 * USER STORY: As a platform admin, every tile in Admin takes me somewhere that
 *             works. In particular LLM Gateway opens LiteLLM's ADMIN CONSOLE,
 *             not its API documentation page.
 *
 * ARCHITECTURE:
 *   `sections.ts` is data, so these are plain assertions over it. The gateway
 *   case exists because of a real regression: the tile pointed at the proxy
 *   ROOT (`/tools/litellm`), which upstream is LiteLLM's FastAPI Swagger page.
 *   Its assets are root-absolute, so behind the `/tools/litellm` prefix they
 *   404 and the tab renders blank with the title "API - Swagger UI". The admin
 *   console is at `/ui` under LiteLLM's SERVER_ROOT_PATH.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_SECTIONS, ADMIN_GROUP_ORDER } from './sections.ts';

test('ADMIN-SECTIONS: no LLM Gateway tile while the embedded console is unverified', () => {
  assert.equal(ADMIN_SECTIONS.find((s) => s.id === 'gateway'), undefined);
});

test('ADMIN-SECTIONS: nothing links at the proxy ROOT, which is LiteLLM’s API docs', () => {
  for (const s of ADMIN_SECTIONS) {
    assert.notEqual(s.href, '/tools/litellm', `${s.id} points at the Swagger page`);
  }
});

test('ADMIN-SECTIONS: every section has a usable href and a known group', () => {
  for (const s of ADMIN_SECTIONS) {
    assert.ok(s.href.startsWith('/'), `${s.id} has a non-absolute href: ${s.href}`);
    assert.ok(s.label.length > 0, `${s.id} has no label`);
    assert.ok(ADMIN_GROUP_ORDER.includes(s.group), `${s.id} is in unknown group "${s.group}"`);
  }
});

test('ADMIN-SECTIONS: section ids are unique', () => {
  const ids = ADMIN_SECTIONS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('PLATFORM: holds only tenant administration', () => {
  const ids = ADMIN_SECTIONS.map((s) => s.id).sort();
  assert.deepEqual(ids, [
    'access', 'backups', 'domains', 'models', 'overview', 'settings',
  ]);
});

test('PLATFORM: the moved surfaces are gone', () => {
  for (const gone of ['billing', 'roles', 'security', 'plugins', 'mcp-apis', 'oauth-apps', 'my-mcp', 'my-settings', 'licenses', 'components', 'gateway']) {
    assert.equal(ADMIN_SECTIONS.find((s) => s.id === gone), undefined, `${gone} still in Platform`);
  }
});

test('PLATFORM: three groups, in order', () => {
  assert.deepEqual([...ADMIN_GROUP_ORDER], ['Tenant', 'Models', 'Infrastructure']);
});
