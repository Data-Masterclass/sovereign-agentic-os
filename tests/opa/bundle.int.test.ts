/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * bundle.int.test — WP-11 (04 §7.1 `bundle.int.test.ts`; 10 F3) on a REAL OPA 1.22.4 started from
 * the chart with `opa.dataBundle.enabled=true`, downloading the os-data bundle from os-ui's REAL
 * route handlers (tests/opa/bundle-it.ts). `OS_OPA_DATA_BUNDLE=1`: nothing is pushed.
 *
 *  1. OPA activates os-data; the runtime-domain decision is true; OPA's status POST names the
 *     revision os-ui serves; os-ui's own runtime PUTs are not sent and OPA refuses one anyway.
 *  2. A grant change reaches OPA within the chart's polling bound (≤ 15 s + compile).
 *  3. RESTART with os-ui DOWN: OPA comes back from /var/opa with every grant, identical documents
 *     and identical decisions.
 *  4. Negative twins — OPA keeps its last good bundle, never fails open, never goes to zero:
 *     a source that reports its store unloaded (partial), a source that empties the grants
 *     (zero), and a bundle-server outage (500s). Revision, documents and counts never move.
 *  5. COLD START with no persisted bundle and os-ui down: OPA stays unready (`/health?bundles`
 *     500) and os-ui's governed authorize() denies (fail closed).
 *
 * Run (from os-ui/): node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test ../tests/opa/bundle.int.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Opa, TOKEN, chartEnv, docker, fakeEmptyMirror, startBundleServer, startChartOpa, until, type BundleServer } from './bundle-it.ts';
import { RUNTIME_DOMAIN, seedOsState } from './fixture.ts';

const PORT = Number(process.env.OPA_IT_BUNDLE_PORT ?? 18193);
const SERVER_PORT = Number(process.env.OPA_IT_SERVER_PORT ?? 18283);
const NAME = 'wp11-bundle';
const COLD = 'wp11-bundle-cold';
const opa = new Opa(`http://127.0.0.1:${PORT}`);
const SETS = ['opa.dataBundle.enabled=true', `opa.dataBundle.serviceUrl=http://host.docker.internal:${SERVER_PORT}/api/opa`];

process.env.OPA_URL = opa.url;
process.env.OS_OPA_BUNDLE_TOKEN = TOKEN; // the dedicated bundle token (opa-bundle-token)
process.env.AGENT_RUNTIME_TOKEN = 'a-different-shared-runtime-token'; // never accepted by the bundle routes
process.env.OS_OPA_DATA_BUNDLE = '1';
process.env.OS_OPA_SEED = chartEnv('OS_OPA_SEED', ['opa.dataBundle.enabled=true']);
process.env.OS_OPA_SEED_PRINCIPALS = chartEnv('OS_OPA_SEED_PRINCIPALS');
await fakeEmptyMirror();

let server: BundleServer | null = null;
let stopBundle: (() => void) | undefined;
before(async () => {
  startChartOpa(NAME, PORT, SETS);
  server = await startBundleServer(SERVER_PORT);
});
after(async () => {
  stopBundle?.();
  await server?.close();
  docker('rm', '-f', NAME, COLD);
});

async function allow(o: Opa, principal: string, tool: string): Promise<boolean> {
  return (await o.eval('agentic/authz/allow', { principal, tool })) === true;
}

/** Everything under the bundle roots, for before/after comparisons. */
async function snapshot(o: Opa): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const r of ['grants', 'seed_grants', 'requires_approval', 'governance/tables', 'governance/principals', 'os_data']) out[r] = await o.data(r);
  return out;
}

function count(v: unknown): number {
  return v && typeof v === 'object' ? Object.keys(v).length : 0;
}

/** OPA's own report (status POST) of the os-data revision it has active. */
async function activeRevision(): Promise<string | undefined> {
  const { opaInstanceStatuses } = await import('@core/policy/opa-status');
  return opaInstanceStatuses().find((i) => i.instance === 'opa')?.bundles['os-data']?.active_revision;
}

let good: Record<string, unknown> = {};
let goodRev = '';

