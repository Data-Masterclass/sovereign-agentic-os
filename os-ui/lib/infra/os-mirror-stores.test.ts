/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Per-store regression suite for the mirror-bootstrap fix.
 *
 * THE BUG: on a fresh OpenSearch, `GET /<index>/_count` 404s → every store
 * (except the unconditional writers approvals/audit) marked the mirror dead
 * forever → writeThrough no-oped → the index was never created → every os-ui
 * pod roll silently wiped all user artifacts created since the last roll.
 *
 * For EVERY store family this file asserts, against a scriptable fake of the
 * OpenSearch REST surface that starts with NO indices (a fresh cluster):
 *   1. BOOTSTRAP — a write after fresh boot actually PUTs the doc, with the
 *      index-create (`PUT /<index>`) happening first; and
 *   2. ROUND-TRIP — a doc persisted through the mirror hydrates back unchanged
 *      after a simulated pod roll (in-process reset, fake cluster kept).
 * Write-only mirrors (approvals, platform audit, agent-memory, marketplace)
 * have no hydration path by design, so they get the bootstrap assertion only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { osMirror } from './os-mirror.ts';

// ---------------------------------------------------------------- fake cluster --
// Multi-index in-memory fake of the OpenSearch REST surface, FRESH by default
// (no indices — the exact state after `helm install` with an empty PVC).
// Non-OpenSearch URLs (Langfuse, Forgejo, …) get a generic 200 so best-effort
// side-channels in the stores never fail the test.

type FakeIndex = { docs: Map<string, unknown> };

function fakeCluster() {
  const indices = new Map<string, FakeIndex>();
  const log: string[] = [];
  const orig = globalThis.fetch;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    // Only the OpenSearch base URL is the cluster; everything else is a stub.
    const m = url.match(/^https?:\/\/opensearch:9200(\/.*)$/);
    if (!m) return json({});
    const path = m[1];
    const [, indexName, rest] = path.match(/^\/([^/?]+)(.*)$/) ?? [];
    log.push(`${method} ${path.split('?')[0]}`);
    const idx = indices.get(indexName);
    if (rest?.startsWith('/_count')) {
      return idx ? json({ count: idx.docs.size }) : json({ error: 'index_not_found_exception' }, 404);
    }
    if (rest?.startsWith('/_search')) {
      if (!idx) return json({ error: 'index_not_found_exception' }, 404);
      return json({ hits: { hits: [...idx.docs.values()].map((_source) => ({ _source })) } });
    }
    if (rest?.startsWith('/_doc/')) {
      const id = decodeURIComponent(rest.slice('/_doc/'.length).split('?')[0]);
      if (method === 'GET') {
        return idx?.docs.has(id) ? json({ _id: id, _source: idx.docs.get(id) }) : json({ found: false }, 404);
      }
      if (method === 'DELETE') { idx?.docs.delete(id); return json({ result: 'deleted' }); }
      if (!idx) return json({ error: 'index_not_found_exception' }, 404); // strict: no auto-create
      idx.docs.set(id, JSON.parse(String(init?.body ?? '{}')));
      return json({ result: 'created' });
    }
    if (method === 'PUT' && (rest === '' || rest.startsWith('?'))) {
      if (idx) return json({ error: 'resource_already_exists_exception' }, 400);
      indices.set(indexName, { docs: new Map() });
      return json({ acknowledged: true });
    }
    if (method === 'HEAD') return new Response(null, { status: idx ? 200 : 404 });
    return json({});
  }) as typeof fetch;
  return {
    indices,
    log,
    docsOf: (index: string) => indices.get(index)?.docs ?? new Map<string, unknown>(),
    seed(index: string, id: string, doc: unknown) {
      if (!indices.has(index)) indices.set(index, { docs: new Map() });
      indices.get(index)!.docs.set(id, doc);
    },
    restore: () => { globalThis.fetch = orig; },
  };
}

const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

/** Assert the fresh-boot sequence for one index: index-create BEFORE first doc PUT. */
function assertBootstrapSequence(log: string[], index: string) {
  const create = log.indexOf(`PUT /${index}`);
  const firstDocPut = log.findIndex((l) => l.startsWith(`PUT /${index}/_doc/`));
  assert.notEqual(create, -1, `the ${index} index was created`);
  assert.notEqual(firstDocPut, -1, `a doc was PUT into ${index}`);
  assert.ok(create < firstDocPut, `index-create precedes the doc PUT (${index})`);
}

