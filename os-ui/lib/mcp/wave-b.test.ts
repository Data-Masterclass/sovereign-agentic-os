/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/auth';
import { handleRpc, ALL_MCP_TOOLS, type JsonRpcResponse, type ToolError } from './server.ts';
import { ALL_WRITE_TOOLS } from './write-tools.ts';
import { __resetStore as resetData } from '@/lib/data/store';
import { __resetStore as resetAgents } from '@/lib/agents/store';
import { __resetStore as resetFiles } from '@/lib/files/store';
import { __resetDashboards } from '@/lib/dashboards/store';
import { __resetBets, auditLog } from '@/lib/bigbets/store';
import { __resetSources, __resetStrategy, __seedStrategy } from '@/lib/bigbets/sources';
import { __resetApprovals } from '@/lib/approvals';
import { __resetAppsCache } from '@/lib/apps';

/**
 * MCP WAVE B — operate & read-back parity. Seven single-reads (get_metric,
 * get_dashboard, get_big_bet, get_file, read_app_files, get_software_status,
 * list_connection_templates) + two Big-Bet operate writes (attach_component,
 * update_big_bet). Every tool is a THIN wrapper over the same governed lib the
 * UI calls, driven here exactly as an AI client would (over handleRpc), asserting:
 *   • identity is threaded = the CALLER (never a body value),
 *   • governance negatives are TYPED errors (forbidden/not_found/bad_request),
 *   • honesty: restricted text never returned, long content truncated with a
 *     note, offline trees labelled, and NO URL claimed that is not served.
 */

const creator: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };
const builder: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'builder' };
const outsider: CurrentUser = { id: 'dan', name: 'Dan', domains: ['ops'], role: 'creator' };

function resetAll(): void {
  resetData();
  resetAgents();
  resetFiles();
  __resetDashboards();
  __resetBets();
  __resetSources();
  __resetStrategy();
  __resetApprovals();
  __resetAppsCache();
}

async function call(user: CurrentUser, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res && 'result' in res, `expected a result for ${name}`);
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}

function payload<T = Record<string, unknown>>(r: Record<string, unknown>): T {
  assert.notEqual(r.isError, true, `expected success, got: ${(r.content as { text: string }[])[0]?.text}`);
  return JSON.parse((r.content as { text: string }[])[0].text) as T;
}

function errorOf(r: Record<string, unknown>): ToolError {
  assert.equal(r.isError, true, 'expected a typed tool error');
  return (r.structuredContent as { error: ToolError }).error;
}

// ---- REGISTRY INVARIANTS ------------------------------------------------------

const NEW_READ: { name: string; tab: string }[] = [
  { name: 'get_metric', tab: 'metrics' },
  { name: 'get_dashboard', tab: 'dashboards' },
  { name: 'get_big_bet', tab: 'bigbets' },
  { name: 'get_file', tab: 'files' },
  { name: 'read_app_files', tab: 'software' },
  { name: 'get_software_status', tab: 'software' },
  { name: 'list_connection_templates', tab: 'connections' },
];
const NEW_WRITE: { name: string; tab: string }[] = [
  { name: 'attach_component', tab: 'bigbets' },
  { name: 'update_big_bet', tab: 'bigbets' },
];

test('WAVE B registry: every new tool is registered under its tab, exampled, floored at creator, R/W-classified', async () => {
  const byName = new Map(ALL_MCP_TOOLS.map((t) => [t.name, t]));
  const writeNames = new Set(ALL_WRITE_TOOLS.map((t) => t.name));
  for (const { name, tab } of [...NEW_READ, ...NEW_WRITE]) {
    const t = byName.get(name);
    assert.ok(t, `${name} missing from ALL_MCP_TOOLS`);
    assert.equal(t!.tab, tab, `${name} lives under the ${tab} tab`);
    assert.equal(t!.minRole, 'creator', `${name} floors at creator`);
    assert.ok((t!.inputSchema.examples ?? []).length >= 1, `${name} carries ≥1 worked example`);
    assert.ok(t!.description.length > 200, `${name} carries a rich scaffolded description`);
  }
  for (const { name } of NEW_WRITE) assert.ok(writeNames.has(name), `${name} must be in ALL_WRITE_TOOLS`);
  for (const { name } of NEW_READ) assert.ok(!writeNames.has(name), `${name} is read-only, not a write tool`);

  // All visible to a creator via list_capabilities.
  const caps = payload<{ available: { name: string }[] }>(await call(creator, 'list_capabilities'));
  const avail = new Set(caps.available.map((t) => t.name));
  for (const { name } of [...NEW_READ, ...NEW_WRITE]) assert.ok(avail.has(name), `${name} available to a creator`);
});