test('1. OPA activates os-data from os-ui; pushes are not sent and OPA refuses them', async () => {
  await seedOsState();
  const { startOsDataBundle, osDataBundleStatus } = await import('@core/policy/bundle');
  stopBundle = startOsDataBundle({ resyncMs: 60 * 60_000, debounceMs: 50 });
  assert.equal(await until(() => opa.status(), (s) => s === 200, 60_000), 200, '/health?bundles is 200');
  assert.equal(await allow(opa, `domain:${RUNTIME_DOMAIN}`, 'query'), true, 'runtime domain granted by the bundle');
  const rev = osDataBundleStatus().revision!;
  assert.equal(await until(activeRevision, (r) => r === rev, 20_000), rev, 'OPA status POST reports the served revision active');

  const { publishOpa } = await import('@core/policy/opa-publish');
  const r = await publishOpa({ kind: 'data', path: 'grants/x', value: ['query'] });
  assert.equal(r.status, 202, 'bundle mode: os-ui does not PUT a bundled document');
  const direct = await opa.put('grants/x', ['query']);
  assert.equal(direct.status, 400);
  assert.match(direct.body, /path grants\/x is owned by bundle/, 'OPA itself refuses a runtime PUT under the bundle roots');
  const outside = await publishOpa({ kind: 'data', path: 'governance/releases/personal_u1', value: { reader: 'u1' } });
  assert.equal(outside.ok, true, 'a document outside the roots (promotion release) is still written');
  good = await snapshot(opa);
  goodRev = rev;
});

test('2. a grant change reaches OPA within the polling bound', async () => {
  const { createUser } = await import('@tabs/admin/lib/users');
  const { recompile } = await import('../../os-ui/app/api/platform-admin/_compile.ts');
  const t0 = Date.now();
  await createUser({ id: 'late-joiner', email: 'late@example.com', password: 'S0me-Long-Passphrase!', domains: [RUNTIME_DOMAIN], role: 'creator' });
  await recompile(); // the change path: in bundle mode it asks the bundle to recompile
  const got = await until(async () => ((await opa.data('grants')) as Record<string, unknown>)['user:late-joiner'], (v) => v !== undefined, 25_000, 250);
  const ms = Date.now() - t0;
  console.log(`[bundle] os-data grant change active in OPA after ${ms} ms`);
  assert.ok(got, 'new user grant in OPA');
  assert.ok(ms < 20_000, 'within max_delay_seconds (15) plus compile');
  good = await snapshot(opa);
  const { osDataBundleStatus } = await import('@core/policy/bundle');
  goodRev = osDataBundleStatus().revision!;
});

test('3. restart with os-ui DOWN: every grant comes back from /var/opa', async () => {
  await server!.close();
  server = null;
  docker('restart', '-t', '1', NAME);
  assert.equal(await until(() => opa.status(), (s) => s === 200, 30_000), 200, 'ready from the persisted bundle with no bundle server');
  const after = await snapshot(opa);
  assert.deepEqual(after, good, 'every document identical after the restart');
  console.log(`[bundle] after restart (os-ui down): ${count(after.grants)} grant principals, ${count((after['governance/principals']))} governance principals, ${count(after['governance/tables'])} tables — identical`);
  assert.equal(await allow(opa, `domain:${RUNTIME_DOMAIN}`, 'query'), true);
  assert.equal(await allow(opa, 'user:late-joiner', 'query'), (good.grants as Record<string, string[]>)['user:late-joiner'].includes('query'));
  const { spawnSync } = await import('node:child_process');
  const l = spawnSync('docker', ['logs', NAME], { encoding: 'utf8' });
  const logs = `${l.stdout}${l.stderr}`;
  assert.match(logs, /Bundle loaded and activated successfully/);
  server = await startBundleServer(SERVER_PORT);
});

async function assertKeptLastGood(when: string, waitMs = 32_000): Promise<void> {
  // Full polling cycles (max 15 s each) must pass with OPA unchanged.
  await new Promise((r) => setTimeout(r, waitMs));
  assert.equal(await opa.status(), 200, `${when}: OPA still ready`);
  const now = await snapshot(opa);
  assert.deepEqual(now, good, `${when}: OPA kept its last good documents`);
  assert.equal(await activeRevision(), goodRev, `${when}: active revision unchanged`);
  assert.equal(await allow(opa, `domain:${RUNTIME_DOMAIN}`, 'query'), true, `${when}: never fails closed on the user either`);
  assert.equal(await allow(opa, 'nobody', 'query'), false, `${when}: never fails open`);
}