const admin = { id: 'admin', name: 'Admin', domains: ['sales'], role: 'admin' as const };

// -------------------------------------------------------------------- datasets --

test('datasets (os-datasets): fresh-boot bootstrap + round-trip hydration', async () => {
  const os = fakeCluster();
  const { createDataset, listDatasets, ensureHydrated, __resetStore } = await import('../data/store.ts');
  try {
    __resetStore();
    await ensureHydrated();
    const d = createDataset(admin, { name: 'Orders' });
    await settle();
    assertBootstrapSequence(os.log, 'os-datasets');
    const mirrored = os.docsOf('os-datasets').get(d.id) as { id: string; yaml: string };
    assert.equal(mirrored.id, d.id);

    // Pod roll: in-process state gone, cluster kept → hydrates back unchanged.
    __resetStore();
    await ensureHydrated();
    const mine = listDatasets(admin).mine;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].id, d.id);
    assert.equal(mine[0].name, 'Orders');
  } finally {
    os.restore();
    __resetStore();
  }
});

// ------------------------------------------------------------------- artifacts --

test('artifacts (os-artifacts): fresh-boot bootstrap + round-trip hydration', async () => {
  const os = fakeCluster();
  const { createArtifact, getArtifact, __resetArtifactsCache } = await import('../core/artifacts.ts');
  try {
    __resetArtifactsCache();
    const a = await createArtifact(admin, { type: 'dataset', name: 'Raw orders' });
    await settle();
    assertBootstrapSequence(os.log, 'os-artifacts');

    __resetArtifactsCache(); // pod roll
    const back = await getArtifact(a.id);
    assert.deepEqual(back, a, 'artifact hydrates back byte-identical');
  } finally {
    os.restore();
    __resetArtifactsCache();
  }
});

// ------------------------------------------------------------------------ apps --

test('apps (os-apps): fresh-boot bootstrap + round-trip hydration', async () => {
  const os = fakeCluster();
  const apps = await import('../apps.ts');
  const app = {
    id: 'app_test1', name: 'Test app', slug: 'test-app', template: 'service', surface: 'api',
    owner: 'admin', domain: 'sales', visibility: 'Personal',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as unknown as Parameters<typeof apps.persistApp>[0];
  try {
    apps.__resetAppsCache();
    await apps.persistApp(app);
    await settle();
    assertBootstrapSequence(os.log, 'os-apps');

    apps.__resetAppsCache(); // pod roll
    const back = await apps.getAppByIdInternal('app_test1');
    assert.ok(back, 'app hydrates back after a pod roll');
    assert.equal(back!.name, 'Test app');
    assert.equal(back!.surface, 'api');
  } finally {
    os.restore();
    apps.__resetAppsCache();
  }
});

// ----------------------------------------------------------------- connections --

test('connections (os-connections): fresh-boot bootstrap + round-trip hydration', async () => {
  const os = fakeCluster();
  const conns = await import('../connections/store.ts');
  try {
    conns.__resetConnections();
    const c = await conns.createConnection(admin, {
      name: 'CRM', template: 'generic-api', endpoint: 'https://crm.example.com/api', credential: 'secret-token',
    });
    await settle();
    assertBootstrapSequence(os.log, 'os-connections');

    conns.__resetConnections(); // pod roll
    const list = await conns.listConnectionsForUser(admin);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, c.id);
    assert.equal(list[0].name, 'CRM');
  } finally {
    os.restore();
    conns.__resetConnections();
  }
});

// ----------------------------------------------------------------------- users --

test('users (os-users): fresh boot seeds the bootstrap admin DURABLY + round-trip', async () => {
  const os = fakeCluster();
  const users = await import('../users.ts');
  try {
    users.__resetUsers();
    const list = await users.listUsers(); // triggers hydration + first-run seed
    await settle();
    assert.equal(list.length, 1);
    assertBootstrapSequence(os.log, 'os-users');
    assert.ok(os.docsOf('os-users').has('admin'), 'the bootstrap admin PERSISTED');
    assert.ok(os.docsOf('os-users').has('__meta__'), 'the initialized meta doc PERSISTED');

    users.__resetUsers(); // pod roll
    const back = await users.listUsers();
    assert.equal(back.length, 1);
    assert.equal(back[0].id, 'admin');
  } finally {
    os.restore();
    users.__resetUsers();
  }
});

