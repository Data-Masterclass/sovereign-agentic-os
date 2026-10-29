/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * M2 — the half-wired templates must actually be configurable end-to-end.
 * createConnection accepts + stamps the non-secret config blocks so:
 *   • workday-raas gets its report catalog (each report is an entity — no reports = no data)
 *   • atlassian gets its account email (Basic auth cannot authenticate without it)
 *   • sap-odata / odata-v4 get the OAuth-CC token URL
 *   • airflow gets auth kind + Basic username + trigger allowlist
 * These are the exact objects the POST route and MCP create_connection forward.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const { createConnection, getConnectionForUser, __resetConnections, sanitizeWorkdayReports, enableDataUsage } = await import('./store.ts');

const user = { id: 'u1', name: 'U1', domains: ['sales'], role: 'admin' as const };

test('M8 data-usage: offline-mock registration is labelled honestly on the record', async () => {
  __resetConnections();
  // A database connection has no injected live sync client here → the sync runs offline-mock
  // with a FABRICATED row count. The record must carry dataUsageMode:'offline-mock' so the
  // UI never presents that fabricated count as a real ingest.
  const c = await createConnection(user, { name: 'PG', template: 'database', endpoint: '', credential: 'pw' });
  await enableDataUsage(c.id, user, 'bronze');
  const got = await getConnectionForUser(c.id, user);
  assert.equal(got.dataUsage, 'bronze');
  assert.equal(got.dataUsageMode, 'offline-mock', 'mock registration labelled, not presented as live');
});

test('M2 workday-raas: report catalog round-trips (each report is an entity)', async () => {
  __resetConnections();
  const c = await createConnection(user, {
    name: 'WD', template: 'workday-raas', endpoint: 'https://wd.example.com/ccx/service/customreport2/t', credential: 'isu:pw',
    workday: { reports: [
      { path: '/Headcount?format=json', label: 'Headcount' },
      { key: 'Turnover', path: '/Turnover' },
    ] },
  });
  const got = await getConnectionForUser(c.id, user);
  assert.equal(got.workday?.reports.length, 2, 'both reports registered');
  assert.equal(got.workday?.reports[1].key, 'turnover', 'explicit key slugified/lowercased');
});

test('M2 atlassian: Basic auth email is stamped', async () => {
  __resetConnections();
  const c = await createConnection(user, {
    name: 'Jira', template: 'atlassian', endpoint: 'https://x.atlassian.net', credential: 'token',
    atlassian: { authKind: 'basic', email: 'me@example.com' },
  });
  const got = await getConnectionForUser(c.id, user);
  assert.equal(got.atlassian?.authKind, 'basic');
  assert.equal(got.atlassian?.email, 'me@example.com');
});

test('M2 odata: OAuth-CC token URL is stamped', async () => {
  __resetConnections();
  const c = await createConnection(user, {
    name: 'S4', template: 'sap-odata', endpoint: 'https://s4.example.com/odata', credential: 'id:secret',
    odata: { authType: 'oauth-cc', tokenUrl: 'https://s4.example.com/oauth/token' },
  });
  const got = await getConnectionForUser(c.id, user);
  assert.equal(got.odata?.authType, 'oauth-cc');
  assert.equal(got.odata?.tokenUrl, 'https://s4.example.com/oauth/token');
});

test('M2 airflow: auth kind + Basic username + trigger allowlist stamped', async () => {
  __resetConnections();
  const c = await createConnection(user, {
    name: 'AF', template: 'airflow', endpoint: 'https://airflow.example.com', credential: 'pw',
    airflow: { authType: 'basic', username: 'svc', dagAllowlist: ['etl_daily', ' '] },
  });
  const got = await getConnectionForUser(c.id, user);
  assert.equal(got.airflow?.authType, 'basic');
  assert.equal(got.airflow?.username, 'svc');
  assert.deepEqual(got.airflow?.dagAllowlist, ['etl_daily'], 'blank allowlist entries dropped');
});

test('M2 sanitizeWorkdayReports: dedupes by key + requires a path', () => {
  const out = sanitizeWorkdayReports([
    { path: '' },                         // dropped (no path)
    { key: 'A', path: '/one' },
    { key: 'A', path: '/two' },           // dropped (dupe key)
    { path: '/three/four' },              // key from last path segment
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].key, 'a');
  assert.equal(out[1].key, 'four');
});

globalThis.fetch = _realFetch;
