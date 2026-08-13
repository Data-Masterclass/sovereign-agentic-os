/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * assist.test — the PURE "refine my app conversationally" helpers (0.6.134).
 *   • buildAssistPrompt(material, currentSpec, instruction) → the constrained EDIT prompt. Must carry
 *     the granted material (via the reused generate frame), the CURRENT spec, the INSTRUCTION, and the
 *     edit contract (change only what's asked; refuse un-satisfiable instructions unchanged).
 *   • parseAssistedSpec(rawText) → { ok, spec?, issues? }. Tolerant JSON recovery then parseAppSpec —
 *     the same structural gate as generation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAssistPrompt, parseAssistedSpec, assistRepairInstruction, type GenerateMaterial } from './assist.ts';
import type { AppSpec } from './schema.ts';

function material(): GenerateMaterial {
  return {
    appName: 'Orders Console',
    appDescription: 'Track and triage orders.',
    grantedDatasets: [
      { id: 'ds_orders', name: 'Orders', columns: ['order_id', 'amount', 'status', 'created_at'] },
    ],
    grantedMetrics: [{ id: 'm_revenue', name: 'Revenue' }],
    grantedAgents: [{ id: 'ag_triage', name: 'Triage agent' }],
    epics: [
      {
        id: 'ep1',
        title: 'Order tracking',
        stories: [{ id: 'st1', title: 'See all orders', features: ['List orders'], nfrs: [], rules: [] }],
      },
    ],
  };
}

function currentSpec(): AppSpec {
  return {
    version: 2,
    name: 'Orders Console',
    description: 'Track and triage orders.',
    tabs: [
      {
        id: 'orders',
        label: 'Orders',
        body: { kind: 'pattern', pattern: 'records-table', config: { source: { datasetId: 'ds_orders' }, columns: [{ field: 'order_id' }, { field: 'amount' }] } },
      },
    ],
  };
}

test('the assist prompt carries the granted dataset ids and their real columns (reused generate frame)', () => {
  const { user } = buildAssistPrompt(material(), currentSpec(), 'add a KPI tab');
  assert.match(user, /ds_orders/);
  assert.match(user, /order_id/);
  assert.match(user, /status/);
});

test('the assist prompt carries the CURRENT spec and the INSTRUCTION', () => {
  const { user } = buildAssistPrompt(material(), currentSpec(), 'make the Orders tab a kanban by status');
  assert.match(user, /CURRENT APP SPEC/);
  assert.match(user, /"pattern":"records-table"/);
  assert.match(user, /INSTRUCTION: make the Orders tab a kanban by status/);
});

test('the assist system frame states the edit contract (change only what is asked; refuse unchanged)', () => {
  const { system } = buildAssistPrompt(material(), currentSpec(), 'x');
  assert.match(system, /EDITING AN EXISTING SPEC/);
  assert.match(system, /full updated AppSpec/i);
  assert.match(system, /return the CURRENT spec UNCHANGED/);
});

test('the assist system frame still enumerates only cookbook patterns (records-table offered)', () => {
  const { system } = buildAssistPrompt(material(), currentSpec(), 'x');
  assert.match(system, /records-table/);
  assert.doesNotMatch(system, /editable-grid/);
});

test('the instruction is trimmed before embedding', () => {
  const { user } = buildAssistPrompt(material(), currentSpec(), '   add a tab   ');
  assert.match(user, /INSTRUCTION: add a tab\n/);
});

test('parseAssistedSpec accepts a good edited spec wired to granted data and real columns', () => {
  const good = JSON.stringify({
    version: 2,
    name: 'Orders Console',
    description: 'Track and triage orders.',
    tabs: [
      {
        id: 'orders',
        label: 'Orders',
        body: { kind: 'pattern', pattern: 'status-board', config: { source: { datasetId: 'ds_orders' }, statusField: 'status', titleField: 'order_id' } },
      },
    ],
  });
  const r = parseAssistedSpec(good);
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.issues));
  if (r.ok) assert.equal(r.spec.tabs[0].body.kind, 'pattern');
});

test('parseAssistedSpec recovers JSON wrapped in reasoning-model prose', () => {
  const wrapped =
    "I've updated the Orders tab:\n```json\n" +
    JSON.stringify(currentSpec()) +
    '\n```\nDone.';
  const r = parseAssistedSpec(wrapped);
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.issues));
});

test('parseAssistedSpec returns issues for a structurally-broken spec (no crash)', () => {
  const r = parseAssistedSpec(JSON.stringify({ version: 2, name: 'X', description: '', tabs: [] }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.issues.length > 0);
});

test('parseAssistedSpec fails cleanly on unrecoverable non-JSON', () => {
  const r = parseAssistedSpec("I can't do that safely.");
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.issues.length > 0);
});

test('assistRepairInstruction lists the exact issues to fix', () => {
  const seed = assistRepairInstruction([{ path: 'tabs.0.body.config.source', reason: 'dataset ds_x is not granted', fix: 'use a granted dataset' }]);
  assert.match(seed, /ds_x is not granted/);
  assert.match(seed, /use a granted dataset/);
});
