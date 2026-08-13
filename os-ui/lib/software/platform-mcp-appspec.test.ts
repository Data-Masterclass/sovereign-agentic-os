/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * platform-mcp-appspec.test — the GOVERNED authoring tools for declarative apps (AppSpec Phase 4a):
 * `set_app_spec` + `get_app_spec` over the Platform MCP front door. Mirrors set-app-spec.test's
 * seeding (a Gold dataset promoted to Domain, granted to a real app) and platform-mcp.test's
 * governance assertions. Covers:
 *   • set_app_spec with an INVALID spec → { ok:false, issues } and NOTHING persisted;
 *   • set_app_spec with a VALID spec (granted dataset + real columns) → { ok:true, servedUrl },
 *     serveMode flips to 'spec';
 *   • get_app_spec round-trips the spec + returns the describeApp legibility summary;
 *   • both enforce visibility/authorization (an unseeable app → not_found for a stranger);
 *   • a `kind:'spec'` app is created with NO image pipeline (no repo / stages disabled).
 *
 * Runs OFFLINE (fetch rejected) so the data + apps stores run in-process, exactly like
 * set-app-spec.test — the same isolation the store-backed suites rely on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Offline: fail every OpenSearch/Forgejo fetch so the stores run in-process.
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { __resetStore, createDataset, buildVersion, setDocs, transition } = await import('../data/store.ts');
const { __resetAppsCache, createApp, getAppByIdInternal, serveModeOf } = await import('./apps.ts');
const { callPlatformMcp, PLATFORM_MCP_TOOLS } = await import('./platform-mcp.ts');
import type { Principal } from '../data/store.ts';
import type { CurrentUser } from '../core/auth.ts';
import type { App } from './apps.ts';
import type { SpecIssue } from './appspec/schema.ts';
import type { AppDescription } from './appspec/describe.ts';

const amir: CurrentUser = {
  id: 'amir', name: 'Amir', domains: ['sales'], allDomains: ['sales'], activeDomain: 'sales', role: 'builder',
};
const amirP: Principal = { id: 'amir', domains: ['sales'], role: 'builder' };
// A stranger in another domain — cannot SEE a Personal app in sales.
const stranger: CurrentUser = {
  id: 'zoe', name: 'Zoe', domains: ['ops'], allDomains: ['ops'], activeDomain: 'ops', role: 'builder',
};

/** Gold "Orders" dataset with documented columns, promoted to Domain (no Personal warning). */
function seedOrders(): string {
  const d = createDataset(amirP, { name: 'Orders' });
  buildVersion(d.id, amirP, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });
  buildVersion(d.id, amirP, 'silver', { quality: 'passing', artifact: 'silver/stg_orders.sql' });
  buildVersion(d.id, amirP, 'gold', { quality: 'passing', artifact: 'gold/orders.sql' });
  setDocs(d.id, amirP, { columns: [{ name: 'order_id', description: 'PK' }, { name: 'net_amount', description: 'Money' }] });
  transition(d.id, amirP, 'promote');
  return d.id;
}

function specWithColumns(datasetId: string, cols: string[]) {
  return {
    version: 2,
    name: 'Orders App',
    description: 'A declarative orders app.',
    tabs: [
      {
        id: 't1',
        label: 'Orders',
        body: { kind: 'pattern', pattern: 'records-table', config: { source: { datasetId }, columns: cols.map((c) => ({ field: c })) } },
      },
    ],
  };
}

/** Create a spec app + grant it the seeded dataset — the shared arrange for the write tests. */
async function specAppWithGrant(): Promise<{ appId: string; dsId: string; slug: string }> {
  const dsId = seedOrders();
  const app = (await callPlatformMcp(amir, 'create_software', { name: 'Orders App', domain: 'sales', kind: 'spec' })) as App;
  await callPlatformMcp(amir, 'design_software', { appId: app.id, grants: { data: [{ id: dsId, access: 'read-only' }] } });
  return { appId: app.id, dsId, slug: app.slug };
}

async function expectStatus(p: Promise<unknown>, status: number) {
  await assert.rejects(p, (e: Error & { status?: number }) => {
    assert.equal(e.status, status);
    return true;
  });
}

test('set_app_spec: an INVALID spec returns typed issues and PERSISTS NOTHING', async () => {
  __resetStore();
  __resetAppsCache();
  const { appId, dsId } = await specAppWithGrant();

  const res = (await callPlatformMcp(amir, 'set_app_spec', {
    appId,
    spec: specWithColumns(dsId, ['order_id', 'not_a_column']),
  })) as { ok: boolean; issues: SpecIssue[] };

  assert.equal(res.ok, false, 'a blocking issue means ok:false');
  assert.ok(res.issues.some((i) => /not_a_column/.test(i.reason)), 'the issue names the bad column');
  assert.ok(res.issues.every((i) => typeof i.path === 'string' && typeof i.fix === 'string'), 'issues are typed { path, reason, fix }');

  const reloaded = await getAppByIdInternal(appId);
  assert.equal(reloaded!.spec, undefined, 'spec is NOT persisted on a blocking issue');
});

test('set_app_spec: a VALID spec persists, flips serveMode to spec, and returns the servedUrl', async () => {
  __resetStore();
  __resetAppsCache();
  const { appId, dsId, slug } = await specAppWithGrant();

  const res = (await callPlatformMcp(amir, 'set_app_spec', {
    appId,
    spec: specWithColumns(dsId, ['order_id', 'net_amount']),
  })) as { ok: boolean; servedUrl: string; warnings: unknown[] };

  assert.equal(res.ok, true, 'a granted dataset + real columns validates clean');
  assert.equal(res.servedUrl, `/apps/${slug}`, 'servedUrl points at the same-origin route');

  const reloaded = await getAppByIdInternal(appId);
  assert.ok(reloaded!.spec, 'spec is persisted (the spec IS the app)');
  assert.equal(serveModeOf(reloaded!), 'spec', 'serveMode flipped to spec');
});