test('4a. negative twin — a partial source (store not loaded): compile refused, last good kept', async () => {
  const { registerOpaStateSource } = await import('@core/policy/opa-reconcile');
  const { recompileOsData, osDataBundleStatus } = await import('@core/policy/bundle');
  registerOpaStateSource({ name: 'it-partial', bundled: true, restore: async () => ({ ok: false, detail: 'dataset registry not hydrated yet (pending)' }) });
  const r = await recompileOsData('it-partial');
  assert.equal(r.ok, false);
  assert.match(osDataBundleStatus().lastError ?? '', /incomplete source.*it-partial/);
  assert.equal(osDataBundleStatus().revision, goodRev, 'os-ui keeps serving the last good bundle');
  await assertKeptLastGood('partial source');
  registerOpaStateSource({ name: 'it-partial', bundled: true, restore: async () => ({ ok: true, detail: 'healed' }) });
});

test('4b. negative twin — an empty grants document: refused, never zero', async () => {
  const { registerOpaStateSource } = await import('@core/policy/opa-reconcile');
  const { publishOpa } = await import('@core/policy/opa-publish');
  const { recompileOsData } = await import('@core/policy/bundle');
  registerOpaStateSource({ name: 'it-partial', bundled: true, restore: async () => {
    const w = await publishOpa({ kind: 'data', path: 'grants', value: {} });
    return { ok: w.ok, detail: 'wrote an empty grants document' };
  } });
  const r = await recompileOsData('it-empty');
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.detail, /grants document is empty/);
  await assertKeptLastGood('empty grants');
  registerOpaStateSource({ name: 'it-partial', bundled: true, restore: async () => ({ ok: true, detail: 'healed' }) });
});

test('4c. negative twin — bundle-server outage (500s): OPA keeps its last good bundle', async () => {
  server!.outage = 500;
  await assertKeptLastGood('bundle-server outage');
  assert.ok(server!.requests.some((q) => q.status === 500 && q.path.endsWith('os-data.tar.gz')), 'OPA really polled during the outage');
  server!.outage = null;
});

test('4d. negative twin — a large drop (>10 % of grant principals): refused, then applied only after an admin acknowledges it', async () => {
  const { registerOpaStateSource } = await import('@core/policy/opa-reconcile');
  const { publishOpa } = await import('@core/policy/opa-publish');
  const { recompileOsData, osDataBundleStatus, acknowledgeOsDataBundle } = await import('@core/policy/bundle');
  const before = Object.keys(good.grants as object);
  const victims = before.filter((k) => k.startsWith('user:u')).slice(0, Math.ceil(before.length * 0.2));
  registerOpaStateSource({ name: 'it-partial', bundled: true, restore: async () => {
    for (const v of victims) await publishOpa({ kind: 'delete', path: `grants/${encodeURIComponent(v)}` });
    return { ok: true, detail: `silently lost ${victims.length} user grants` };
  } });
  const r = await recompileOsData('it-drop');
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.detail, /grant principals drop/);
  await assertKeptLastGood('large drop', 17_000);
  // An admin looks at it and says yes: exactly this content goes through, once.
  const refused = osDataBundleStatus().refused!;
  assert.equal(acknowledgeOsDataBundle(refused.hash, 'admin', 'it: cohort archived').ok, true);
  assert.equal((await recompileOsData('it-ack')).ok, true);
  const shrunk = await until(async () => Object.keys(((await opa.data('grants')) ?? {}) as object).length, (n) => n === before.length - victims.length, 25_000, 250);
  assert.equal(shrunk, before.length - victims.length, 'the acknowledged removal reached OPA');
  // Back to full: growth needs no acknowledgement.
  registerOpaStateSource({ name: 'it-partial', bundled: true, restore: async () => ({ ok: true, detail: 'healed' }) });
  assert.equal((await recompileOsData('it-heal')).ok, true);
  await until(async () => Object.keys(((await opa.data('grants')) ?? {}) as object).length, (n) => n === before.length, 25_000, 250);
  good = await snapshot(opa);
  goodRev = osDataBundleStatus().revision!;
  assert.equal(await until(activeRevision, (v) => v === goodRev, 25_000, 250), goodRev);
});