// ---- GET_METRIC ----------------------------------------------------------------

/** Build a governed gold dataset with a defined metric; returns its metricId. */
async function definedMetric(): Promise<string> {
  const ds = payload(await call(builder, 'create_dataset', { name: 'Orders', columns: [{ name: 'order_id', description: 'PK' }, { name: 'net_amount', description: 'EUR' }] }));
  payload(await call(builder, 'add_dataset_version', { datasetId: ds.id, layer: 'bronze' }));
  payload(await call(builder, 'add_dataset_version', { datasetId: ds.id, layer: 'silver', body: 'select order_id, net_amount from bronze' }));
  payload(await call(builder, 'add_dataset_version', { datasetId: ds.id, layer: 'gold', passThrough: true }));
  payload(await call(builder, 'document_dataset', { datasetId: ds.id, description: 'One row per order.' }));
  const req = payload<{ approvalId: string }>(await call(builder, 'request_promotion', { kind: 'dataset', id: ds.id }));
  payload(await call(builder, 'approve_promotion', { approvalId: req.approvalId }));
  payload(await call(builder, 'define_metric', { datasetId: ds.id, name: 'Revenue', aggregation: 'sum', column: 'net_amount' }));
  return `${ds.id}.revenue`;
}

test('get_metric: reads back the definition, canonical member and Cube YAML define_metric registered', async () => {
  resetAll();
  const metricId = await definedMetric();
  const m = payload<{ id: string; member: string; tier: string; datasetId: string; definition: { aggregation: string; column: string | null; dimensions: string[] }; cube: string }>(
    await call(builder, 'get_metric', { metricId }),
  );
  assert.equal(m.id, metricId);
  assert.match(m.member, /\.revenue$/, 'the ONE canonical member every consumer resolves');
  assert.equal(m.tier, 'domain', 'the promoted dataset lifts the metric to domain tier');
  assert.equal(m.definition.aggregation, 'sum');
  assert.equal(m.definition.column, 'net_amount');
  assert.ok(m.definition.dimensions.includes('order_id'), 'sliceable dimensions = the gold columns');
  assert.match(m.cube, /name: revenue\n\s+type: sum/, 'the generated Cube YAML carries the measure');
});

test('get_metric: unseeable dataset → typed forbidden; garbage id → typed not_found (no leak)', async () => {
  resetAll();
  const metricId = await definedMetric(); // tier asset in `sales`
  const e = errorOf(await call(outsider, 'get_metric', { metricId })); // dan is in `ops`
  assert.equal(e.code, 'forbidden');
  const missing = errorOf(await call(builder, 'get_metric', { metricId: 'ds_nope.revenue' }));
  assert.equal(missing.code, 'not_found');
});

// ---- GET_DASHBOARD -------------------------------------------------------------

test('get_dashboard: reads back the charts + governed members; visibility-scoped like list_dashboards', async () => {
  resetAll();
  const created = payload<{ id: string }>(await call(builder, 'create_dashboard', {
    name: 'Sales Overview',
    view: 'Orders',
    charts: [{ name: 'Total revenue', vizType: 'big_number_total', metric: 'Orders.revenue' }],
  }));
  const d = payload<{ id: string; name: string; view: string; tier: string; owner: string; charts: { metric: string }[] }>(
    await call(builder, 'get_dashboard', { dashboardId: created.id }),
  );
  assert.equal(d.name, 'Sales Overview');
  assert.equal(d.view, 'Orders');
  assert.equal(d.tier, 'personal');
  assert.equal(d.owner, 'ben');
  assert.equal(d.charts[0].metric, 'Orders.revenue', 'each chart carries its governed member');

  // A Personal dashboard is invisible to everyone else — typed forbidden.
  const e = errorOf(await call(outsider, 'get_dashboard', { dashboardId: created.id }));
  assert.equal(e.code, 'forbidden');
  const missing = errorOf(await call(builder, 'get_dashboard', { dashboardId: 'dash_nope' }));
  assert.equal(missing.code, 'not_found');
});

