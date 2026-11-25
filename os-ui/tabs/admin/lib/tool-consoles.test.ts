/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Route test — Platform → Tool consoles: the per-tool switch is admin-only, off by
 *             default, durable in the settings store, and every change is audited
 * USER STORY: As a platform admin I switch the Dagster console on for a demo; a non-admin cannot,
 *             the generic settings PATCH cannot smuggle the switch past the audit, a console that
 *             cannot be served here refuses to switch on, and the audit row names who switched
 *             which tool on or off in which environment.
 * ARCHITECTURE: the real tool-consoles route over the real settings store and the real proxy
 *             registry. `adminCtx` is a stand-in that refuses a non-admin with 403 exactly as
 *             `requireAdmin` does; `audit` records (and can be made to fail).
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.DAGSTER_READONLY_URL = 'http://agentic-os-dagster-webserver-read-only:80';
process.env.OS_PUBLIC_URL = 'https://dev.os.example.test';

let ROLE = 'admin';
type Row = { action: string; detail: string; actor: string; target: string; data?: Record<string, unknown> };
const AUDIT: Row[] = [];
let AUDIT_FAILS = false;
mock.module('@/app/api/platform-admin/_ctx', {
  namedExports: {
    adminCtx: async () => {
      if (ROLE !== 'admin') { const e = new Error('Admin only'); (e as Error & { status?: number }).status = 403; throw e; }
      return { user: { id: 'ada', role: 'admin', domains: [] }, tenant: { id: 't' }, opa: 'opa-allow' };
    },
    fail: (e: unknown) => new Response(JSON.stringify({ error: (e as Error).message }), { status: (e as { status?: number })?.status ?? 500, headers: { 'content-type': 'application/json' } }),
  },
});
let OPA_ALLOWS = true;
mock.module('@core/infra/governed', {
  namedExports: { authorize: async () => ({ allowed: OPA_ALLOWS, policy: OPA_ALLOWS ? 'opa-allow' : 'opa-deny' }) },
});
// 'sync' throws at once; 'async' rejects later, like a durable write the store never confirms.
let AUDIT_ASYNC_FAILS = false;
mock.module('@tabs/admin/lib/audit', {
  namedExports: {
    audit: (e: Row) => { if (AUDIT_FAILS) throw new Error('audit store down'); AUDIT.push(e); return e; },
    auditConfirmed: async (e: Row) => {
      if (AUDIT_FAILS) throw new Error('audit store down');
      await new Promise((r) => setTimeout(r, 5));
      if (AUDIT_ASYNC_FAILS) throw new Error('the audit row was not stored: HTTP 503');
      AUDIT.push(e);
      return e;
    },
  },
});

const { GET, PATCH } = await import('@/app/api/platform-admin/tool-consoles/route');
const settings = await import('@tabs/admin/lib/settings');
const { PATCH: SETTINGS_PATCH } = await import('@/app/api/platform-admin/settings/route');

// No upstream is reachable from a unit test: the probe answers from a table instead.
const realFetch = globalThis.fetch;
let REACHABLE = new Set<string>();
// The settings store (OpenSearch index `os-settings`): answers 200, or 503 while "down".
let SETTINGS_STORE_DOWN = false;
const SETTINGS_PUTS: string[] = [];
globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
  const url = String(u);
  if (url.includes('/os-settings')) {
    if (init?.method === 'PUT') SETTINGS_PUTS.push(String(init.body ?? ''));
    if (SETTINGS_STORE_DOWN && init?.method === 'PUT') return new Response('{}', { status: 503 });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if ([...REACHABLE].some((p) => url.startsWith(p))) return new Response('ok', { status: 200 });
  throw new TypeError('fetch failed');
}) as typeof fetch;
process.on('exit', () => { globalThis.fetch = realFetch; });