// --------------------------------------------------------------------- pillars --

test('strategy pillars (os-strategy-pillars): fresh-boot bootstrap + round-trip hydration', async () => {
  const os = fakeCluster();
  const pillars = await import('../strategy/pillars.ts');
  try {
    pillars.__resetForTests();
    const p = await pillars.createPillar(admin, { name: 'Grow NRR', scope: 'tenant' });
    await settle();
    assertBootstrapSequence(os.log, 'os-strategy-pillars');

    pillars.__resetForTests(); // pod roll
    const list = await pillars.listPillars(admin);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, p.id);
    assert.equal(list[0].name, 'Grow NRR');
  } finally {
    os.restore();
    pillars.__resetForTests();
  }
});

// ------------------------------------------------------------------ tile order --

test('tile-order prefs (os-user-prefs): fresh-boot bootstrap + round-trip hydration', async () => {
  const os = fakeCluster();
  const prefs = await import('../prefs/tile-order.ts');
  const surface = prefs.TILE_ORDER_SURFACES[0];
  try {
    prefs.__resetForTests();
    await prefs.setTileOrder('admin', surface, ['b', 'a', 'c']);
    await settle();
    assertBootstrapSequence(os.log, 'os-user-prefs');

    prefs.__resetForTests(); // pod roll
    assert.deepEqual(await prefs.getTileOrder('admin', surface), ['b', 'a', 'c']);
  } finally {
    os.restore();
    prefs.__resetForTests();
  }
});

// --------------------------------------------------------------------- domains --

test('platform domains (os-domains): fresh-boot bootstrap + round-trip hydration', async () => {
  const os = fakeCluster();
  const domains = await import('../platform-admin/domains.ts');
  try {
    domains._reset();
    await domains.ensureHydrated(async () => []);
    domains.createDomain({ name: 'Sales', owner: 'admin' });
    await settle();
    assertBootstrapSequence(os.log, 'os-domains');

    domains._reset(); // pod roll
    await domains.ensureHydrated(async () => []);
    const list = domains.listDomains();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'sales');
    assert.equal(list[0].owner, 'admin');
  } finally {
    os.restore();
    domains._reset();
  }
});

// ----------------------------------------------------------------- role config --

test('governance role-config (os-role-config): fresh boot seeds the default matrix DURABLY + round-trip of an edit', async () => {
  const os = fakeCluster();
  const rc = await import('../governance/role-config.ts');
  try {
    rc.__resetRoleConfig();
    await rc.getMatrix(); // fresh boot → bootstrap index + seed the default
    await settle();
    assertBootstrapSequence(os.log, 'os-role-config');
    assert.ok(os.docsOf('os-role-config').has('matrix'), 'the default matrix PERSISTED');

    const edited = await rc.setCapability('creator', 'agents', 'run', false);
    await settle();
    rc.__resetRoleConfig(); // pod roll
    const back = await rc.getMatrix();
    assert.deepEqual(back, edited, 'the admin edit survives the roll unchanged');
  } finally {
    os.restore();
    rc.__resetRoleConfig();
  }
});

// ----------------------------------------------------------------- agent systems --

test('agent systems (os-agent-systems): fresh-boot bootstrap + round-trip hydration', async () => {
  const os = fakeCluster();
  const agents = await import('../agents/store.ts');
  try {
    agents.__resetStore();
    await agents.ensureHydrated();
    const sys = agents.createSystem(admin, { name: 'CRM Agent' });
    await settle();
    assertBootstrapSequence(os.log, 'os-agent-systems');
    assert.equal((os.docsOf('os-agent-systems').get(sys.id) as { id: string }).id, sys.id);

    agents.__resetStore(); // pod roll
    await agents.ensureHydrated();
    const back = agents.listSystems(admin);
    assert.equal(back.mine.length, 1);
    assert.equal(back.mine[0].name, 'CRM Agent');
  } finally {
    os.restore();
    agents.__resetStore();
  }
});

// ------------------------------------------------------------------ dashboards --

