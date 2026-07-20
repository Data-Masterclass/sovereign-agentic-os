/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The analytics APPLY route (#146 Phase 1) driven through the REAL handlers, with
 * `requireAdmin`, `config`, the dataset store and the user directory mocked, and a
 * stubbed `fetch` standing in for Forgejo's commit + contents-at-ref API. Proves:
 *   - the config flag gates the route (403 when off),
 *   - admin gating rejects a non-admin / anon (403/401),
 *   - GET preview is a dry-run (never calls a governed WRITE — the store exposes
 *     only reads; a write would be an undefined-mock throw),
 *   - a round-tripping OS-managed file is ACCEPTED,
 *   - a hand-edited (non-round-trippable) OS-managed file is REJECTED (422) with a
 *     clear reason (single-writer guard),
 *   - a policy DENY (the mapped principal can't view the dataset) surfaces honestly,
 *   - a non-OS-managed changed path is ignored,
 *   - the commit author maps to an OS principal (service-principal/CI path) and the
 *     approver (session) is the fallback,
 *   - an unreachable Forgejo yields 503 (never a fabricated success).
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { emptyVersions, type Dataset } from './dataset-schema.ts';
import { buildCubeModels } from './cube-models.ts';
import { CUBE_ARTIFACT } from './metrics.ts';

// ─── mockable state ──────────────────────────────────────────────────────────
type Admin = { id: string; name: string; domains: string[]; role: string } | null;
let ADMIN: Admin = { id: 'root', name: 'Root', domains: ['sales'], role: 'admin' };
let ADMIN_STATUS = 0; // when non-zero, requireAdmin throws with this status
let FLAG = true;
let DATASETS: Dataset[] = [];
let USERS: Record<string, { id: string; name: string; domains: string[]; role: string }> = {};
// getDataset behaviour: view-deny for these ids (simulate DLS/OPA deny).
let VIEW_DENY: Set<string> = new Set();

mock.module('@/lib/core/auth', {
  namedExports: {
    requireAdmin: async () => {
      if (ADMIN_STATUS) {
        const err = new Error(ADMIN_STATUS === 401 ? 'Not authenticated' : 'Admin only') as Error & { status?: number };
        err.status = ADMIN_STATUS;
        throw err;
      }
      return ADMIN;
    },
  },
});
// A LIVE config view: `analyticsApplyEnabled` is a getter over the mutable FLAG so
// each test toggles the gate without re-mocking (a module can be mocked only once).
mock.module('@/lib/core/config', {
  namedExports: {
    config: {
      get analyticsApplyEnabled() { return FLAG; },
      forgejoUrl: 'http://forgejo', forgejoUser: 'bot', forgejoPassword: 'pw', forgejoRepoOwner: 'gitea_admin',
    },
  },
});
mock.module('@/lib/platform-admin/users', {
  namedExports: { getPublicUser: async (id: string) => USERS[id] ?? null },
});
mock.module('@/lib/data/store', {
  namedExports: {
    listGovernedDatasets: () => DATASETS,
    getDataset: (id: string, user: { id: string }) => {
      const d = DATASETS.find((x) => x.id === id);
      if (!d) { const e = new Error('not found') as Error & { status?: number }; e.status = 404; throw e; }
      if (VIEW_DENY.has(`${id}:${user.id}`)) {
        const e = new Error('Not permitted to view this dataset') as Error & { status?: number };
        e.status = 403; throw e;
      }
      return d;
    },
  },
});
// ─── fixtures ────────────────────────────────────────────────────────────────
function ds(over: Partial<Dataset> = {}): Dataset {
  const versions = emptyVersions();
  versions.bronze.built = true;
  versions.silver.built = true;
  versions.gold.built = true;
  return {
    version: '1', id: 'ds_orders', name: 'Orders', owner: 'amir', domain: 'sales',
    tier: 'asset', visibility: 'domain', description: 'Sales orders.', versions,
    grants: [], measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount' }],
    columns: [{ name: 'order_id', description: 'Key.' }, { name: 'net_amount', description: 'Value.' }],
    ...over,
  };
}
function cubePath(d: Dataset): string { return `cube/models/metrics/${CUBE_ARTIFACT(d).replace(/^metrics\//, '')}`; }
function cubeBytes(d: Dataset): string { return buildCubeModels([d]).models[0]!.model; }

// ─── fake Forgejo over global fetch ────────────────────────────────────────────
// commit API → { files:[{filename}], author:{login} }; contents API → {content(b64),encoding}
type CommitStub = { files: string[]; authorLogin: string | null; contents: Record<string, string | null> };
let COMMIT: CommitStub | null = null;
let FETCH_FAIL = false;

function jsonRes(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}
function installFetch() {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string | URL) => {
    if (FETCH_FAIL) throw new Error('ECONNREFUSED');
    const u = String(url);
    if (u.includes('/git/commits/')) {
      if (!COMMIT) return new Response('not found', { status: 404 });
      return jsonRes({ files: COMMIT.files.map((f) => ({ filename: f })), author: COMMIT.authorLogin ? { login: COMMIT.authorLogin } : null });
    }
    if (u.includes('/contents/')) {
      // decode the path segment between /contents/ and ?ref=
      const m = u.match(/\/contents\/(.+?)\?ref=/);
      const path = m ? decodeURIComponent(m[1].split('/').map(decodeURIComponent).join('/')) : '';
      const content = COMMIT?.contents[path];
      if (content === undefined || content === null) return new Response('not found', { status: 404 });
      return jsonRes({ content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' });
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
}

const SHA = 'abc1234';
async function call(method: 'GET' | 'POST', sha = SHA) {
  const route = await import(`../../app/api/analytics/apply/route.ts?${Math.random()}`);
  const req = new Request(`http://os/api/analytics/apply?sha=${sha}`, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
  return method === 'GET' ? route.GET(req) : route.POST(req);
}

beforeEach(() => {
  ADMIN = { id: 'root', name: 'Root', domains: ['sales'], role: 'admin' };
  ADMIN_STATUS = 0; FLAG = true; DATASETS = []; USERS = {}; VIEW_DENY = new Set();
  COMMIT = null; FETCH_FAIL = false;
  installFetch();
});

// ─── tests ───────────────────────────────────────────────────────────────────

test('flag OFF → 403 (route disabled), even for an admin', async () => {
  FLAG = false;
  const res = await call('POST');
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /disabled/i);
});

test('non-admin → 403; anon → 401', async () => {
  ADMIN_STATUS = 403;
  assert.equal((await call('POST')).status, 403);
  ADMIN_STATUS = 401;
  assert.equal((await call('POST')).status, 401);
});

test('invalid sha → 400', async () => {
  const res = await call('POST', 'not-a-sha!!');
  assert.equal(res.status, 400);
});

test('accepts a round-tripping cube file; maps commit author → principal (CI path)', async () => {
  const d = ds();
  DATASETS = [d];
  USERS = { amir: { id: 'amir', name: 'Amir', domains: ['sales'], role: 'builder' } };
  COMMIT = { files: [cubePath(d)], authorLogin: 'amir', contents: { [cubePath(d)]: cubeBytes(d) } };

  const res = await call('POST');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.actingPrincipal, 'amir', 'commit author mapped to the acting principal');
  assert.equal(body.authorMapped, true);
  assert.equal(body.registryUpdated, false, 'registry authoritative — no silent write');
  assert.equal(body.accepted.length, 1);
  assert.equal(body.accepted[0].datasetId, 'ds_orders');
});

test('falls back to the approver (session) principal when the author is unknown', async () => {
  const d = ds();
  DATASETS = [d];
  // author login "someone" not in USERS → fallback to approver (root/admin).
  COMMIT = { files: [cubePath(d)], authorLogin: 'someone', contents: { [cubePath(d)]: cubeBytes(d) } };

  const body = await (await call('POST')).json();
  assert.equal(body.actingPrincipal, 'root', 'unknown author falls back to the OS approver');
  assert.equal(body.authorMapped, false);
  assert.equal(body.ok, true);
});

test('REJECTS a hand-edited (non-round-trippable) OS-managed file → 422 with reason', async () => {
  const d = ds();
  DATASETS = [d];
  USERS = { amir: { id: 'amir', name: 'Amir', domains: ['sales'], role: 'builder' } };
  COMMIT = { files: [cubePath(d)], authorLogin: 'amir',
    contents: { [cubePath(d)]: cubeBytes(d) + '\n# hand-edited\n' } };

  const res = await call('POST');
  assert.equal(res.status, 422, 'invalid change → 422, not a fake 200');
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.rejected.length, 1);
  assert.match(body.rejected[0].reason, /does not round-trip|single-writer/);
});

test('policy DENY (author cannot view the dataset) surfaces honestly → 422', async () => {
  const d = ds();
  DATASETS = [d];
  USERS = { intruder: { id: 'intruder', name: 'X', domains: ['other'], role: 'builder' } };
  // The file round-trips, but the mapped principal is DENIED view (DLS/OPA).
  VIEW_DENY.add('ds_orders:intruder');
  COMMIT = { files: [cubePath(d)], authorLogin: 'intruder', contents: { [cubePath(d)]: cubeBytes(d) } };

  const res = await call('POST');
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.rejected[0].reason, /policy DENY/);
});

test('semantic-layer change by a non-owner creator is DENIED (Builder+ required)', async () => {
  const d = ds({ owner: 'amir' });
  DATASETS = [d];
  USERS = { junior: { id: 'junior', name: 'J', domains: ['sales'], role: 'creator' } };
  COMMIT = { files: [cubePath(d)], authorLogin: 'junior', contents: { [cubePath(d)]: cubeBytes(d) } };

  const body = await (await call('POST')).json();
  assert.equal(body.ok, false);
  assert.match(body.rejected[0].reason, /Builder\+ or ownership required/);
});

test('a non-OS-managed changed path is IGNORED (not rejected)', async () => {
  const d = ds();
  DATASETS = [d];
  COMMIT = { files: ['dbt/models/staging/stg_raw.sql'], authorLogin: null,
    contents: { 'dbt/models/staging/stg_raw.sql': 'select 1' } };

  const res = await call('POST');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.osManagedFiles, 0);
  assert.equal(body.ignoredFiles, 1);
});

test('GET preview is a dry-run: same verdict, mode=preview, no governed write', async () => {
  const d = ds();
  DATASETS = [d];
  USERS = { amir: { id: 'amir', name: 'Amir', domains: ['sales'], role: 'builder' } };
  COMMIT = { files: [cubePath(d)], authorLogin: 'amir', contents: { [cubePath(d)]: cubeBytes(d) } };

  const res = await call('GET');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'preview');
  assert.equal(body.ok, true);
  assert.equal(body.registryUpdated, false, 'preview writes nothing');
});

test('unreachable Forgejo → 503, never a fabricated success', async () => {
  DATASETS = [ds()];
  FETCH_FAIL = true;
  const res = await call('POST');
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /unreachable|not found/i);
});
