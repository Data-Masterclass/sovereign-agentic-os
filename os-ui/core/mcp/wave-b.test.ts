/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { handleRpc, ALL_MCP_TOOLS, type JsonRpcResponse, type ToolError } from '@core/mcp/server';
import { ALL_WRITE_TOOLS } from '@core/mcp/write-tools';
import { __resetStore as resetData } from '@tabs/data/lib/store';
import { __resetStore as resetAgents } from '@tabs/agents/lib/store';
import { __resetStore as resetFiles } from '@tabs/files/lib/store';
import { __resetDashboards } from '@tabs/dashboards/lib/store';
import { __resetApprovals } from '@core/policy/approvals';
import { __resetAppsCache } from '@tabs/software/lib/apps';

/**
 * MCP WAVE B — operate & read-back parity. Six single-reads (get_metric,
 * get_dashboard, get_file, read_app_files, get_software_status,
 * list_connection_templates). Every tool is a THIN wrapper over the same governed lib the
 * UI calls, driven here exactly as an AI client would (over handleRpc), asserting:
 *   • identity is threaded = the CALLER (never a body value),
 *   • governance negatives are TYPED errors (forbidden/not_found/bad_request),
 *   • honesty: restricted text never returned, long content truncated with a
 *     note, offline trees labelled, and NO URL claimed that is not served.
 */

const creator: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };
// Ben is a domain_admin: rung-1 Personal→Shared approval (approve_promotion) now needs domain_admin+.
const builder: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'domain_admin' };
const outsider: CurrentUser = { id: 'dan', name: 'Dan', domains: ['ops'], role: 'creator' };

function resetAll(): void {
  resetData();
  resetAgents();
  resetFiles();
  __resetDashboards();
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
  { name: 'get_file', tab: 'files' },
  { name: 'read_app_files', tab: 'software' },
  { name: 'get_software_status', tab: 'software' },
  { name: 'list_connection_templates', tab: 'connections' },
];
const NEW_WRITE: { name: string; tab: string }[] = [];

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