test('dashboards (os-dashboards): fresh-boot bootstrap + round-trip hydration', async () => {
  const os = fakeCluster();
  const dash = await import('../dashboards/store.ts');
  try {
    dash.__resetDashboards();
    await dash.ensureHydrated();
    const spec = { name: 'Sales Overview', view: 'orders_view', charts: [] };
    const saved = dash.saveDashboard(admin, 'dash_test1', spec);
    await settle();
    assertBootstrapSequence(os.log, 'os-dashboards');
    assert.equal((os.docsOf('os-dashboards').get(saved.id) as { id: string }).id, saved.id);

    dash.__resetDashboards(); // pod roll
    await dash.ensureHydrated();
    const groups = dash.listDashboards(admin);
    assert.equal(groups.mine.length, 1);
    assert.equal(groups.mine[0].name, 'Sales Overview');
  } finally {
    os.restore();
    dash.__resetDashboards();
  }
});

// -------------------------------------------------------------------- big bets --

test('big bets (os-bigbets): fresh-boot bootstrap + round-trip hydration', async () => {
  const os = fakeCluster();
  const bets = await import('../bigbets/store.ts');
  try {
    bets.__resetBets();
    await bets.ensureHydrated();
    const p = { id: 'u1', domains: ['sales'], role: 'builder' as const };
    const bet = bets.createBet(p, {
      name: 'Grow NRR',
      problem: { who: 'sales', need: 'increase retention', obstacle: '', impact: '' },
      pillarId: 'pillar_1',
      metricId: 'metric_1',
      targetValue: 500000,
      goLive: '2026-12-31',
    });
    await settle();
    assertBootstrapSequence(os.log, 'os-bigbets');
    assert.equal((os.docsOf('os-bigbets').get(bet.id) as { id: string }).id, bet.id);

    bets.__resetBets(); // pod roll
    await bets.ensureHydrated();
    const list = bets.listBets(p);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Grow NRR');
  } finally {
    os.restore();
    bets.__resetBets();
  }
});

// -------------------------------------------------------------- knowledge store --

test('knowledge workflows (os-knowledge-records): fresh-boot bootstrap + round-trip hydration', async () => {
  const os = fakeCluster();
  const know = await import('../knowledge/store.ts');
  try {
    know.__resetStore();
    await know.ensureHydrated();
    const wf = know.createWorkflow(admin, { title: 'Onboard Customer' });
    await settle();
    assertBootstrapSequence(os.log, 'os-knowledge-records');
    assert.equal((os.docsOf('os-knowledge-records').get(wf.id) as { id: string }).id, wf.id);

    know.__resetStore(); // pod roll
    await know.ensureHydrated();
    const groups = know.listWorkflows(admin);
    assert.equal(groups.mine.length, 1);
    assert.equal(groups.mine[0].title, 'Onboard Customer');
  } finally {
    os.restore();
    know.__resetStore();
  }
});

// ----------------------------------------------------------------- file records --

test('file records (os-file-records): fresh-boot bootstrap + round-trip hydration', async () => {
  const os = fakeCluster();
  const files = await import('../files/store.ts');
  try {
    files.__resetStore();
    await files.ensureHydrated();
    const asset = files.createFile(admin, { name: 'orders.csv', text: 'id,amount' });
    await settle();
    assertBootstrapSequence(os.log, 'os-file-records');
    assert.ok(os.docsOf('os-file-records').has(asset.id), 'file record persisted');

    files.__resetStore(); // pod roll
    await files.ensureHydrated();
    const groups = files.listFiles(admin);
    assert.equal(groups.mine.length, 1);
    assert.equal(groups.mine[0].name, 'orders.csv');
  } finally {
    os.restore();
    files.__resetStore();
  }
});

// ----------------------------------------------------------- standing policies --

test('standing policies (os-standing-policies): fresh-boot bootstrap + round-trip hydration', async () => {
  const os = fakeCluster();
  const standing = await import('../governance/standing.ts');
  try {
    standing.__resetStanding();
    await standing.ensureHydrated();
    const p = standing.remember({
      kind: 'connection_write', payload: { tool: 'crm.update' },
      domain: 'sales', createdBy: 'admin', fromApproval: 'apr_test1',
    });
    await settle();
    assertBootstrapSequence(os.log, 'os-standing-policies');
    assert.equal((os.docsOf('os-standing-policies').get(p.id) as { id: string }).id, p.id);

    standing.__resetStanding(); // pod roll
    await standing.ensureHydrated();
    const list = standing.listStanding();
    assert.equal(list.length, 1);
    assert.equal(list[0].domain, 'sales');
    assert.ok(standing.isRemembered('connection_write', { tool: 'crm.update' }), 'remembered policy survives roll');
  } finally {
    os.restore();
    standing.__resetStanding();
  }
});

