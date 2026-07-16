/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Pins the component registry shape so accidental regressions (stale engine
 * names, missing core components, wrong toggle flags) surface in CI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY, BY_ID } from './platform.ts';

test('REGISTRY has no component named after DuckDB (name field)', () => {
  // DuckDB was removed from the stack in favour of Trino. No component name
  // should present DuckDB as the active engine. Summaries may mention it as a
  // historical reference (e.g. "Replaced DuckDB") — that is intentional.
  for (const c of REGISTRY) {
    assert.doesNotMatch(c.name, /duckdb/i, `component ${c.id} name mentions DuckDB`);
  }
});

test('Trino is in the registry as a deployed component', () => {
  const trino = BY_ID['trino'];
  assert.ok(trino, 'trino component must be in registry');
  assert.equal(trino.layer, 'Layer 3 — Self-service');
  assert.equal(trino.kind, 'deploy');
  assert.ok(trino.summary.toLowerCase().includes('trino'));
});

test('mock-model summary makes clear it is local-dev only', () => {
  const m = BY_ID['mock-model'];
  assert.ok(m, 'mock-model must be in registry');
  assert.ok(
    /local|dev|not deployed on stackit/i.test(m.summary),
    'mock-model summary must note it is local/dev only',
  );
});

test('agent-runtime is in the registry', () => {
  const ar = BY_ID['agent-runtime'];
  assert.ok(ar, 'agent-runtime must be in registry');
  assert.equal(ar.layer, 'Layer 1 — Agent core');
});

test('data-runner is in the registry', () => {
  const dr = BY_ID['data-runner'];
  assert.ok(dr, 'data-runner must be in registry');
  assert.equal(dr.layer, 'Layer 3 — Self-service');
});

test('model-server is NOT in the registry (deleted from stack)', () => {
  assert.equal(BY_ID['model-server'], undefined, 'model-server was deleted from the stack and must not appear in the registry');
});

test('admin-console is NOT in the registry (deprecated/off)', () => {
  assert.equal(BY_ID['admin-console'], undefined, 'admin-console is deprecated (enabled:false) and must not appear in the registry');
});

test('harbor is NOT in the registry (off by default)', () => {
  assert.equal(BY_ID['harbor'], undefined, 'harbor is disabled (enabled:false) in the chart and must not appear in the registry');
});

test('core components (toggle:false) include os-ui, argocd, postgres, dbt, trino', () => {
  const cores = ['os-ui', 'argocd', 'postgres', 'dbt', 'trino'];
  for (const id of cores) {
    const c = BY_ID[id];
    assert.ok(c, `${id} must be in registry`);
    assert.equal(c.toggle, false, `${id} must be a core (non-toggleable) component`);
  }
});

test('BY_ID index matches REGISTRY length', () => {
  assert.equal(Object.keys(BY_ID).length, REGISTRY.length, 'BY_ID must index every registry entry with no duplicates');
});

test('all registry IDs are unique', () => {
  const ids = REGISTRY.map((c) => c.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, 'registry IDs must be unique');
});