test('get_app_spec: round-trips the spec + returns the describeApp legibility summary', async () => {
  __resetStore();
  __resetAppsCache();
  const { appId, dsId: dsIdRT } = await specAppWithGrant();

  // Before a spec: null spec, but serveMode is already 'spec' (created with kind:'spec').
  const before = (await callPlatformMcp(amir, 'get_app_spec', { appId })) as { spec: unknown; serveMode: string; describe: unknown };
  assert.equal(before.spec, null, 'no spec yet → null');
  assert.equal(before.serveMode, 'spec');
  assert.equal(before.describe, null, 'no describe without a spec');

  await callPlatformMcp(amir, 'set_app_spec', { appId, spec: specWithColumns(dsIdRT, ['order_id', 'net_amount']) });

  const after = (await callPlatformMcp(amir, 'get_app_spec', { appId })) as {
    spec: { tabs: unknown[] } | null;
    serveMode: string;
    describe: AppDescription | null;
  };
  assert.ok(after.spec, 'the spec round-trips');
  assert.equal(after.spec!.tabs.length, 1);
  assert.equal(after.serveMode, 'spec');
  assert.ok(after.describe, 'a describe summary is returned');
  assert.equal(after.describe!.name, 'Orders App');
  assert.equal(after.describe!.tabs.length, 1);
  assert.equal(after.describe!.tabs[0].kind, 'view', 'records-table is a view tab');
  assert.equal(after.describe!.tabs[0].data, dsIdRT, 'the tab reports its dataset source');
});

test('AUTHORIZATION: a stranger cannot get_app_spec or set_app_spec an app they cannot see (not_found)', async () => {
  __resetStore();
  __resetAppsCache();
  const { appId, dsId } = await specAppWithGrant();
  await callPlatformMcp(amir, 'set_app_spec', { appId, spec: specWithColumns(dsId, ['order_id', 'net_amount']) });

  // The app is Personal to amir in `sales` — a builder in `ops` is denied both doors.
  // get_app_spec applies the visibility gate first → not_found (no existence leak);
  // set_app_spec's own owner/domain-builder gate denies the write → forbidden.
  await expectStatus(callPlatformMcp(stranger, 'get_app_spec', { appId }), 404);
  await expectStatus(callPlatformMcp(stranger, 'set_app_spec', { appId, spec: specWithColumns(dsId, ['order_id']) }), 403);
});

test('generate_app_spec: with NO designed epics returns a calm { ok:false, error } (no LLM, nothing persisted)', async () => {
  __resetStore();
  __resetAppsCache();
  const { appId } = await specAppWithGrant(); // granted a dataset, but no epics designed yet

  const res = (await callPlatformMcp(amir, 'generate_app_spec', { appId })) as { ok: boolean; error: string };
  assert.equal(res.ok, false, 'no epics ⇒ nothing to build from');
  assert.match(res.error, /Design at least one epic/i, 'it tells the author to design first');

  const reloaded = await getAppByIdInternal(appId);
  assert.equal(reloaded!.spec, undefined, 'generate never persists a spec');
});

test('generate_app_spec: a stranger who cannot see the app is denied (not_found)', async () => {
  __resetStore();
  __resetAppsCache();
  const { appId } = await specAppWithGrant();
  await expectStatus(callPlatformMcp(stranger, 'generate_app_spec', { appId }), 404);
});

test('generate_app_spec is advertised as a governed declarative tool (creator floor, not elevated)', () => {
  const tool = PLATFORM_MCP_TOOLS.find((t) => t.name === 'generate_app_spec');
  assert.ok(tool, 'generate_app_spec is in the Platform MCP surface');
  assert.match(tool!.description, /SCAFFOLD A DECLARATIVE APP/i, 'it is framed as the declarative scaffold');
  assert.equal(tool!.write, false, 'it persists nothing — set_app_spec publishes');
});

test('SPEC APP: create_software kind:spec skips the image pipeline (no repo, stages disabled, serveMode spec)', async () => {
  __resetStore();
  __resetAppsCache();
  const app = (await callPlatformMcp(amir, 'create_software', { name: 'Spec App', domain: 'sales', kind: 'spec' })) as App;
  assert.equal(serveModeOf(app), 'spec', 'a spec app is served declaratively from creation');
  assert.equal(app.repo.fullName, '', 'no per-app Forgejo repo is scaffolded');
  assert.ok(Object.values(app.pipeline).every((s) => s === 'disabled'), 'every image-pipeline stage is disabled');

  // The DEFAULT kind is now 'spec' (0.6.136 declarative-first) — creating with no kind is a spec app.
  const def = (await callPlatformMcp(amir, 'create_software', { name: 'Default App', domain: 'sales' })) as App;
  assert.equal(serveModeOf(def), 'spec', 'default kind is now spec (declarative-first)');

  // An EXPLICIT kind:'code' still gets the historic image path (backward-compatible, coded-enabled here).
  const code = (await callPlatformMcp(amir, 'create_software', { name: 'Code App', domain: 'sales', kind: 'code' })) as App;
  assert.equal(serveModeOf(code), 'image', 'explicit kind:code stays image when coded apps are enabled');
});