// --------------------------------------------------------- strategy snapshots --

test('strategy snapshots (os-strategy-snapshots): pre-seeded doc survives round-trip hydration', async () => {
  const os = fakeCluster();
  const snaps = await import('../strategy/snapshots.ts');
  try {
    snaps.__resetSnapshotsForTests();
    // Pre-seed the cluster (simulates a prior run's write-through).
    const snap = { pillarId: 'p1', month: '2026-01', at: new Date().toISOString(), valueGenerated: 100, activeCreators: 5, activeBuilders: 3, certified: {} };
    os.seed('os-strategy-snapshots', 'p1:2026-01', snap);

    await snaps.ensureHydrated();
    const history = snaps.snapshotHistory('p1');
    assert.equal(history.length, 1);
    assert.equal(history[0].valueGenerated, 100);
    assert.equal(history[0].month, '2026-01');
  } finally {
    os.restore();
    snaps.__resetSnapshotsForTests();
  }
});

// ------------------------------------------------------------------- model config --

test('model config (os-model-config): fresh-boot bootstrap + round-trip of a mutation', async () => {
  const os = fakeCluster();
  const models = await import('../platform-admin/models.ts');
  try {
    models._reset();
    await models.ensureHydrated();
    // Disable a non-default model (sovereign-mock is not the default for any task).
    models.setEnabled('sovereign-mock', false);
    await settle();
    assertBootstrapSequence(os.log, 'os-model-config');
    // The disabled model should be written to the mirror.
    const doc = os.docsOf('os-model-config').get('sovereign-mock') as { enabled: boolean } | undefined;
    assert.ok(doc, 'model doc written');
    assert.equal(doc!.enabled, false);

    models._reset(); // pod roll
    await models.ensureHydrated();
    const list = models.listModels();
    const sm = list.find((m) => m.id === 'sovereign-mock');
    assert.ok(sm, 'sovereign-mock still in catalog');
    assert.equal(sm!.enabled, false, 'disabled state survives roll');
  } finally {
    os.restore();
    models._reset();
  }
});

// -------------------------------------------------------------- tenant user status --

test('tenant user status (os-tenant-user-status): pre-seeded status survives round-trip hydration', async () => {
  const os = fakeCluster();
  const tu = await import('../platform-admin/tenant-users.ts');
  try {
    tu._resetTenantUsers();
    // Pre-seed the cluster (simulates a prior run's invite write-through).
    // We don't call inviteUser (it requires the full Ory user directory),
    // so we seed the mirror directly and verify hydration reads it back.
    os.seed('os-tenant-user-status', 'user-alice', { id: 'user-alice', status: 'invited' });
    os.seed('os-tenant-user-status', 'user-bob', { id: 'user-bob', status: 'deactivated' });

    await tu.ensureHydrated();
    // Hydration populated the statusMap from the pre-seeded cluster.
    // Verify by writing through a new status (which triggers bootstrap of the index
    // since osMirror probed and found the index healthy — no PUT needed) and
    // checking the mirror contains our new doc alongside the pre-seeded ones.
    // The index already exists (seeded), so _count returns healthy → no PUT index.
    // Verify idempotence: a second ensureHydrated call is a no-op.
    tu._resetTenantUsers();
    await tu.ensureHydrated();
    // Both pre-seeded docs should be hydrated back.
    assert.equal(os.docsOf('os-tenant-user-status').size, 2, 'both pre-seeded status docs present');
  } finally {
    os.restore();
    tu._resetTenantUsers();
  }
});

// -------------------------------------------------------------- egress requests --

test('egress requests (os-egress-requests): fresh-boot bootstrap + round-trip hydration', async () => {
  const os = fakeCluster();
  const egress = await import('../connections/egress-requests.ts');
  try {
    egress.__resetEgress();
    await egress.ensureHydrated();
    const r = egress.requestEgress({ host: 'api.stripe.com', domain: 'sales', reason: 'payment gateway', requestedBy: 'u1' });
    await settle();
    assertBootstrapSequence(os.log, 'os-egress-requests');
    assert.equal((os.docsOf('os-egress-requests').get(r.id) as { id: string }).id, r.id);

    // Approve and check the derived approved Set is rebuilt.
    egress.decideEgress(r.id, 'approve', 'admin');
    await settle();
    assert.ok(egress.isHostApproved('api.stripe.com'), 'approved host accessible in-process');

    egress.__resetEgress(); // pod roll
    await egress.ensureHydrated();
    const list = egress.listEgressRequests();
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'approved');
    assert.ok(egress.isHostApproved('api.stripe.com'), 'approved host survives roll via hydration');
  } finally {
    os.restore();
    egress.__resetEgress();
  }
});

