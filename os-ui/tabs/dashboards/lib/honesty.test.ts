/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    The two honesty fixes — the viz-type enum drift tripwire and the typed filter refusal
 * USER STORY: As a user I must never be shown an unfiltered number as though it were filtered, and
 *             as an agent I must not be refused a chart kind the UI offers (D10, D11, D12, D13).
 * ARCHITECTURE:
 *   - Pure. `lib/model.ts` and the MCP tool's declared schema only — no route, no `.tsx`.
 *   - The enum test compares the ADVERTISED MCP schema against `VIZ_TYPES`, so the two cannot
 *     drift: adding a viz type without widening the enum fails here.
 *   - The RUNTIME half of the filter refusal (that `runPanelQuery` refuses before it queries) lives
 *     in `lib/build/panel-query.test.ts`, which already owns the governed-path harness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PANEL_TIME_GRAINS,
  SERVABLE_FILTER_OPERATORS,
  VIZ_TYPES,
  assertServableFilters,
  isServableOperator,
  isServableTimeGrain,
  unservableFilterError,
  unservableFilters,
  unservableTimeGrainError,
  type Panel,
  type VizType,
} from '@tabs/dashboards/lib/model';
import { VIZ_TYPES as UI_VIZ_TYPES } from '@tabs/dashboards/ui/shared';
import { dashboardWriteTools } from '@tabs/dashboards/mcp/dashboard-write-tools';

// --------------------------------------------------------------- D11: the enum tripwire ---

/** The `vizType` enum the `create_dashboard` tool actually advertises to a client. */
function advertisedVizEnum(): string[] {
  const tool = dashboardWriteTools.find((t) => t.name === 'create_dashboard');
  assert.ok(tool, 'create_dashboard must exist');
  const schema = tool!.inputSchema as unknown as {
    properties: { charts: { items: { properties: { vizType: { enum?: string[] } } } } };
  };
  const e = schema.properties.charts.items.properties.vizType.enum;
  assert.ok(e, 'create_dashboard must advertise a vizType enum');
  return e!;
}

test('D11 — create_dashboard’s vizType enum EQUALS the VizType union', () => {
  assert.deepEqual(
    [...advertisedVizEnum()].sort(),
    [...VIZ_TYPES].sort(),
    'the MCP enum and lib/model VIZ_TYPES have drifted — spread VIZ_TYPES into the schema',
  );
});

test('D11 — the UI dropdown offers no viz type the MCP cannot accept', () => {
  const advertised = new Set(advertisedVizEnum());
  for (const v of UI_VIZ_TYPES) {
    assert.ok(advertised.has(v), `the UI offers “${v}” but the MCP enum does not accept it`);
  }
});

test('D11 — every VIZ_TYPES member type-checks as a VizType (the derivation holds)', () => {
  const all: VizType[] = [...VIZ_TYPES];
  assert.equal(all.length, 7);
  assert.ok(all.includes('pie') && all.includes('area') && all.includes('big_number_total'));
});

// ----------------------------------------------- D10/D13: the typed filter refusal ---

const base: Panel = { name: 'Revenue', vizType: 'bar', metrics: ['Orders.revenue'] };

test('D10 — equals and in are servable; nothing else is', () => {
  assert.deepEqual([...SERVABLE_FILTER_OPERATORS], ['equals', 'in']);
  assert.equal(isServableOperator('equals'), true);
  assert.equal(isServableOperator('in'), true);
  for (const op of ['>=', '<=', '>', '<', 'notEquals', 'contains', 'between', 'like', 'set']) {
    assert.equal(isServableOperator(op), false, op);
  }
});

test('D10 — a panel with no filters, or only servable ones, is accepted', () => {
  assert.deepEqual(unservableFilters(base), []);
  assert.equal(unservableFilterError(base), null);
  const ok: Panel = { ...base, filters: [{ member: 'Orders.region', operator: 'equals', values: ['DE'] }, { member: 'Orders.channel', operator: 'in', values: ['web', 'retail'] }] };
  assert.equal(unservableFilterError(ok), null);
  assert.doesNotThrow(() => assertServableFilters(ok));
});

test('D10 — `operator: ">="` is a typed bad_request naming the member and the operator', () => {
  const panel: Panel = { ...base, filters: [{ member: 'Orders.amount', operator: '>=', values: ['1000'] }] };
  assert.deepEqual(unservableFilters(panel).map((f) => f.operator), ['>=']);
  const e = unservableFilterError(panel);
  assert.ok(e, 'an unservable operator must produce an error');
  assert.equal(e!.status, 400, 'it must be a typed bad_request, not a 500 and not a silent drop');
  assert.match(e!.message, /Orders\.amount >=/);
  assert.match(e!.message, /`equals` and `in`/);
  assert.match(e!.message, /REFUSED/);
  assert.throws(() => assertServableFilters(panel), /cannot be served/);
});

test('D13 — a panel carries no SQL field at all; the only inputs are governed members', () => {
  // Structural, not stylistic: a panel's typed surface must offer nowhere to put a query.
  const keys = new Set(Object.keys({
    name: '', vizType: 'bar', metrics: [], metric: '', dimensions: [], timeDimension: '',
    timeGrain: 'day', filters: [], gridPos: { x: 0, y: 0, w: 1, h: 1 },
  } satisfies Required<Panel>));
  for (const forbidden of ['sql', 'query', 'expression', 'rawSql', 'adhoc']) {
    assert.equal(keys.has(forbidden), false, `Panel must never grow a \`${forbidden}\` field`);
  }
});

// -------------------------------------------- H-1: the time grain is allow-listed ---

/** The payload that closes `date_trunc('<grain>'` and appends a statement. */
const INJECTION = "month'), (SELECT password FROM users) --";

test('H-1 — the servable grains are the metrics `Granularity` set, as a RUNTIME list', () => {
  assert.deepEqual([...PANEL_TIME_GRAINS], ['day', 'week', 'month', 'quarter', 'year']);
  for (const g of PANEL_TIME_GRAINS) assert.equal(isServableTimeGrain(g), true, g);
});

test('H-1 — the injection payload is NOT a servable grain', () => {
  assert.equal(isServableTimeGrain(INJECTION), false);
  for (const bad of ["month'", 'MONTH', 'month ', 'hour', '', 'day;drop', null, undefined, 7, {}]) {
    assert.equal(isServableTimeGrain(bad), false, String(bad));
  }
});

test('H-1 — an unservable grain is a typed bad_request that does not echo the whole payload', () => {
  const panel: Panel = { name: 'Trend', vizType: 'line', metrics: ['Orders.revenue'], timeDimension: 'Orders.d', timeGrain: INJECTION as never };
  const e = unservableTimeGrainError(panel);
  assert.ok(e, 'an unservable grain must be refused');
  assert.equal(e!.status, 400);
  assert.match(e!.message, /is not one the governed query path can serve/);
  assert.match(e!.message, /`day`, `week`, `month`, `quarter`, `year`/);
  assert.ok(e!.message.length < 400, 'the refusal must not splice an unbounded payload into a log line');
  // One assertion covers both gates, so a new door cannot remember one and forget the other.
  assert.throws(() => assertServableFilters(panel), /not one the governed query path can serve/);
});

test('H-1 — an absent or empty grain is fine (a panel need not trend over time)', () => {
  for (const g of [undefined, null, '']) {
    assert.equal(unservableTimeGrainError({ name: 'p', vizType: 'bar', metrics: ['Orders.revenue'], timeGrain: g as never }), null, String(g));
  }
});
