/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Workday RaaS (operational-system-connections.md, Phase 5) — field inference labeling +
 * full-refresh honesty, over a MOCKED tenant (no real network, no secrets). Verifies:
 *   • fields are inferred from a sample and LABELED "inferred from a sample",
 *   • append against a report WITHOUT a configured date prompt fails honestly,
 *   • a full-refresh streams `replace` + stamps lineage,
 *   • an incremental report windows on its configured date prompt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inferFields,
  extractReportRows,
  reportUrl,
  runWorkdaySlice,
  type WdConn,
} from './workday-raas.ts';

test('inferFields: labels every scalar "inferred from a sample"; nested skipped', () => {
  const fields = inferFields([{ Employee_ID: '21001', Name: 'Ada', Salary: 95000, Active: true, Address: { City: 'X' } }]);
  assert.deepEqual(fields.map((f) => f.name).sort(), ['Active', 'Employee_ID', 'Name', 'Salary']);
  assert.ok(fields.every((f) => f.label.endsWith('(inferred from a sample)')));
  assert.equal(fields.find((f) => f.name === 'Salary')!.type, 'number');
  assert.equal(fields.find((f) => f.name === 'Active')!.type, 'boolean');
});

test('extractReportRows: Report_Entry array (RaaS format=json)', () => {
  assert.deepEqual(extractReportRows({ Report_Entry: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(extractReportRows([{ b: 2 }]), [{ b: 2 }]);
  assert.deepEqual(extractReportRows({ nope: 'x' }), []);
});

test('reportUrl: forces format=json and windows on the configured date prompt', () => {
  const conn: WdConn = { baseUrl: 'https://wd.example.com/ccx/service/customreport2/t', reports: [], fetchImpl: (async () => new Response()) as never };
  const noWindow = reportUrl(conn, { key: 'hc', path: 'Headcount' });
  assert.ok(noWindow.includes('format=json'));
  const windowed = reportUrl(conn, { key: 'hc', path: 'Headcount', incrementalParam: 'Effective_From' }, { from: '2026-08-01' });
  assert.ok(windowed.includes('Effective_From=2026-08-01'));
});

function baseArgs(overrides: Partial<Parameters<typeof runWorkdaySlice>[0]>): Parameters<typeof runWorkdaySlice>[0] {
  return {
    connectionId: 'conn_w',
    owner: { id: 'u1', domains: ['hr'], role: 'builder' } as never,
    report: 'headcount',
    mode: 'full-refresh',
    watermark: null,
    datasetSlug: 'hc',
    target: { schema: 'hr', table: 'bronze_hc' } as never,
    identity: { principal: 'hr', uid: 'u1', domains: ['hr'], role: 'builder' } as never,
    execute: async () => ({ rowsAffected: 0 }),
    mkBatchId: (hw) => `hc.${hw}`,
    startedAt: '2026-08-05T00:00:00.000Z',
    ingestUrl: 'http://data-runner:8000',
    ...overrides,
  };
}

test('Workday append on a promptless report fails honestly (full-refresh only)', async () => {
  const conn: WdConn = {
    baseUrl: 'https://wd.example.com/svc/t',
    user: 'isu', pass: 'p',
    reports: [{ key: 'headcount', path: 'Headcount' }], // no incrementalParam
    fetchImpl: (async () => new Response('{}', { status: 200 })) as never,
  };
  await assert.rejects(
    runWorkdaySlice(baseArgs({ mode: 'append', watermark: '2026-08-01T00:00:00Z', resolve: async () => conn })),
    /no configured date prompt — incremental sync is not supported/,
  );
});

test('Workday full-refresh streams replace + stamps lineage', async () => {
  const ingested: { mode: string; rows: Record<string, unknown>[] }[] = [];
  const fetchImpl: WdConn['fetchImpl'] = (async (url: string, init?: RequestInit) => {
    if (url.includes('/ingest-rows')) {
      ingested.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ Report_Entry: [{ Employee_ID: '1', Name: 'Ada', Team: { id: 'x' } }] }), { status: 200 });
  }) as never;
  const conn: WdConn = { baseUrl: 'https://wd.example.com/svc/t', user: 'isu', pass: 'p', reports: [{ key: 'headcount', path: 'Headcount' }], fetchImpl };
  const out = await runWorkdaySlice(baseArgs({ resolve: async () => conn, fetchImpl }));
  assert.equal(out.rowsAffected, 1);
  assert.equal(out.highWatermark, null); // full refresh has no cursor
  assert.equal(ingested[0].mode, 'replace');
  // Nested Team object skipped; lineage stamped.
  assert.equal(ingested[0].rows[0].Team, undefined);
  assert.equal(ingested[0].rows[0]._batch_id, out.batchId);
});

test('Workday incremental windows on the date prompt when configured', async () => {
  const urls: string[] = [];
  const fetchImpl: WdConn['fetchImpl'] = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    if (url.includes('/ingest-rows')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(JSON.stringify({ Report_Entry: [{ Employee_ID: '1' }] }), { status: 200 });
  }) as never;
  const conn: WdConn = {
    baseUrl: 'https://wd.example.com/svc/t', user: 'isu', pass: 'p',
    reports: [{ key: 'headcount', path: 'Headcount', incrementalParam: 'Effective_From' }],
    fetchImpl,
  };
  const out = await runWorkdaySlice(baseArgs({
    mode: 'append', watermark: '2026-08-01T00:00:00Z', resolve: async () => conn, fetchImpl,
    execute: async () => ({ rowsAffected: 0 }),
  }));
  assert.equal(out.rowsAffected, 1);
  assert.equal(out.highWatermark, '2026-08-05T00:00:00.000Z'); // run-start is the hw (no cheap probe)
  const reportFetch = urls.find((u) => u.includes('Effective_From='));
  assert.ok(reportFetch, 'the report fetch should window on the configured date prompt');
  assert.ok(reportFetch!.includes('Effective_From=2026-08-01'));
});