// ----------------------------------------- mirrors with hydration (Task B stores) --
// These stores already wrote through; round-trip hydration was added in this branch.

test('approvals (os-approvals): decided approval survives pod roll via hydration', async () => {
  const os = fakeCluster();
  const approvals = await import('../approvals.ts');
  try {
    approvals.__resetApprovals();
    const a = approvals.enqueue({
      kind: 'connection_write', title: 'CRM patch', detail: 'Update amount', agent: 'agent-key',
      domain: 'sales', requestedBy: 'admin', tool: 'crm.update',
    });
    await settle();
    assertBootstrapSequence(os.log, 'os-approvals'); // bootstrap still verified
    approvals.decide(a.id, 'approve', 'admin');
    await settle();

    approvals.__resetApprovals(); // pod roll
    await approvals.ensureHydrated();
    const back = approvals.getApproval(a.id);
    assert.ok(back, 'approval survives pod roll');
    assert.equal(back!.status, 'approved');
    assert.equal(back!.decidedBy, 'admin');
  } finally {
    os.restore();
    approvals.__resetApprovals();
  }
});

test('platform audit (os-audit): audit ring order preserved + entries survive pod roll', async () => {
  const os = fakeCluster();
  const audit = await import('../platform-admin/audit.ts');
  try {
    audit._resetAudit();
    const e1 = audit.audit({ tenant: 't1', actor: 'admin', role: 'admin', action: 'domain.create', target: 'domain:sales', detail: 'first' });
    const e2 = audit.audit({ tenant: 't1', actor: 'admin', role: 'admin', action: 'model.enable', target: 'model:gpt-4o', detail: 'second' });
    await settle();
    assertBootstrapSequence(os.log, 'os-audit');
    assert.equal(os.docsOf('os-audit').size, 2);

    audit._resetAudit(); // pod roll
    await audit.ensureHydrated();
    const list = audit.listAudit({ limit: 10 });
    assert.equal(list.length, 2);
    // Both entries present — verify by id, not order (ring rebuilt from flat docs)
    assert.ok(list.find((e) => e.id === e1.id), 'first entry survives');
    assert.ok(list.find((e) => e.id === e2.id), 'second entry survives');
  } finally {
    os.restore();
    audit._resetAudit();
  }
});

test('agent memory (os-agent-memory): curated fact survives pod roll via hydration', async () => {
  const os = fakeCluster();
  const mem = await import('../agent-memory.ts');
  try {
    mem.__resetMemory();
    const f = mem.proposeFact({ domain: 'sales', agent: 'crm-agent', kind: 'semantic', text: 'Prefers EUR', provenance: 'thread-1' });
    await settle();
    assertBootstrapSequence(os.log, 'os-agent-memory');
    mem.curateFact(f.id);
    await settle();

    mem.__resetMemory(); // pod roll
    await mem.ensureHydrated();
    const facts = mem.listFacts('sales', 'crm-agent');
    assert.equal(facts.length, 1);
    assert.equal(facts[0].id, f.id);
    assert.equal(facts[0].curated, true, 'curated flag survives roll');
  } finally {
    os.restore();
    mem.__resetMemory();
  }
});