// ---- GET_BIG_BET + the operate writes -------------------------------------------

function seedStrategy(): void {
  __seedStrategy(
    { id: 'metric_nrr', name: 'Net Revenue Retention', cubeMeasure: 'nrr', unit: '€', baseline: 100, current: 150, rls: { ben: 400 } },
    { id: 'pillar_retention', name: 'Retention', scope: 'tenant', metricId: 'metric_nrr' },
  );
}

test('get_big_bet: the full bet card, with the realized value resolved RLS-scoped to THE CALLER', async () => {
  resetAll();
  seedStrategy();
  const bet = payload<{ id: string }>(await call(builder, 'create_big_bet', { problem: 'Churn is rising among SMB accounts', owner: 'ben', solution: 'Outreach', targetValue: 250000 }));

  // Ben's entitled `current` is RLS-overridden to 400 → uplift realized = 300.
  const forBen = payload<{ value: { realized: number }; status: string; pillar: { name: string }; metric: { name: string }; solution: string }>(
    await call(builder, 'get_big_bet', { betId: bet.id }),
  );
  assert.equal(forBen.status, 'active', 'a Builder-created bet is active');
  assert.equal(forBen.solution, 'Outreach');
  assert.equal(forBen.pillar.name, 'Retention');
  assert.equal(forBen.metric.name, 'Net Revenue Retention');
  assert.equal(forBen.value.realized, 300, 'realized value resolved under BEN’s RLS row (400 − 100)');

  // Cara (domain peer, no RLS override) sees the default current → 50.
  const forCara = payload<{ value: { realized: number } }>(await call(creator, 'get_big_bet', { betId: bet.id }));
  assert.equal(forCara.value.realized, 50, 'the SAME bet resolves a different number under Cara’s identity — the viewer is the session caller');
});

test('get_big_bet: out-of-domain viewer → typed forbidden; unknown id → typed not_found', async () => {
  resetAll();
  seedStrategy();
  const bet = payload<{ id: string }>(await call(builder, 'create_big_bet', { problem: 'Sales-domain bet' }));
  const e = errorOf(await call(outsider, 'get_big_bet', { betId: bet.id }));
  assert.equal(e.code, 'forbidden');
  const missing = errorOf(await call(builder, 'get_big_bet', { betId: 'bet_nope' }));
  assert.equal(missing.code, 'not_found');
});

test('attach_component: re-resolves the id through its own canView gate, links AS THE CALLER, and get_big_bet reads it back', async () => {
  resetAll();
  seedStrategy();
  const bet = payload<{ id: string }>(await call(builder, 'create_big_bet', { problem: 'Churn is rising' }));
  const ds = payload<{ id: string }>(await call(builder, 'create_dataset', { name: 'Churn mart' }));
  payload(await call(builder, 'add_dataset_version', { datasetId: ds.id, layer: 'bronze' }));

  const r = payload<{ refId: string; artifactId: string; tab: string; title: string; origin: string }>(
    await call(builder, 'attach_component', { betId: bet.id, kind: 'dataset', id: ds.id, plannedReady: '2026-09-01' }),
  );
  assert.equal(r.artifactId, ds.id, 'the bet references the REAL dataset id — never a copy');
  assert.equal(r.tab, 'data');
  assert.equal(r.title, 'Churn mart');
  assert.equal(r.origin, 'linked');
  assert.equal(auditLog(bet.id)[0].actor, 'ben', 'the link is audited under the SESSION caller');

  const view = payload<{ components: { artifactId: string; status: { derived: string }; artifact: { title: string; lifecycle: string } }[] }>(
    await call(builder, 'get_big_bet', { betId: bet.id }),
  );
  assert.equal(view.components.length, 1);
  assert.equal(view.components[0].artifactId, ds.id);
  assert.equal(view.components[0].artifact.title, 'Churn mart');
  assert.equal(view.components[0].artifact.lifecycle, 'building', 'lifecycle mirrors the real store (bronze built, not promoted)');
  assert.equal(view.components[0].status.derived, 'in-progress', 'progress is DERIVED from the artifact, never hand-set');
});

