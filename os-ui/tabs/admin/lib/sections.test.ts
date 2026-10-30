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
import {
  ADMIN_SECTIONS,
  ADMIN_GROUP_ORDER,
  DEFAULT_SECTION,
  OVERVIEW_ACTION_MIN_ROLE,
  resolveSection,
  sectionMinRole,
  visibleSections,
} from './sections.ts';

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

// ---------------------------------------------------------------------------
// ONE ROUTE, TABS ON TOP (2026-10-30). Platform adopted the Governance look:
// the tile grid is gone and every section is a tab on `/platform`. That move
// destroyed the old pathname gate in platform/layout.tsx — which allowed ANY
// non-admin at exactly `/platform` because each admin surface used to be its own
// sub-route — so the role gate moved into the strip. These tests are the proof
// that it is fail-closed, because the page itself is a .tsx the harness cannot
// import.
// ---------------------------------------------------------------------------

test('PLATFORM: every section is reachable as a tab on one route', () => {
  for (const s of ADMIN_SECTIONS) {
    assert.equal(s.href, `/platform?section=${s.id}`, `${s.id} still points at its own route`);
  }
});

test('PLATFORM: the strip runs in group order, so related tabs sit together', () => {
  assert.deepEqual(visibleSections('admin').map((s) => s.id), [
    'overview', 'domains', 'settings', 'access', 'models', 'backups',
  ]);
  const groups = visibleSections('admin').map((s) => ADMIN_GROUP_ORDER.indexOf(s.group));
  assert.deepEqual(groups, [...groups].sort((a, b) => a - b), 'groups are interleaved');
});

test('PLATFORM: Overview & Health is builder-READABLE — the merge did not take the stricter role', () => {
  const overview = ADMIN_SECTIONS.find((s) => s.id === 'overview');
  assert.ok(overview, 'overview tab exists');
  assert.equal(overview.minRole, 'builder');
  assert.equal(overview.label, 'Overview & Health', 'the merged tab is labelled for both halves');
  assert.equal(DEFAULT_SECTION, 'overview');
  assert.deepEqual(visibleSections('builder').map((s) => s.id), ['overview']);
});

test('PLATFORM: …with admin-only ACTIONS — enable/disable a component is administration', () => {
  assert.equal(OVERVIEW_ACTION_MIN_ROLE, 'admin');
});

test('PLATFORM: every tab except the overview is admin-only', () => {
  for (const s of ADMIN_SECTIONS) {
    assert.equal(s.minRole, s.id === 'overview' ? 'builder' : 'admin', `${s.id} has the wrong floor`);
  }
});

test('PLATFORM: the strip is fail-closed — no role, no tabs', () => {
  assert.deepEqual(visibleSections(null).map((s) => s.id), [], 'an unresolved role must see nothing');
  assert.deepEqual(visibleSections('creator').map((s) => s.id), [], 'a creator has no platform surface');
  assert.deepEqual(visibleSections('domain_admin').map((s) => s.id), ['overview']);
  assert.equal(resolveSection(null, null), null, 'nothing renders while the role is unresolved');
});

test('PLATFORM: a non-admin hand-crafting ?section=domains gets NOTHING', () => {
  for (const id of ['domains', 'settings', 'access', 'models', 'backups']) {
    assert.equal(resolveSection(id, 'builder'), null, `a builder reached ${id} by URL`);
    assert.equal(resolveSection(id, 'domain_admin'), null, `a domain_admin reached ${id} by URL`);
    assert.equal(resolveSection(id, 'creator'), null, `a creator reached ${id} by URL`);
    assert.equal(resolveSection(id, null), null, `an unresolved role reached ${id} by URL`);
    assert.equal(resolveSection(id, 'admin'), id, `an admin cannot reach ${id}`);
  }
});

test('PLATFORM: sectionMinRole is what each component re-checks, and is fail-closed', () => {
  assert.equal(sectionMinRole('overview'), 'builder');
  for (const id of ['domains', 'settings', 'access', 'models', 'backups']) {
    assert.equal(sectionMinRole(id), 'admin');
  }
  assert.equal(sectionMinRole('not-a-section'), 'admin', 'an unknown id must not fail open');
});

test('PLATFORM: a non-admin lands on the overview; an unknown id falls back there', () => {
  assert.equal(resolveSection(null, 'builder'), 'overview');
  assert.equal(resolveSection('', 'builder'), 'overview');
  assert.equal(resolveSection('nonsense', 'builder'), 'overview');
  assert.equal(resolveSection('nonsense', 'admin'), 'overview');
  assert.equal(resolveSection('overview', 'builder'), 'overview');
  assert.equal(resolveSection('nonsense', 'creator'), null, 'a creator gets nothing, not the overview');
});