test('4e. negative twin — an internal table missing (same table count): refused, OPA unchanged', async () => {
  const { registerOpaStateSource } = await import('@core/policy/opa-reconcile');
  const { publishOpa } = await import('@core/policy/opa-publish');
  const { recompileOsData } = await import('@core/policy/bundle');
  const tables = Object.keys(good['governance/tables'] as object);
  const gone = tables.find((t) => t.startsWith('iceberg.'))!;
  registerOpaStateSource({ name: 'it-partial', bundled: true, restore: async () => {
    await publishOpa({ kind: 'delete', path: `governance/tables/${encodeURIComponent(gone)}` });
    await publishOpa({ kind: 'data', path: `governance/tables/${encodeURIComponent('iceberg.it.replacement')}`, value: { domain: 'sales', visibility: 'domain' } });
    return { ok: true, detail: 'one table swapped for another' };
  } });
  const r = await recompileOsData('it-missing-table');
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.detail, new RegExp(`internal table\\(s\\) missing.*${gone.replace(/\./g, '\\.')}`));
  await assertKeptLastGood('missing internal table', 17_000);
  registerOpaStateSource({ name: 'it-partial', bundled: true, restore: async () => ({ ok: true, detail: 'healed' }) });
});

test('4f. negative twin — an os-ui that holds an OLDER bundle (a pod behind): 409, OPA unchanged', async () => {
  const { buildBundle, __setServedOsDataBundleForTest, recompileOsData } = await import('@core/policy/bundle');
  const { GET } = await import('../../os-ui/app/api/opa/bundles/os-data.tar.gz/route.ts');
  const stale = buildBundle('os-data', { ...good, grants: { 'user:stale': ['query'] } } as Record<string, unknown>, ['grants'], '1-0123456789abcdef0123');
  Object.assign(stale, { seq: 1, hash: '0123456789abcdef0123' });
  __setServedOsDataBundleForTest(stale);
  const res = await GET(new Request('http://x/api/opa/bundles/os-data.tar.gz', { headers: { authorization: `Bearer ${TOKEN}`, 'if-none-match': `"${goodRev}"` } }));
  assert.equal(res.status, 409, 'never an older bundle than the active one');
  await assertKeptLastGood('older bundle', 17_000);
  await recompileOsData('it-recover');
});

test('4g. negative twin — the shared runtime token is not the bundle token: 401', async () => {
  const { GET } = await import('../../os-ui/app/api/opa/bundles/os-data.tar.gz/route.ts');
  const status = await import('../../os-ui/app/api/opa/status/route.ts');
  const shared = { authorization: `Bearer ${process.env.AGENT_RUNTIME_TOKEN}` };
  assert.equal((await GET(new Request('http://x/b', { headers: shared }))).status, 401);
  assert.equal((await status.POST(new Request('http://x/s', { method: 'POST', headers: shared, body: '{"labels":{"instance":"opa"}}' }))).status, 401, 'a forged status report is refused');
});

test('5. cold start with no persisted bundle and os-ui down: unready, and os-ui denies', async () => {
  await server!.close();
  server = null;
  // A NEW container (a new pod: empty /var/opa) on the same port os-ui is configured with.
  docker('rm', '-f', NAME);
  startChartOpa(COLD, PORT, SETS);
  await until(() => opa.status('/health'), (s) => s === 200, 30_000);
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(await opa.status(), 500, '/health?bundles is 500 without an activated bundle');
  assert.equal(await allow(opa, `domain:${RUNTIME_DOMAIN}`, 'query'), false, 'no data, no grant');
  const { authorize } = await import('@core/infra/governed');
  const d = await authorize(`domain:${RUNTIME_DOMAIN}`, 'query');
  assert.equal(d.allowed, false, 'os-ui fails closed');
  const { opaBundlesActive } = await import('@core/policy/opa-publish');
  assert.equal(await opaBundlesActive(), false, 'the run worker gate holds runs');
});