test('attach_component: a creator can grow their own DRAFT; dashboards and agent systems attach through the same gates', async () => {
  resetAll();
  seedStrategy();
  const bet = payload<{ id: string; status: string }>(await call(creator, 'create_big_bet', { problem: 'Cara’s draft initiative' }));
  assert.equal(bet.status, 'draft');
  const dash = payload<{ id: string }>(await call(creator, 'create_dashboard', { name: 'My view', view: 'Orders', charts: [{ name: 'N', vizType: 'line', metric: 'Orders.n' }] }));
  const sys = payload<{ id: string }>(await call(creator, 'create_agent_system', { name: 'My triage', template: 'analyze' }));

  const d = payload<{ tab: string }>(await call(creator, 'attach_component', { betId: bet.id, kind: 'dashboard', id: dash.id }));
  assert.equal(d.tab, 'dashboard');
  const a = payload<{ tab: string }>(await call(creator, 'attach_component', { betId: bet.id, kind: 'agent-system', id: sys.id }));
  assert.equal(a.tab, 'agent');

  const view = payload<{ components: unknown[] }>(await call(creator, 'get_big_bet', { betId: bet.id }));
  assert.equal(view.components.length, 2);
});

test('attach_component: a forged id → typed not_found; an unseen component → typed forbidden; a non-editor → typed forbidden', async () => {
  resetAll();
  seedStrategy();
  const bet = payload<{ id: string }>(await call(builder, 'create_big_bet', { problem: 'Churn is rising' }));

  // Forged id: nothing is attached, the error is typed.
  const forged = errorOf(await call(builder, 'attach_component', { betId: bet.id, kind: 'dataset', id: 'ds_forged' }));
  assert.equal(forged.code, 'not_found');

  // A component the caller cannot SEE (Dan's personal dataset in ops) → forbidden.
  const secret = payload<{ id: string }>(await call(outsider, 'create_dataset', { name: 'Dan secret' }));
  const unseen = errorOf(await call(builder, 'attach_component', { betId: bet.id, kind: 'dataset', id: secret.id }));
  assert.equal(unseen.code, 'forbidden', 'canView is re-checked per component — never attach unseen components');

  // A domain peer who may VIEW but not EDIT the bet → forbidden before any side effect.
  const ownDs = payload<{ id: string }>(await call(creator, 'create_dataset', { name: 'Cara set' }));
  const noEdit = errorOf(await call(creator, 'attach_component', { betId: bet.id, kind: 'dataset', id: ownDs.id }));
  assert.equal(noEdit.code, 'forbidden');
  const view = payload<{ components: unknown[] }>(await call(builder, 'get_big_bet', { betId: bet.id }));
  assert.equal(view.components.length, 0, 'nothing was attached by any denied call');
});

test('update_big_bet: the owner updates solution/status/realized value through the store’s own gate; honesty note on basis', async () => {
  resetAll();
  seedStrategy();
  const bet = payload<{ id: string }>(await call(builder, 'create_big_bet', { problem: 'Churn is rising', targetValue: 250000 }));

  // Realized value under the default uplift basis → the response says it won't count yet.
  const first = payload<{ ownerDeclaredValue: number; valueBasis: string; note?: string }>(
    await call(builder, 'update_big_bet', { betId: bet.id, solution: 'Health-score outreach', realizedValue: 120000 }),
  );
  assert.equal(first.ownerDeclaredValue, 120000);
  assert.equal(first.valueBasis, 'uplift');
  assert.match(first.note ?? '', /owner-declared/, 'the honesty note names the basis mismatch');

  // Switch the basis → the declared value now resolves as the bet's realized value.
  payload(await call(builder, 'update_big_bet', { betId: bet.id, valueBasis: 'owner-declared', status: 'shipped' }));
  const view = payload<{ status: string; solution: string; value: { realized: number; basis: string } }>(
    await call(builder, 'get_big_bet', { betId: bet.id }),
  );
  assert.equal(view.status, 'shipped');
  assert.equal(view.solution, 'Health-score outreach');
  assert.equal(view.value.basis, 'owner-declared');
  assert.equal(view.value.realized, 120000, 'the declared value reads back through the same value model as the UI');
});

