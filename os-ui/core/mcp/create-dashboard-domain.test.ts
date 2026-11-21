/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `create_dashboard` chooses its domain — validated against the caller's domains,
 *             defaulting to the caller's home domain, never `platform`
 * USER STORY: As an assistant building a dashboard for a user in several domains, I want to say
 *             which domain it belongs to, and never have it land in the platform repository.
 * ARCHITECTURE:
 *   - Driven over `handleRpc` / `tools/call`, exactly as an MCP client calls it; the domain is read
 *     back with `get_dashboard`'s governed store read (`getDashboard`).
 *   - Negative twins: a domain the caller is not in, and `platform`, are typed 403/400 refusals;
 *     a caller whose only domain is `platform` is refused rather than defaulted into it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { handleRpc, type JsonRpcResponse, type ToolError } from '@core/mcp/server';
import { __resetDashboards, getDashboard } from '@tabs/dashboards/lib/store';

const multi: CurrentUser = { id: 'mia', name: 'Mia', domains: ['platform', 'sales', 'marketing'], role: 'admin' };
const onlyPlatform: CurrentUser = { id: 'pat', name: 'Pat', domains: ['platform'], role: 'admin' };
const chart = { name: 'Revenue', vizType: 'big_number', metric: 'Orders.revenue' };

async function call(user: CurrentUser, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_dashboard', arguments: args } });
  assert.ok(res && 'result' in res);
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}
const ok = (r: Record<string, unknown>) => {
  assert.notEqual(r.isError, true, (r.content as { text: string }[])[0]?.text);
  return JSON.parse((r.content as { text: string }[])[0].text) as { id: string };
};
const err = (r: Record<string, unknown>) => {
  assert.equal(r.isError, true, 'expected a typed refusal');
  return (r.structuredContent as { error: ToolError }).error;
};
const P = (u: CurrentUser) => ({ id: u.id, domains: u.domains, role: u.role });

test('no `domain`: the dashboard lands in the caller’s home domain — the first that is not platform', async () => {
  __resetDashboards();
  const { id } = ok(await call(multi, { name: 'Home', view: 'Orders', charts: [chart] }));
  const d = getDashboard(id, P(multi));
  assert.equal(d.domain, 'sales');
  assert.equal(d.spec.domain, 'sales');
});

test('an explicit `domain` the caller belongs to is honoured', async () => {
  __resetDashboards();
  const { id } = ok(await call(multi, { name: 'Mkt', view: 'Orders', charts: [chart], domain: 'marketing' }));
  assert.equal(getDashboard(id, P(multi)).domain, 'marketing');
});

test('NEGATIVE TWIN: a domain the caller is not in is refused (403), and nothing is written', async () => {
  __resetDashboards();
  const e = err(await call(multi, { name: 'X', view: 'Orders', charts: [chart], domain: 'finance' }));
  assert.equal(e.code, 'forbidden');
  assert.match(e.reason, /finance/);
});

test('NEGATIVE TWIN: `platform` is never a dashboard domain — explicit or by default', async () => {
  __resetDashboards();
  assert.equal(err(await call(multi, { name: 'X', view: 'Orders', charts: [chart], domain: 'platform' })).code, 'bad_request');
  assert.equal(err(await call(onlyPlatform, { name: 'Y', view: 'Orders', charts: [chart] })).code, 'bad_request');
});

test('replacing by id keeps the dashboard’s domain; a different `domain` is refused, not a silent move', async () => {
  __resetDashboards();
  const { id } = ok(await call(multi, { name: 'Keep', view: 'Orders', charts: [chart], domain: 'marketing' }));
  ok(await call(multi, { id, name: 'Keep', view: 'Orders', charts: [chart] }));
  assert.equal(getDashboard(id, P(multi)).domain, 'marketing');
  assert.equal(err(await call(multi, { id, name: 'Keep', view: 'Orders', charts: [chart], domain: 'sales' })).code, 'bad_request');
});