beforeEach(() => {
  settings._reset();
  ROLE = 'admin';
  AUDIT.length = 0;
  AUDIT_FAILS = false;
  AUDIT_ASYNC_FAILS = false;
  SETTINGS_STORE_DOWN = false;
  SETTINGS_PUTS.length = 0;
  OPA_ALLOWS = true;
  REACHABLE = new Set(['http://agentic-os-litellm:4000', 'http://agentic-os-dagster-webserver-read-only:80']);
});

type ConsoleRow = { key: string; exposed: boolean; status: string; address: string; shortAddress: string | null; warning: string };
const list = async () => ((await (await GET()).json()) as { consoles: ConsoleRow[] }).consoles;
const patch = (body: unknown) => PATCH(new Request('http://x/api/platform-admin/tool-consoles', { method: 'PATCH', body: JSON.stringify(body) }));

test('every registry tool is listed, OFF by default, with its address and a warning', async () => {
  const rows = await list();
  const keys = rows.map((r) => r.key);
  for (const k of ['litellm', 'dagster', 'langfuse', 'opensearch']) assert.ok(keys.includes(k), `${k} listed`);
  for (const r of rows) {
    assert.equal(r.exposed, false, `${r.key} off by default`);
    // LiteLLM's root is its Swagger page (blank behind the prefix): its console opens at /ui/.
    assert.equal(r.address, r.key === 'litellm' ? '/tools/litellm/ui/' : `/tools/${r.key}/`);
    assert.ok(r.warning.length > 20, `${r.key} says what it shows`);
  }
  assert.match(rows.find((r) => r.key === 'langfuse')!.warning, /prompts and answers/);
  assert.equal(rows.find((r) => r.key === 'dagster')!.shortAddress, '/dagster');
});

test('status: available when reachable, "not set up" when not, pending when not servable here', async () => {
  REACHABLE = new Set(['http://agentic-os-litellm:4000']);
  const rows = await list();
  const by = Object.fromEntries(rows.map((r) => [r.key, r.status]));
  assert.equal(by.litellm, 'available');
  assert.equal(by.dagster, 'not-set-up', 'no answer from the read-only webserver');
  assert.equal(by.langfuse, 'pending');
  assert.equal(by.opensearch, 'pending');
});

test('an admin switches Dagster on: stored, listed, and audited with actor, tool, on and environment', async () => {
  const res = await patch({ key: 'dagster', exposed: true });
  assert.equal(res.status, 200);
  assert.equal(settings.toolConsoleExposed('dagster'), true);
  assert.equal((await list()).find((r) => r.key === 'dagster')!.exposed, true);
  assert.equal(AUDIT.length, 1);
  const row = AUDIT[0];
  assert.equal(row.action, 'tool-console.expose');
  assert.equal(row.actor, 'ada');
  assert.equal(row.target, 'tool:dagster');
  assert.match(row.detail, /Dagster console ON/);
  assert.match(row.detail, /dev\.os\.example\.test/);
  assert.deepEqual(row.data, { tool: 'dagster', exposed: true, environment: 'dev.os.example.test' });
});

test('switching it off is audited too', async () => {
  await patch({ key: 'dagster', exposed: true });
  AUDIT.length = 0;
  await patch({ key: 'dagster', exposed: false });
  assert.equal(settings.toolConsoleExposed('dagster'), false);
  assert.equal(AUDIT.length, 1);
  assert.match(AUDIT[0].detail, /OFF/);
  assert.equal(AUDIT[0].data?.exposed, false);
});

test('a non-admin cannot switch a console: 403 on GET and PATCH, nothing stored, nothing audited', async () => {
  ROLE = 'builder';
  assert.equal((await GET()).status, 403);
  assert.equal((await patch({ key: 'litellm', exposed: true })).status, 403);
  assert.equal(settings.toolConsoleExposed('litellm'), false);
  assert.equal(AUDIT.length, 0);
});