test('update_big_bet: a non-editor → typed forbidden; an empty patch → typed bad_request; unknown → not_found', async () => {
  resetAll();
  seedStrategy();
  const bet = payload<{ id: string }>(await call(builder, 'create_big_bet', { problem: 'Sales bet' }));
  const peer = errorOf(await call(creator, 'update_big_bet', { betId: bet.id, status: 'archived' }));
  assert.equal(peer.code, 'forbidden', 'a domain peer may view but not edit — the store’s own gate, no new floors');
  const empty = errorOf(await call(builder, 'update_big_bet', { betId: bet.id }));
  assert.equal(empty.code, 'bad_request');
  const missing = errorOf(await call(builder, 'update_big_bet', { betId: 'bet_nope', status: 'active' }));
  assert.equal(missing.code, 'not_found');
});

// ---- GET_FILE -------------------------------------------------------------------

test('get_file: metadata + extracted text for an entitled caller; long text truncated with an honest note', async () => {
  resetAll();
  const up = payload<{ id: string }>(await call(creator, 'upload_file', {
    name: 'refund-policy.md', folder: 'policies', text: 'Refunds are processed within 5 days.',
    tags: ['policy'], description: 'Customer refund policy', sensitivity: 'internal',
  }));
  const f = payload<{ name: string; tags: string[]; description: string; sensitivity: string; text: string; textNote: string | null }>(
    await call(creator, 'get_file', { fileId: up.id }),
  );
  assert.equal(f.name, 'refund-policy.md');
  assert.deepEqual(f.tags, ['policy']);
  assert.equal(f.description, 'Customer refund policy');
  assert.equal(f.text, 'Refunds are processed within 5 days.');
  assert.equal(f.textNote, null, 'short text is complete — no note');

  const long = payload<{ id: string }>(await call(creator, 'upload_file', { name: 'big.txt', text: 'x'.repeat(20000) }));
  const lf = payload<{ text: string; textNote: string }>(await call(creator, 'get_file', { fileId: long.id }));
  assert.equal(lf.text.length, 8000, 'truncated at the cap');
  assert.match(lf.textNote, /first 8000 of 20000/, 'the truncation is stated, never silent');
});

test('get_file: a restricted file returns metadata but NEVER the text; an unentitled caller → typed forbidden', async () => {
  resetAll();
  const up = payload<{ id: string }>(await call(creator, 'upload_file', {
    name: 'salaries.xlsx', text: 'THE SECRET SALARY TABLE', sensitivity: 'restricted', tags: ['hr'],
  }));
  const f = payload<{ sensitivity: string; indexing: string; text: string | null; textNote: string }>(
    await call(creator, 'get_file', { fileId: up.id }),
  );
  assert.equal(f.sensitivity, 'restricted');
  assert.equal(f.indexing, 'stored-only', 'restricted ⇒ stored, not indexed');
  assert.equal(f.text, null, 'the text is NEVER returned — even to the owner');
  assert.match(f.textNote, /restricted/, 'the reason is stated');

  const e = errorOf(await call(outsider, 'get_file', { fileId: up.id }));
  assert.equal(e.code, 'forbidden', 'the DLS entitlement gate holds');
  const missing = errorOf(await call(creator, 'get_file', { fileId: 'as_nope' }));
  assert.equal(missing.code, 'not_found');
});

// ---- READ_APP_FILES + GET_SOFTWARE_STATUS ----------------------------------------

