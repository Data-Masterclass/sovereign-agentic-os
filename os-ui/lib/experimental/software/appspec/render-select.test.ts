/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * render-select.test — the pure TAB-gating core the renderer inherits: role filtering across the
 * ladder, default tab pick, and empty-set safety. No DOM. (The JSX itself is covered by tsc +
 * `npm run build`, matching the established pattern — pure logic is tested here.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleTabs, pickTab } from './render-select.ts';
import type { AppSpec, Tab } from './schema.ts';

/** A simple custom-body tab (no store references needed for gating tests). */
const tab = (id: string, roleGate?: Tab['roleGate']): Tab => ({
  id,
  label: id,
  ...(roleGate ? { roleGate } : {}),
  body: { kind: 'custom', html: `<h1>${id}</h1>` },
});

function spec(tabs: Tab[]): AppSpec {
  return { version: 2, name: 'T', description: 'd', tabs };
}

// -------------------------------------------------------------- visibleTabs ----------

test('ungated tabs are always visible; gated tabs respect the ladder', () => {
  const s = spec([tab('home'), tab('ops', 'domain_admin')]);
  assert.deepEqual(visibleTabs(s, 'creator').map((x) => x.id), ['home']);
  assert.deepEqual(visibleTabs(s, 'admin').map((x) => x.id), ['home', 'ops']);
  assert.deepEqual(visibleTabs(s, 'domain_admin').map((x) => x.id), ['home', 'ops']);
  assert.deepEqual(visibleTabs(s, 'builder').map((x) => x.id), ['home']);
});

test('a null role (loading/signed-out) sees ONLY ungated tabs, never crashes', () => {
  const s = spec([tab('home'), tab('ops', 'builder')]);
  assert.deepEqual(visibleTabs(s, null).map((x) => x.id), ['home']);
});

test('visibleTabs preserves the authored nav order', () => {
  const s = spec([tab('c'), tab('a'), tab('b')]);
  assert.deepEqual(visibleTabs(s, 'admin').map((x) => x.id), ['c', 'a', 'b']);
});

// ----------------------------------------------------------------- pickTab ----------

test('pickTab returns the requested visible tab', () => {
  const s = spec([tab('home'), tab('reports')]);
  assert.equal(pickTab(s, 'reports', 'creator')?.id, 'reports');
});

test('pickTab defaults to the first VISIBLE tab when activeId is missing/unknown', () => {
  const s = spec([tab('home'), tab('reports')]);
  assert.equal(pickTab(s, null, 'creator')?.id, 'home');
  assert.equal(pickTab(s, 'does-not-exist', 'creator')?.id, 'home');
});

test('pickTab never lands a viewer on a tab their role cannot reach', () => {
  const s = spec([tab('home'), tab('ops', 'admin')]);
  assert.equal(pickTab(s, 'ops', 'creator')?.id, 'home');
  assert.equal(pickTab(s, 'ops', 'admin')?.id, 'ops');
});

test('pickTab returns undefined when the viewer has no visible tab (empty-safety)', () => {
  const s = spec([tab('ops', 'admin')]);
  assert.equal(pickTab(s, null, 'creator'), undefined);
});

test('pickTab returns undefined for a spec with no tabs at all', () => {
  assert.equal(pickTab(spec([]), null, 'admin'), undefined);
});