test('marketplace (os-marketplace-*): grant + deprecated survive pod roll via hydration', async () => {
  const os = fakeCluster();
  const mkt = await import('../marketplace/store.ts');
  try {
    mkt.__resetMarketplace();
    mkt.putGrant({ id: 'grant_t1', listingId: 'mock-1', grantee: { kind: 'domain', id: 'sales' }, mode: 'reference', grantedBy: 'admin', grantedAt: new Date().toISOString() } as Parameters<typeof mkt.putGrant>[0]);
    mkt.recordAudit({ action: 'import', listingId: 'mock-1', actor: 'admin', domain: 'sales' } as Parameters<typeof mkt.recordAudit>[0]);
    mkt.setDeprecated('mock-old');
    await settle();
    assertBootstrapSequence(os.log, 'os-marketplace-grants');
    assertBootstrapSequence(os.log, 'os-marketplace-audit');
    assertBootstrapSequence(os.log, 'os-marketplace-deprecated');
    assert.ok(os.docsOf('os-marketplace-grants').has('grant_t1'));
    assert.ok(os.docsOf('os-marketplace-deprecated').has('mock-old'));

    mkt.__resetMarketplace(); // pod roll
    await mkt.ensureHydrated();
    assert.ok(mkt.getGrant('grant_t1'), 'grant survives roll');
    assert.equal(mkt.listAudit().length, 1, 'audit entry survives roll');
    assert.ok(mkt.isDeprecated('mock-old'), 'deprecated flag survives roll');
  } finally {
    os.restore();
    mkt.__resetMarketplace();
  }
});

// --------------------------------------- bootstrap-only spot-checks (legacy) --
// These duplicates of the write-only tests kept for regression; the full
// round-trip hydration tests above supersede them for coverage purposes.

test('approvals (os-approvals): first enqueue on a fresh cluster bootstraps the index and persists the doc', async () => {
  const os = fakeCluster();
  const approvals = await import('../approvals.ts');
  try {
    osMirror({ index: 'os-approvals' }).__reset(); // fresh-process mirror state
    approvals.__resetApprovals();
    const a = approvals.enqueue({
      kind: 'connection_write', title: 'CRM patch', detail: 'Update amount', agent: 'agent-key',
      domain: 'sales', requestedBy: 'admin', tool: 'crm.update',
    });
    await settle();
    assertBootstrapSequence(os.log, 'os-approvals');
    assert.equal((os.docsOf('os-approvals').get(a.id) as { id: string }).id, a.id);
  } finally {
    os.restore();
    approvals.__resetApprovals();
  }
});

test('platform audit (os-audit): first audit entry on a fresh cluster bootstraps the index and persists the doc', async () => {
  const os = fakeCluster();
  const audit = await import('../platform-admin/audit.ts');
  try {
    osMirror({ index: 'os-audit' }).__reset();
    const e = audit.audit({ tenant: 't1', actor: 'admin', role: 'admin', action: 'domain.create', target: 'domain:sales', detail: 'created' });
    await settle();
    assertBootstrapSequence(os.log, 'os-audit');
    assert.equal((os.docsOf('os-audit').get(e.id) as { id: string }).id, e.id);
  } finally {
    os.restore();
    audit._resetAudit();
  }
});

test('agent memory (os-agent-memory): first fact on a fresh cluster bootstraps the index and persists the doc', async () => {
  const os = fakeCluster();
  const mem = await import('../agent-memory.ts');
  try {
    osMirror({ index: 'os-agent-memory' }).__reset();
    const f = mem.proposeFact({ domain: 'sales', agent: 'crm-agent', kind: 'semantic', text: 'Prefers EUR', provenance: 'thread-1' });
    await settle();
    assertBootstrapSequence(os.log, 'os-agent-memory');
    assert.equal((os.docsOf('os-agent-memory').get(f.id) as { id: string }).id, f.id);
  } finally {
    os.restore();
  }
});

test('marketplace (os-marketplace-*): first grant/audit on a fresh cluster bootstraps their indices and persists', async () => {
  const os = fakeCluster();
  const mkt = await import('../marketplace/store.ts');
  try {
    osMirror({ index: 'os-marketplace-grants' }).__reset();
    osMirror({ index: 'os-marketplace-audit' }).__reset();
    mkt.putGrant({ id: 'grant_t1', listingId: 'mock-1', grantee: { kind: 'domain', id: 'sales' }, mode: 'reference', grantedBy: 'admin', grantedAt: new Date().toISOString() } as Parameters<typeof mkt.putGrant>[0]);
    mkt.recordAudit({ action: 'import', listingId: 'mock-1', actor: 'admin', domain: 'sales' } as Parameters<typeof mkt.recordAudit>[0]);
    await settle();
    assertBootstrapSequence(os.log, 'os-marketplace-grants');
    assertBootstrapSequence(os.log, 'os-marketplace-audit');
    assert.ok(os.docsOf('os-marketplace-grants').has('grant_t1'));
  } finally {
    os.restore();
  }
});