test('get_metric: reads back the definition, canonical member and the metric YAML define_metric registered', async () => {
  resetAll();
  const metricId = await definedMetric();
  const m = payload<{ id: string; member: string; tier: string; datasetId: string; definition: { aggregation: string; column: string | null; dimensions: string[] }; definitionYaml: string }>(
    await call(builder, 'get_metric', { metricId }),
  );
  assert.equal(m.id, metricId);
  assert.match(m.member, /\.revenue$/, 'the ONE canonical member every consumer resolves');
  assert.equal(m.tier, 'domain', 'the promoted dataset lifts the metric to domain tier');
  assert.equal(m.definition.aggregation, 'sum');
  assert.equal(m.definition.column, 'net_amount');
  assert.ok(m.definition.dimensions.includes('order_id'), 'sliceable dimensions = the gold columns');
  assert.match(m.definitionYaml, /name: revenue\n\s+type: sum/, 'the generated metric YAML carries the measure');
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
  assert.equal(tree.mode, 'offline-mock', 'no live tree in tests — the mode is honestly labelled');
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

test('read_app_files: a DIRECTORY path returns its listing (not the "not an editable file" dead end)', async () => {
  resetAll();
  // The build agent passed a directory path (src/epics) live and hit a dead-end 400.
  // A directory must now return its entries so the agent can drill down, not fail.
  const app = payload<{ id: string }>(await call(builder, 'create_software', { name: 'Dir listing', template: 'sovereign-app' }));

  const dir = payload<{ mode: string; path: string; kind: string; entries: { name: string; path: string; type: string }[] }>(
    await call(builder, 'read_app_files', { appId: app.id, path: 'src/template' }),
  );
  assert.equal(dir.kind, 'dir', 'a directory path is reported as a directory, not an error');
  assert.equal(dir.path, 'src/template');
  const names = dir.entries.map((e) => e.name);
  // Immediate children only (files AND subdirs), never the whole recursive tree.
  assert.ok(names.includes('shell.tsx'), 'a file child is listed');
  assert.ok(names.includes('pages'), 'a subdirectory child is listed');
  const pages = dir.entries.find((e) => e.name === 'pages');
  assert.equal(pages?.type, 'dir', 'a subdirectory is typed dir');
  assert.equal(dir.entries.find((e) => e.name === 'shell.tsx')?.type, 'file');
  // A trailing slash resolves to the same directory.
  const withSlash = payload<{ kind: string }>(await call(builder, 'read_app_files', { appId: app.id, path: 'src/template/' }));
  assert.equal(withSlash.kind, 'dir');
});

test('read_app_files: an empty/no path returns the ROOT file tree (unchanged behavior)', async () => {
  resetAll();
  const app = payload<{ id: string }>(await call(builder, 'create_software', { name: 'Root tree', template: 'sovereign-app' }));
  const tree = payload<{ files: string[] }>(await call(builder, 'read_app_files', { appId: app.id, path: '' }));
  assert.ok(Array.isArray(tree.files) && tree.files.length > 0, 'empty path → the whole tree, not an error');
});

test('read_app_files: an app the caller cannot see → typed not_found (no existence leak)', async () => {
  resetAll();
  const app = payload<{ id: string }>(await call(builder, 'create_software', { name: 'Ben private' }));
  const e = errorOf(await call(outsider, 'read_app_files', { appId: app.id }));
  assert.equal(e.code, 'not_found', 'a Personal app is invisible — unseeable == unknown');
});

test('get_software_status: one honest card — NO preview/live URL is ever claimed that is not actually served', async () => {
  resetAll();
  // This card exercises the CODED (image) pipeline status — create a coded app explicitly
  // (declarative is the default now; coded apps are enabled process-wide by the test harness).
  const app = payload<{ id: string }>(await call(builder, 'create_software', { name: 'Renewals', kind: 'code' }));

  const fresh = payload<{ preview: { state: string; url: string | null; note?: string }; deploy: { state: string; liveUrl: string | null; review: unknown; releases: number }; build: { lastCommit: unknown; updatedAt: string } }>(
    await call(builder, 'get_software_status', { appId: app.id }),
  );
  assert.equal(fresh.preview.state, 'building');
  assert.equal(fresh.preview.url, null, 'no runner → no URL, never fabricated');
  assert.match(fresh.preview.note ?? '', /pending/i, 'the pending runner is SAID');
  assert.equal(fresh.deploy.liveUrl, null);
  assert.equal(fresh.deploy.review, null, 'no review has been requested yet');
  assert.equal(fresh.deploy.releases, 0);
  assert.equal(fresh.build.lastCommit, null, 'a fresh app has no governed commit yet');

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
  // Flag-off default: the external-warehouse template is hidden
  // (EXTERNAL_CONNECTORS_ENABLED off), so the catalog
  // is the user-facing templates (gdrive, onedrive, notion-mcp, airflow, github,
  // supabase, atlassian, salesforce-api, kajabi-api, sap-odata, odata-v4,
  // workday-raas, slack, gmail, gcal, outlook, teams, entra, purview, ai-foundry,
  // sagemaker, gcp-identity, gcp-directory, snowflake-governance, generic-api,
  // generic-mcp) + the `database` internal building block — warehouse does NOT appear.
  assert.equal(r.templates.length, 27, 'the full template catalog (every template except the flag-gated warehouse)');
  assert.ok(!r.templates.some((t) => t.key === 'warehouse'), 'warehouse hidden when external connectors are off');

  // ONE source of truth: the listed keys are exactly the keys create_connection accepts
  // in THIS deployment — its enum minus the flag-gated `warehouse`
  // (rejected flag-off, so hidden from the catalog too).
  const createTool = ALL_MCP_TOOLS.find((t) => t.name === 'create_connection')!;
  const accepted = ((createTool.inputSchema.properties.template as { enum: string[] }).enum ?? [])
    .filter((k) => k !== 'warehouse')
    .slice()
    .sort();
  assert.deepEqual(r.templates.map((t) => t.key).sort(), accepted, 'catalog keys === create_connection’s accepted keys (flag-off)');

  const gdrive = r.templates.find((t) => t.key === 'gdrive')!;
  assert.equal(gdrive.personal, true, 'per-user OAuth → any user may connect');
  assert.equal(gdrive.minRoleToCreate, 'creator');
  const notion = r.templates.find((t) => t.key === 'notion-mcp')!;
  assert.equal(notion.personal, true, 'Notion connects via per-user hosted-MCP OAuth → any user may connect their own workspace');
  assert.equal(notion.minRoleToCreate, 'creator');
  assert.ok(notion.requiredFields.includes('name') && notion.requiredFields.includes('template'));
  assert.ok(notion.tools.some((t) => t.mode === 'Blocked'), 'the safe preset profile is stated (deletes blocked)');
});

// ---- SET_APP_DESIGN + create_software(purpose) + get_software/list_software shape -------

test('create_software: optional purpose is persisted; get_software and list_software expose purpose/epics/grants', async () => {
  resetAll();
  // create_software now accepts an optional purpose at creation time.
  const app = payload<{ id: string; purpose: string; epics: unknown[]; grants: Record<string, unknown> }>(
    await call(builder, 'create_software', { name: 'Support Tracker', purpose: 'Track and resolve customer tickets.' }),
  );
  assert.equal(app.purpose, 'Track and resolve customer tickets.', 'purpose is persisted at creation');
  assert.deepEqual(app.epics, [], 'epics default to empty array');
  assert.ok(app.grants && typeof app.grants === 'object', 'grants is present');

  // get_software: includes purpose/epics/grants (safe, no secret material).
  const got = payload<{ id: string; purpose: string; epics: unknown[]; grants: Record<string, unknown[]> }>(
    await call(builder, 'get_software', { appId: app.id }),
  );
  assert.equal(got.purpose, 'Track and resolve customer tickets.');
  assert.deepEqual(got.epics, []);
  assert.ok('connections' in got.grants && 'data' in got.grants, 'grants has all five kinds');
  assert.deepEqual(got.grants.connections, [], 'grants are empty by default');

  // list_software: shaped response includes purpose/epics/grants.
  const list = payload<Array<{ id: string; purpose: string; epics: unknown[]; grants: Record<string, unknown[]> }>>(
    await call(builder, 'list_software'),
  );
  const found = list.find((a) => a.id === app.id);
  assert.ok(found, 'the new app appears in list_software');
  assert.equal(found!.purpose, 'Track and resolve customer tickets.');
  assert.deepEqual(found!.epics, []);
  assert.ok('data' in found!.grants, 'list_software grants has all five kinds');
});

test('set_app_design: purpose, epics, grants — governed via patchAppDesign (owner only)', async () => {
  resetAll();
  const app = payload<{ id: string; purpose: string; epics: unknown[]; grants: Record<string, unknown[]> }>(
    await call(builder, 'create_software', { name: 'Design Test App' }),
  );

  // Set purpose only — epics/grants untouched.
  const afterPurpose = payload<{ purpose: string; epics: unknown[]; grants: Record<string, unknown[]> }>(
    await call(builder, 'set_app_design', { appId: app.id, purpose: 'Help agents triage tickets.' }),
  );
  assert.equal(afterPurpose.purpose, 'Help agents triage tickets.');
  assert.deepEqual(afterPurpose.epics, [], 'epics untouched');

  // Set epics + a story.
  const epic = {
    id: 'epic_1',
    title: 'Ticket triage',
    description: 'Auto-prioritise tickets',
    requirements: { technical: 'ML', ux: 'Inbox view', governance: 'No PII in logs' },
    stories: [{ id: 'story_1', title: 'Auto-label', asA: 'Agent', iWant: 'labelling', soThat: 'faster triage', acceptance: 'Label within 5 s' }],
  };
  const afterEpics = payload<{ epics: typeof epic[] }>(
    await call(builder, 'set_app_design', { appId: app.id, epics: [epic] }),
  );
  assert.equal(afterEpics.epics.length, 1, 'epic was persisted');
  assert.equal(afterEpics.epics[0].title, 'Ticket triage');
  assert.equal(afterEpics.epics[0].stories[0].id, 'story_1');

  // Set grants (capability metadata only — no raw credentials).
  const afterGrants = payload<{ grants: Record<string, Array<{ id: string; access: string }>> }>(
    await call(builder, 'set_app_design', {
      appId: app.id,
      grants: { connections: [{ id: 'conn_abc', access: 'read-only' }], data: [], knowledge: [], files: [], metrics: [] },
    }),
  );
  assert.equal(afterGrants.grants.connections.length, 1, 'connection grant was recorded');
  assert.equal(afterGrants.grants.connections[0].id, 'conn_abc');
  assert.equal(afterGrants.grants.connections[0].access, 'read-only');
  assert.deepEqual(afterGrants.grants.data, [], 'other kinds unchanged');

  // Governance: outsider cannot edit another user's personal app (invisible → not_found,
  // consistent with get_software behaviour — no existence leak).
  const e = errorOf(await call(outsider, 'set_app_design', { appId: app.id, purpose: 'hacked' }));
  assert.equal(e.code, 'not_found', 'governance gate holds — personal app is invisible to outsider (no existence leak)');
});