test('read_app_files: the committed tree + one file’s content, honestly labelled offline-mock without a cluster', async () => {
  resetAll();
  const app = payload<{ id: string }>(await call(builder, 'create_software', { name: 'Renewals', template: 'nextjs-supabase' }));

  const tree = payload<{ mode: string; files: string[]; note: string }>(await call(builder, 'read_app_files', { appId: app.id }));
  assert.equal(tree.mode, 'offline-mock', 'no Forgejo in tests — the mode is honestly labelled');
  assert.ok(tree.files.includes('app.yaml') && tree.files.includes('Dockerfile'), 'the template seed tree is visible');
  assert.ok(tree.note.length > 0, 'the offline source is stated');

  const file = payload<{ path: string; content: string; contentNote: string | null }>(
    await call(builder, 'read_app_files', { appId: app.id, path: 'app.yaml' }),
  );
  assert.equal(file.path, 'app.yaml');
  assert.match(file.content, /Renewals/, 'the real committed content comes back');
  assert.equal(file.contentNote, null);

  const missing = errorOf(await call(builder, 'read_app_files', { appId: app.id, path: 'nope.ts' }));
  assert.equal(missing.code, 'not_found');
});

test('read_app_files: an app the caller cannot see → typed not_found (no existence leak)', async () => {
  resetAll();
  const app = payload<{ id: string }>(await call(builder, 'create_software', { name: 'Ben private' }));
  const e = errorOf(await call(outsider, 'read_app_files', { appId: app.id }));
  assert.equal(e.code, 'not_found', 'a Personal app is invisible — unseeable == unknown');
});

test('get_software_status: one honest card — NO preview/live URL is ever claimed that is not actually served', async () => {
  resetAll();
  const app = payload<{ id: string }>(await call(builder, 'create_software', { name: 'Renewals' }));

  const fresh = payload<{ preview: { state: string; url: string | null; note?: string }; deploy: { state: string; liveUrl: string | null; review: unknown; releases: number }; build: { pipeline: Record<string, string>; repo: string } }>(
    await call(builder, 'get_software_status', { appId: app.id }),
  );
  assert.equal(fresh.preview.state, 'building');
  assert.equal(fresh.preview.url, null, 'no runner → no URL, never fabricated');
  assert.match(fresh.preview.note ?? '', /pending/i, 'the pending runner is SAID');
  assert.equal(fresh.deploy.liveUrl, null);
  assert.equal(fresh.deploy.review, null, 'no review has been requested yet');
  assert.equal(fresh.deploy.releases, 0);
  assert.equal(fresh.build.pipeline.forgejo, 'offline', 'the pipeline states reflect reachability, not a sham');

  // Start a preview → the state moves, but the URL stays honestly null (Phase 1).
  payload(await call(builder, 'start_preview', { appId: app.id }));
  const previewing = payload<{ preview: { state: string; url: string | null } }>(await call(builder, 'get_software_status', { appId: app.id }));
  assert.equal(previewing.preview.state, 'preview');
  assert.equal(previewing.preview.url, null, 'previewing ≠ served — no URL claimed');

  const e = errorOf(await call(outsider, 'get_software_status', { appId: app.id }));
  assert.equal(e.code, 'not_found');
});

// ---- LIST_CONNECTION_TEMPLATES ----------------------------------------------------

test('list_connection_templates: the catalog from the SAME registry create_connection validates against', async () => {
  const r = payload<{ templates: { key: string; personal: boolean; minRoleToCreate: string; requiredFields: string[]; tools: { name: string; mode: string }[] }[]; note: string }>(
    await call(creator, 'list_connection_templates'),
  );
  assert.equal(r.templates.length, 10, 'the full template catalog');

  // ONE source of truth: exactly the keys the create_connection schema accepts.
  const createTool = ALL_MCP_TOOLS.find((t) => t.name === 'create_connection')!;
  const accepted = ((createTool.inputSchema.properties.template as { enum: string[] }).enum ?? []).slice().sort();
  assert.deepEqual(r.templates.map((t) => t.key).sort(), accepted, 'catalog keys === create_connection’s accepted keys');

  const gdrive = r.templates.find((t) => t.key === 'gdrive')!;
  assert.equal(gdrive.personal, true, 'per-user OAuth → any user may connect');
  assert.equal(gdrive.minRoleToCreate, 'creator');
  const notion = r.templates.find((t) => t.key === 'notion-mcp')!;
  assert.equal(notion.personal, false, 'service credentials → Builder/Admin');
  assert.equal(notion.minRoleToCreate, 'builder');
  assert.ok(notion.requiredFields.includes('name') && notion.requiredFields.includes('template'));
  assert.ok(notion.tools.some((t) => t.mode === 'Blocked'), 'the safe preset profile is stated (deletes blocked)');
});