test('the governance decision (OPA) refuses the admin: 403, nothing stored, nothing audited', async () => {
  OPA_ALLOWS = false;
  assert.equal((await patch({ key: 'dagster', exposed: true })).status, 403);
  assert.equal(settings.toolConsoleExposed('dagster'), false);
  assert.equal(AUDIT.length, 0);
});

test('an unknown tool is 404; a non-boolean is 400; a pending console refuses to switch on (409)', async () => {
  assert.equal((await patch({ key: 'trino', exposed: true })).status, 404);
  assert.equal((await patch({ key: '__proto__', exposed: true })).status, 404);
  assert.equal((await patch({ key: 'dagster', exposed: 'yes' })).status, 400);
  assert.equal((await patch({ key: 'langfuse', exposed: true })).status, 409);
  assert.equal(settings.toolConsoleExposed('langfuse'), false);
  assert.equal(AUDIT.length, 0);
  // Switching a pending console OFF is always allowed (it cleans up an old value).
  assert.equal((await patch({ key: 'langfuse', exposed: false })).status, 200);
});

test('when the audit row cannot be written the switch is put back: no change without its trail', async () => {
  AUDIT_FAILS = true;
  const res = await patch({ key: 'dagster', exposed: true });
  assert.equal(res.status, 500);
  assert.equal(settings.toolConsoleExposed('dagster'), false);
});

test('the durable audit write fails LATER (async): the switch is undone in memory and in the store, and the caller gets an error', async () => {
  AUDIT_ASYNC_FAILS = true;
  const res = await patch({ key: 'dagster', exposed: true });
  assert.equal(res.status, 500);
  assert.match(((await res.json()) as { error: string }).error, /audit trail could not be written/);
  assert.equal(settings.toolConsoleExposed('dagster'), false);
  assert.equal(AUDIT.length, 0);
  // The store saw the switch ON, then OFF again — the last write is the undo.
  assert.ok(SETTINGS_PUTS.length >= 2, 'the switch and its undo both reached the store');
  const last = JSON.parse(SETTINGS_PUTS.at(-1) ?? '{}') as { settings?: { toolConsoles?: Record<string, { exposed: boolean }> } };
  assert.notEqual(last.settings?.toolConsoles?.dagster?.exposed, true);
});

test('the settings store does not confirm the write: 503, the switch stays OFF, nothing is audited', async () => {
  SETTINGS_STORE_DOWN = true;
  const res = await patch({ key: 'dagster', exposed: true });
  assert.equal(res.status, 503);
  assert.equal(settings.toolConsoleExposed('dagster'), false);
  assert.equal(AUDIT.length, 0);
});

test('a confirmed change is in the store before the API answers', async () => {
  const res = await patch({ key: 'litellm', exposed: true });
  assert.equal(res.status, 200);
  const last = JSON.parse(SETTINGS_PUTS.at(-1) ?? '{}') as { settings?: { toolConsoles?: Record<string, { exposed: boolean }> } };
  assert.equal(last.settings?.toolConsoles?.litellm?.exposed, true);
});

test('the generic settings PATCH cannot set the switch past the audit', async () => {
  const res = await SETTINGS_PATCH(new Request('http://x/api/platform-admin/settings', { method: 'PATCH', body: JSON.stringify({ toolConsoles: { dagster: { exposed: true } } }) }));
  assert.equal(res.status, 400);
  assert.equal(settings.toolConsoleExposed('dagster'), false);
});

test('a stored doc is merged nil-safe: garbage and unknown shapes stay OFF', () => {
  settings.__setForTests({ toolConsoles: { dagster: { exposed: 'true' }, litellm: { exposed: true }, 'Bad Key': { exposed: true } } as never });
  assert.equal(settings.toolConsoleExposed('dagster'), false);
  assert.equal(settings.toolConsoleExposed('litellm'), true);
  assert.equal(settings.toolConsoleExposed('Bad Key'), false);
  assert.equal(settings.toolConsoleExposed('constructor'), false, 'prototype names are never "on"');
});
