/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProfile,
  triggerLabel,
  toolTraceRows,
  lastRunReport,
  type RingTraceLike,
} from './agent-diagnosis-core.ts';
import type { System } from '../agents/system-schema.ts';
import type { LastRun } from '../agents/store.ts';

// ----------------------------------------------------------------- fixtures --

function sys(overrides: Partial<System> = {}): System {
  return {
    version: '1',
    system: { name: 'Northpeak Ops', domain: 'sales', visibility: 'Personal', description: 'Weekly digest' },
    runtime: 'langgraph',
    safetyPreset: 'read-only',
    entrypoint: 'planner',
    state: { channels: { messages: 'add_messages' } },
    grants: {
      data: [
        { id: 'ds-1', capability: 'Read', layer: 'gold' },
        { id: 'ds-unknown', capability: 'Read' },
      ],
      knowledge: [{ id: 'kw-1', capability: 'Read' }],
      metrics: [],
      tools: ['metrics', 'retrieve'],
      connections: [],
      files: [{ id: '', capability: 'Read', folder: { path: '/reports', scope: 'domain' } }],
      plan: [],
    },
    routing: { overrides: { writer: 'gpt-large' } },
    agents: [
      { id: 'planner', role: 'Plans the digest', agent_md: '', memory_md: '', members: ['writer'] },
      { id: 'writer', role: 'Writes it', agent_md: '', memory_md: '' },
      { id: 'checker', role: 'Checks it', agent_md: '', memory_md: '', model: 'claude-fast' },
    ],
    edges: [],
    ...overrides,
  };
}

const NAMES: Record<string, string> = { 'ds-1': 'Orders (gold)', 'kw-1': 'Refunds workflow' };
const nameOf = (_kind: string, id: string) => NAMES[id];

// ------------------------------------------------------------------ profile --

test('triggerLabel covers manual, cron and event', () => {
  assert.equal(triggerLabel(undefined), 'Manual');
  assert.equal(triggerLabel({ kind: 'manual' }), 'Manual');
  assert.equal(triggerLabel({ kind: 'cron', cron: '0 7 * * 1' }), 'Scheduled · 0 7 * * 1');
  assert.equal(triggerLabel({ kind: 'cron' }), 'Scheduled');
  assert.equal(triggerLabel({ kind: 'event', event: 'dataset.built' }), 'Event · dataset.built');
});

test('buildProfile maps nodes: model precedence, supervisor/entry/disabled flags', () => {
  const p = buildProfile(sys(), { disabledAgents: ['checker'], schedule: { kind: 'manual' } }, nameOf);
  assert.equal(p.runtime, 'langgraph');
  assert.equal(p.safetyPreset, 'read-only');
  assert.equal(p.trigger, 'Manual');
  assert.equal(p.description, 'Weekly digest');
  assert.deepEqual(
    p.nodes.map((n) => [n.id, n.model, n.supervisor, n.entry, n.disabled]),
    [
      ['planner', 'auto', true, true, false],
      ['writer', 'gpt-large', false, false, false], // routing override wins over 'auto'
      ['checker', 'claude-fast', false, false, true], // explicit model wins; disabled carried
    ],
  );
});

test('buildProfile resolves grant names via lookup, falls back to raw id, names folders', () => {
  const p = buildProfile(sys(), {}, nameOf);
  const byKind = Object.fromEntries(p.grants.map((g) => [g.kind, g]));
  assert.equal(byKind.data.count, 2);
  assert.deepEqual(byKind.data.rows.map((r) => r.name), ['Orders (gold)', 'ds-unknown']);
  assert.equal(byKind.data.rows[0].capability, 'Read · gold');
  assert.deepEqual(byKind.knowledge.rows.map((r) => r.name), ['Refunds workflow']);
  assert.equal(byKind.files.rows[0].name, '/reports (domain folder)');
  assert.equal(byKind.metrics.count, 0);
  assert.deepEqual(p.tools, ['metrics', 'retrieve']);
});

test('buildProfile uses the record schedule over the yaml schedule', () => {
  const p = buildProfile(sys({ schedule: { kind: 'manual' } }), { schedule: { kind: 'cron', cron: '@daily' } }, nameOf);
  assert.equal(p.trigger, 'Scheduled · @daily');
});

// --------------------------------------------------------------- tool trace --

const T0 = '2026-06-27T10:00:00.000Z';

function ring(overrides: Partial<RingTraceLike> = {}): RingTraceLike {
  return { timestamp: T0, principal: 'os-sys1', tool: 'metrics', decision: 'allow', output: 'ok', landed: true, ...overrides };
}

test('toolTraceRows keeps only this system principal (base and :node), extracts node', () => {
  const rows = toolTraceRows(
    [
      ring(),
      ring({ principal: 'os-sys1:writer', tool: 'retrieve' }),
      ring({ principal: 'os-sys10' }), // different system — prefix must not fuzzy-match
      ring({ principal: 'os-other' }),
      ring({ principal: 'user-alex' }),
    ],
    'sys1',
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].node, undefined);
  assert.deepEqual([rows[1].tool, rows[1].node], ['retrieve', 'writer']);
});

test('toolTraceRows: deny/error output carries a short detail, allow stays clean', () => {
  const rows = toolTraceRows(
    [
      ring({ decision: 'deny', output: 'blocked by policy' }),
      ring({ output: `Error: ${'x'.repeat(300)}` }),
      ring(),
    ],
    'sys1',
  );
  assert.equal(rows[0].detail, 'blocked by policy');
  assert.ok(rows[1].detail!.length <= 140 && rows[1].detail!.endsWith('…'));
  assert.equal(rows[2].detail, undefined);
});

test('toolTraceRows drops bad timestamps and honors the limit', () => {
  const rows = toolTraceRows(
    [ring({ timestamp: 'not-a-date' }), ring(), ring(), ring()],
    'sys1',
    2,
  );
  assert.equal(rows.length, 2);
});

// ---------------------------------------------------------- last-run report --

test('lastRunReport passes null through and trims a real run', () => {
  assert.equal(lastRunReport(null), null);
  assert.equal(lastRunReport(undefined), null);

  const run: LastRun = {
    at: 1750000000000,
    running: false,
    ok: false,
    path: ['planner', 'writer'],
    traces: 4,
    held: 1,
    steps: [{ node: 'planner', tool: 'metrics', effect: 'allow', ran: true }],
    mode: 'offline-mock',
    output: 'y'.repeat(3000),
    nodes: [
      {
        node: 'writer',
        model: 'gpt-large',
        tier: 'reasoning',
        tierReason: 'writes long-form',
        status: 'error',
        error: 'timeout',
        input: 'z'.repeat(500),
        finalText: 'done',
        steps: [{ tool: 'retrieve', isError: true, summary: 'denied' }, { tool: 'metrics' }],
      },
    ],
  };
  const v = lastRunReport(run)!;
  assert.equal(v.ok, false);
  assert.equal(v.trigger, 'interactive · offline-mock');
  assert.deepEqual(v.path, ['planner', 'writer']);
  assert.equal(v.held, 1);
  assert.ok(v.output!.length <= 2000);
  assert.equal(v.nodes.length, 1);
  const n = v.nodes[0];
  assert.deepEqual([n.status, n.error, n.tier], ['error', 'timeout', 'reasoning']);
  assert.ok(n.input!.length <= 400);
  assert.deepEqual(n.steps, [
    { tool: 'retrieve', isError: true, summary: 'denied' },
    { tool: 'metrics', isError: false, summary: undefined },
  ]);
});
