/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       connections
 * FEATURE:    i18n wave 4 — the Connections routes' and store's person-facing refusals carry a code
 * USER STORY: As a user who picked Polish I want "Only the owner can connect this account" or "External-warehouse
 *             connectors are not enabled on this deployment" in Polish, while API and MCP clients keep the English.
 *             Proof: every (English, code, params) the connection routes and stores emit renders back to exactly
 *             that English from `server.<code>` and exists in all seven catalogs.
 * ARCHITECTURE: scans the coded literal calls in the listed sources (no import of route modules), renders each
 *             code with `assertServerEnglish` (core/testing/server-message.ts); dynamic messages are table-tested.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codedError, errorBody, errorBodyOf } from '@core/kernel/server-message';
import { assertServerEnglish } from '@core/testing/server-message';

const ROOT = process.cwd();

/** Every literal-English coded call in a source file (apiError / codedError with a quoted string). */
function literalTriples(rel: string): { english: string; code: string }[] {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const lit = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
  const code = String.raw`'([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9.]+)'`;
  const out: { english: string; code: string }[] = [];
  for (const re of [new RegExp(String.raw`apiError\(\d+, ${lit}, ${code}\)`, 'g'), new RegExp(String.raw`codedError\([^,]+, ${lit}, ${code}\)`, 'g')]) {
    for (const m of src.matchAll(re)) out.push({ english: m[1].slice(1, -1).replace(/\\(.)/g, '$1'), code: m[2] });
  }
  return out;
}

const SOURCES = [
  'tabs/connections/lib/store.ts',
  'tabs/connections/lib/exposures.ts',
  'tabs/connections/lib/action-adoptions.ts',
  'app/api/connections/route.ts',
  'app/api/connections/catalog-refresh/route.ts',
  'app/api/connections/connect/route.ts',
  'app/api/connections/notion/authorize/route.ts',
  'app/api/connections/oauth/[provider]/authorize/route.ts',
  'app/api/connections/[id]/route.ts',
  'app/api/connections/[id]/classification/route.ts',
  'app/api/connections/[id]/capabilities/route.ts',
  'app/api/connections/[id]/expose-assistant/route.ts',
  'app/api/connections/[id]/folder/route.ts',
  'app/api/connections/[id]/count/route.ts',
  'app/api/connections/[id]/describe/route.ts',
  'app/api/connections/[id]/import/route.ts',
  'app/api/connections/[id]/action-adoptions/route.ts',
  'app/api/connections/[id]/versions/route.ts',
  'app/api/connections/[id]/approve/route.ts',
  'app/api/connections/[id]/remember/route.ts',
  'app/api/connections/[id]/tool/route.ts',
  'app/api/connections/[id]/autonomous/route.ts',
  'app/api/connections/[id]/account/route.ts',
  'app/api/connections/[id]/grant/route.ts',
];

test('every literal coded message in the connection routes and stores renders its English in all locales', () => {
  let n = 0;
  for (const rel of SOURCES) {
    const triples = literalTriples(rel);
    assert.ok(triples.length > 0, `${rel}: expected coded messages`);
    for (const { english, code } of triples) {
      assertServerEnglish(errorBody(english, code));
      n += 1;
    }
  }
  assert.ok(n >= 90, `scanned ${n} coded messages`);
});

test('dynamic connection refusals keep their English', () => {
  const table: [string, string, Record<string, string | number>][] = [
    ['Endpoint host "api.example.com" is not on the egress allowlist — request access and an Administrator must approve it first', 'connections.hostNotAllowlisted', { host: 'api.example.com' }],
    ['Enabling the Blocked tool "delete_repo" requires an Administrator override', 'connections.blockedToolNeedsAdmin', { tool: 'delete_repo' }],
    ['Databricks does not support import-as-product', 'connections.importUnsupported', { provider: 'Databricks' }],
    ['Connect your Google Drive first — there is no valid sign-in for this connection yet, so nothing can be read.', 'connections.connectFirst', { provider: 'Google Drive' }],
    ['The Microsoft sign-in app is not set up yet: an admin sets it up under Connections → Sign-in apps (Google & Microsoft)', 'connections.signInAppMissing', { vendor: 'Microsoft' }],
  ];
  for (const [english, code, params] of table) assertServerEnglish(errorBody(english, code, params));
});

test('a route catch forwards the coded store error; a driver error stays plain', () => {
  const e = codedError(403, 'Only the connection owner can test this connection', 'connections.onlyOwnerTests');
  assert.deepEqual(errorBodyOf(e), { error: 'Only the connection owner can test this connection', code: 'connections.onlyOwnerTests' });
  assert.deepEqual(errorBodyOf(Object.assign(new Error('ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' })), { error: 'ECONNREFUSED 10.0.0.1:443' });
});
