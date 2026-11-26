/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Resource grants enforced at run time — the registry ratchet and the rule itself
 * USER STORY: As the owner I want a new tool to fail the suite until someone has said which
 *             granted resource it touches, so resource grants cannot be forgotten for it.
 * ARCHITECTURE:
 *   - THE RATCHET: every tool in `ALL_MCP_TOOLS` is in exactly one of `TOOL_RESOURCES` (it names,
 *     lists, searches or creates a grantable resource) or `NO_GRANTED_RESOURCE` (it does not, with
 *     the reason). A NEW tool fails here until someone reads its arguments and classifies it; a
 *     tool whose schema carries a resource id cannot be parked in the "touches nothing" table.
 *   - THE RULE: `checkGrantScope` against hand-built scopes, with in-memory resolvers.
 *   - LIMIT: this is `ALL_MCP_TOOLS` as registered in the test environment — a bundle behind a
 *     feature flag that is off here is not in it (the executor refuses an unclassified tool).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_MCP_TOOLS } from '@core/mcp/server';
import { parseSystem, type System } from '@tabs/agents/lib/system-schema';
import { allToolsForKind } from '@tabs/agents/lib/capability-tools';
import {
  checkGrantScope,
  createdFromSteps,
  createdIds,
  grantScopeBrief,
  grantScopeOf,
  NO_GRANTED_RESOURCE,
  RESOURCE_KINDS,
  TOOL_RESOURCES,
  type GrantResolvers,
  type GrantVerdict,
} from '@tabs/agents/lib/build/grant-scope';

// ------------------------------------------------------------- the ratchet --

test('REGISTRY RATCHET: every MCP tool is classified for resource grants — in the map, or in the "touches none" table with a reason', () => {
  const registry = ALL_MCP_TOOLS.map((t) => t.name);
  const unplaced = registry.filter((n) => !(n in TOOL_RESOURCES) && !(n in NO_GRANTED_RESOURCE));
  assert.deepEqual(unplaced, [], 'a NEW tool: read its arguments, then add it to TOOL_RESOURCES (it names / lists / creates a dataset, knowledge item, metric, connection, file or plan item) or to NO_GRANTED_RESOURCE with the reason — tabs/agents/lib/build/grant-scope.ts');
  const both = registry.filter((n) => n in TOOL_RESOURCES && n in NO_GRANTED_RESOURCE);
  assert.deepEqual(both, [], 'a tool sits in both tables');
  // The other direction: nothing listed that the registry no longer has (a stale line hides a rename).
  const known = new Set(registry);
  assert.deepEqual(Object.keys(TOOL_RESOURCES).filter((n) => !known.has(n)), [], 'TOOL_RESOURCES names a tool that is not registered');
  assert.deepEqual(Object.keys(NO_GRANTED_RESOURCE).filter((n) => !known.has(n)), [], 'NO_GRANTED_RESOURCE names a tool that is not registered');
  for (const [name, why] of Object.entries(NO_GRANTED_RESOURCE)) assert.ok(why.length > 30, `${name} must say WHY it touches no granted resource`);
});

test('REGISTRY RATCHET: every argument a rule names exists in that tool\'s input schema', () => {
  const props = new Map(ALL_MCP_TOOLS.map((t) => [t.name, Object.keys(((t.inputSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {})]));
  for (const [name, rule] of Object.entries(TOOL_RESOURCES)) {
    const has = new Set(props.get(name) ?? []);
    const named = [
      ...(rule.ids ?? []).map((t) => t.arg.split('[].')[0]),
      ...(rule.kindId ? [rule.kindId.kindArg, rule.kindId.idArg] : []),
      ...(rule.ref ? [rule.ref.arg] : []),
      ...(rule.planScope ? [rule.planScope.arg] : []),
      ...(rule.folderWrite ? [rule.folderWrite.arg] : []),
      ...(rule.sql ? [rule.sql.arg] : []),
    ];
    for (const arg of named) assert.ok(has.has(arg), `${name}: the rule names argument '${arg}', which the tool does not declare (${[...has].join(', ')})`);
    const acts = !!(rule.ids?.length || rule.kindId || rule.ref || rule.planScope || rule.folderWrite || rule.sql || rule.filter || rule.creates?.length || rule.broad);
    assert.ok(acts, `${name}: an empty rule — put the tool in NO_GRANTED_RESOURCE with a reason instead`);
  }
});

test('REGISTRY RATCHET: an argument that carries a resource id is always checked — it cannot hide in the "touches none" table', () => {
  // The id argument names the registry uses for the grantable kinds. A tool that declares one
  // must check it (or be `broad`, which refuses the whole tool under a restriction).
  const ID_ARGS: Record<string, string> = { datasetId: 'data', workflowId: 'workflows', metricId: 'metrics', connId: 'connections', connectionId: 'connections', fileId: 'files' };
  for (const t of ALL_MCP_TOOLS) {
    const declared = Object.keys(((t.inputSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {});
    for (const arg of declared) {
      const kind = ID_ARGS[arg];
      if (!kind) continue;
      const rule = TOOL_RESOURCES[t.name];
      assert.ok(rule, `${t.name} takes '${arg}' (a ${kind} id) but is not in TOOL_RESOURCES`);
      const checked = (rule.ids ?? []).some((i) => i.arg === arg && i.kind === kind) || !!rule.broad;
      assert.ok(checked, `${t.name}: '${arg}' names a ${kind} resource and is not checked`);
    }
  }
});

test('REGISTRY RATCHET: every tool the builder provisions for a resource grant is in the map', () => {
  const known = new Set(ALL_MCP_TOOLS.map((t) => t.name));
  for (const kind of RESOURCE_KINDS) {
    for (const tool of allToolsForKind(kind)) {
      if (!known.has(tool)) continue; // flag-gated tools the test registry does not hold
      assert.ok(tool in TOOL_RESOURCES || tool === 'list_connection_templates', `${tool} is provisioned for a ${kind} grant but is not checked against it`);
    }
  }
});

// ---------------------------------------------------------------- the rule --

function system(grants: Record<string, unknown>): System {
  return parseSystem({
    version: '1',
    system: { name: 'T', domain: 'sales', visibility: 'Personal' },
    entrypoint: 'a',
    grants: { tools: [], ...grants },
    agents: [{ id: 'a', role: 'agent', agent_md: '', memory_md: '' }],
  });
}

const RESOLVERS: GrantResolvers = {
  fileLocations: async () => [
    { id: 'f_inv1', folder: '/Invoices', lane: 'personal' },
    { id: 'f_inv2', folder: '/Invoices/2026/Q1', lane: 'personal' },
    { id: 'f_hr', folder: '/HR', lane: 'personal' },
    { id: 'f_dom', folder: '/Invoices', lane: 'domain' },
    { id: 'f_out', folder: '/Reports', lane: 'personal' },
  ],
  datasetTables: async (id) =>
    id === 'ds_orders' ? ['iceberg.sales.gold_orders', 'iceberg.sales.silver_orders'] : id === 'ds_new' ? ['iceberg.personal_u1.bronze_new'] : [],
};

const check = (tool: string, args: Record<string, unknown>, sys: System) => checkGrantScope(tool, args, grantScopeOf(sys), RESOLVERS);
const reason = (v: GrantVerdict): string => (v.allow ? '' : v.refusal.reason);

test('an id outside the grants is refused with a typed forbidden naming the kind and the id; a granted id passes', async () => {
  const sys = system({ data: [{ id: 'ds_orders', capability: 'Read' }] });
  assert.equal((await check('get_dataset', { datasetId: 'ds_orders' }, sys)).allow, true);
  const no = await check('get_dataset', { datasetId: 'ds_salaries' }, sys);
  assert.equal(no.allow, false);
  if (!no.allow) {
    assert.equal(no.refusal.code, 'forbidden');
    assert.equal(no.refusal.kind, 'data');
    assert.equal(no.refusal.id, 'ds_salaries');
    assert.match(no.refusal.reason, /This agent is not granted dataset ds_salaries\. It may use: ds_orders\./);
  }
});

test('EMPTY GRANTS: a kind with no grant is not restricted — and only that kind', async () => {
  const none = system({});
  assert.equal((await check('get_dataset', { datasetId: 'ds_anything' }, none)).allow, true);
  assert.equal((await check('get_file', { fileId: 'f_hr' }, none)).allow, true);
  assert.equal((await check('query_data', { sql: 'select * from iceberg.hr.gold_salaries' }, none)).allow, true);
  // A data grant restricts DATA; knowledge stays on the running user's own access.
  const dataOnly = system({ data: [{ id: 'ds_orders', capability: 'Read' }] });
  assert.equal((await check('get_knowledge', { workflowId: 'wf_any' }, dataOnly)).allow, true);
  assert.equal((await check('get_dataset', { datasetId: 'ds_other' }, dataOnly)).allow, false);
});

test('an id switched Off is refused even when the kind is otherwise unrestricted', async () => {
  const sys = system({ knowledge: [{ id: 'wf_secret', capability: 'Off' }] });
  assert.match(reason(await check('get_knowledge', { workflowId: 'wf_secret' }, sys)), /switched off/);
  assert.equal((await check('get_knowledge', { workflowId: 'wf_other' }, sys)).allow, true);
});

test('a switched-off id is taken out of a search without restricting the rest of the kind', async () => {
  const v = await check('search_knowledge', { query: 'x' }, system({ knowledge: [{ id: 'wf_secret', capability: 'Off' }] }));
  assert.ok(v.allow && v.shape);
  const out = v.allow && v.shape ? v.shape(JSON.stringify({ hits: [
    { unit: { id: 'u1', provenance: { workflowId: 'wf_secret' } } },
    { unit: { id: 'u2', provenance: { workflowId: 'wf_other' } } },
    { unit: { id: 'u3', provenance: { workflowId: null } } },
  ] })) : null;
  assert.deepEqual(JSON.parse((out as { text: string }).text).hits.map((h: { unit: { id: string } }) => h.unit.id), ['u2', 'u3']);
});

test('CAPABILITY: a Read grant refuses writes on that resource; a write grant allows them', async () => {
  const sys = system({ data: [{ id: 'ds_orders', capability: 'Read' }, { id: 'ds_stage', capability: 'Write-bounded' }, { id: 'ds_held', capability: 'Write-approval' }] });
  assert.match(reason(await check('ingest_dataset', { datasetId: 'ds_orders', content: 'a,b' }, sys)), /granted dataset ds_orders read-only — it may not change it/);
  assert.equal((await check('ingest_dataset', { datasetId: 'ds_stage', content: 'a,b' }, sys)).allow, true);
  assert.equal((await check('ingest_dataset', { datasetId: 'ds_held', content: 'a,b' }, sys)).allow, true);
  // A join writes its target and READS its sources: a read-only source is fine, an ungranted one is not.
  assert.equal((await check('build_gold_join', { datasetId: 'ds_stage', picks: [{ datasetId: 'ds_orders' }] }, sys)).allow, true);
  assert.match(reason(await check('build_gold_join', { datasetId: 'ds_stage', picks: [{ datasetId: 'ds_orders' }, { datasetId: 'ds_hr' }] }, sys)), /not granted dataset ds_hr/);
  assert.match(reason(await check('build_gold_join', { datasetId: 'ds_orders', picks: [] }, sys)), /read-only/);
});

test('FILES: a folder grant covers its subfolders in its own lane, and nothing else', async () => {
  const sys = system({ files: [{ folder: { path: '/Invoices', scope: 'personal' }, capability: 'Read' }] });
  assert.equal((await check('get_file', { fileId: 'f_inv1' }, sys)).allow, true);
  assert.equal((await check('get_file', { fileId: 'f_inv2' }, sys)).allow, true, 'a subfolder is covered');
  assert.match(reason(await check('get_file', { fileId: 'f_hr' }, sys)), /not granted file f_hr\. It may use files in: \/Invoices \(My files, read-only\)/);
  assert.equal((await check('get_file', { fileId: 'f_dom' }, sys)).allow, false, 'the same path in the Domain lane is a different folder');
  assert.equal((await check('get_file', { fileId: 'f_unknown' }, sys)).allow, false, 'a file the runner cannot see is not in a granted folder');
});

test('FILES: writing into a read-only granted folder is refused; a writable folder is not; with a writable folder chosen, nowhere else is', async () => {
  const sys = system({ files: [
    { folder: { path: '/Invoices', scope: 'personal' }, capability: 'Read' },
    { folder: { path: '/Reports', scope: 'personal' }, capability: 'Write-bounded' },
  ] });
  assert.match(reason(await check('upload_file', { name: 'x.md', folder: 'Invoices/2026' }, sys)), /granted the folder \/Invoices\/2026 read-only.*It may write to: \/Reports \(My files\)/);
  assert.equal((await check('upload_file', { name: 'x.md', folder: '/Reports/2026' }, sys)).allow, true);
  // Where a writable folder was chosen (a declared output, or Read + write), THAT is where new
  // files go — choosing the target is the permission, and not one for the rest of the drive.
  assert.match(reason(await check('upload_file', { name: 'x.md', folder: '/Scratch' }, sys)), /may not write a file to \/Scratch: this system writes files only to \/Reports \(My files\)/);
  // With NO writable folder at all the earlier rule stands: a new personal file outside every
  // granted folder touches nothing existing, so only the read-only folders refuse it.
  const readOnly = system({ files: [{ folder: { path: '/Invoices', scope: 'personal' }, capability: 'Read' }] });
  assert.equal((await check('upload_file', { name: 'x.md', folder: '/Scratch' }, readOnly)).allow, true);
  assert.match(reason(await check('upload_file', { name: 'x.md', folder: '/Invoices' }, readOnly)), /read-only/);
});

test('LISTS: only the granted rows come back, and the result says rows were left out', async () => {
  const sys = system({ data: [{ id: 'ds_orders', capability: 'Read' }] });
  const v = await check('list_datasets', {}, sys);
  assert.ok(v.allow && v.shape);
  const shaped = v.allow && v.shape ? v.shape(JSON.stringify({ mine: [{ id: 'ds_orders', name: 'Orders' }, { id: 'ds_salaries', name: 'Salaries' }], domain: [{ id: 'ds_hr' }], marketplace: [] })) : null;
  assert.ok(shaped && 'text' in shaped);
  const out = JSON.parse((shaped as { text: string }).text);
  assert.deepEqual(out.mine, [{ id: 'ds_orders', name: 'Orders' }]);
  assert.deepEqual(out.domain, []);
  assert.match(out.grantScope, /2 other items the running user can see were left out/);
  // A result that cannot be parsed cannot be narrowed, so it is withheld — never passed through.
  const bad = v.allow && v.shape ? v.shape('Datasets: ds_orders, ds_salaries') : null;
  assert.ok(bad && 'refusal' in bad);
  // No grant for the kind → no filter at all.
  assert.equal(((await check('list_datasets', {}, system({}))) as { shape?: unknown }).shape, undefined);
});

test('SEARCH: search_knowledge and search_files return only granted items', async () => {
  const k = await check('search_knowledge', { query: 'refunds' }, system({ knowledge: [{ id: 'wf_refunds', capability: 'Read' }] }));
  assert.ok(k.allow && k.shape);
  const hits = { decision: 'allow', hits: [
    { unit: { id: 'u1', text: 'refund in 5 days', provenance: { workflowId: 'wf_refunds' } }, score: 1 },
    { unit: { id: 'u2', text: 'salary bands', provenance: { workflowId: 'wf_hr' } }, score: 0.9 },
    { unit: { id: 'u3', text: 'domain card', provenance: { workflowId: null, type: 'domain' } }, score: 0.8 },
  ] };
  const ks = k.allow && k.shape ? k.shape(JSON.stringify(hits)) : null;
  const kOut = JSON.parse((ks as { text: string }).text);
  assert.deepEqual(kOut.hits.map((h: { unit: { id: string } }) => h.unit.id), ['u1'], 'a hit from another workflow — or from none — is removed');

  const f = await check('search_files', { query: 'invoice' }, system({ files: [{ folder: { path: '/Invoices', scope: 'personal' }, capability: 'Read' }] }));
  const fs = f.allow && f.shape ? f.shape(JSON.stringify([{ id: 'f_inv2', name: 'a.pdf' }, { id: 'f_hr', name: 'b.pdf' }])) : null;
  assert.deepEqual(JSON.parse((fs as { text: string }).text).items, [{ id: 'f_inv2', name: 'a.pdf' }]);
});

test('SEARCH: the hybrid search_files result ({ mode, total, hits }) is narrowed to the granted folder', async () => {
  // 2026-11-20: search_files became hybrid and returns an object, not a bare array. The grant
  // filter walks into `hits` (rows carrying `id`), so an agent still sees only granted files.
  const f = await check('search_files', { query: 'notice period' }, system({ files: [{ folder: { path: '/Invoices', scope: 'personal' }, capability: 'Read' }] }));
  assert.ok(f.allow && f.shape);
  const result = { query: 'notice period', mode: 'hybrid', total: 2, hits: [
    { id: 'f_inv2', name: 'a.pdf', matchedBy: ['semantic'], snippet: 'thirty days notice' },
    { id: 'f_hr', name: 'b.pdf', matchedBy: ['lexical', 'semantic'], snippet: 'notice period' },
  ] };
  const shaped = f.allow && f.shape ? f.shape(JSON.stringify(result)) : null;
  const out = JSON.parse((shaped as { text: string }).text);
  assert.deepEqual(out.hits.map((h: { id: string }) => h.id), ['f_inv2'], 'the ungranted file is removed');
  assert.equal(out.mode, 'hybrid', 'the mode label survives the narrowing');
  assert.match(out.grantScope, /1 other item/);
  // The keyword-only fallback has the same shape, so it is narrowed the same way.
  const fb = f.allow && f.shape ? f.shape(JSON.stringify({ ...result, mode: 'keyword-only', note: 'keyword only (search index unavailable)' })) : null;
  assert.deepEqual(JSON.parse((fb as { text: string }).text).hits.map((h: { id: string }) => h.id), ['f_inv2']);
});

test('SQL: query_data runs only over the granted datasets\' tables, by full name', async () => {
  const sys = system({ data: [{ id: 'ds_orders', capability: 'Read' }] });
  assert.equal((await check('query_data', { sql: 'SELECT region, sum(net) FROM iceberg.sales.gold_orders GROUP BY 1' }, sys)).allow, true);
  assert.equal((await check('query_data', { sql: 'WITH t AS (SELECT * FROM "iceberg"."sales"."SILVER_orders") SELECT count(*) FROM t' }, sys)).allow, true);
  assert.match(reason(await check('query_data', { sql: 'SELECT * FROM iceberg.hr.gold_salaries' }, sys)), /not granted the table iceberg\.hr\.gold_salaries.*iceberg\.sales\.gold_orders/);
  assert.match(reason(await check('query_data', { sql: 'SELECT * FROM iceberg.sales.gold_orders o JOIN iceberg.hr.gold_salaries s ON 1=1' }, sys)), /iceberg\.hr\.gold_salaries/);
  assert.match(reason(await check('query_data', { sql: 'SELECT (SELECT max(pay) FROM iceberg.hr.gold_salaries) FROM iceberg.sales.gold_orders' }, sys)), /iceberg\.hr\.gold_salaries/);
  // A quoted physical name (a catalog with a hyphen) matches however the model quotes it.
  const quoted: GrantResolvers = { ...RESOLVERS, datasetTables: async () => ['"lake-house".sales."Gold_Orders"'] };
  assert.equal((await checkGrantScope('query_data', { sql: 'select * from "lake-house".sales.gold_orders' }, grantScopeOf(sys), quoted)).allow, true);
  // An unqualified name cannot be tied to a granted dataset → refused, with the names to use.
  assert.match(reason(await check('query_data', { sql: 'SELECT * FROM gold_orders' }, sys)), /not granted the table gold_orders/);
  // What cannot be checked is refused honestly, never run on trust.
  assert.match(reason(await check('query_data', { sql: 'SHOW TABLES FROM iceberg.hr' }, sys)), /cannot be checked against them because it is not a SELECT/);
  assert.match(reason(await check('query_data', { sql: "SELECT * FROM TABLE(system.query(query => 'select 1'))" }, sys)), /table function/i);
});

test('SQL: a CTE with a column list is not an ungranted table; a real ungranted table still is', async () => {
  const sys = system({ data: [{ id: 'ds_orders', capability: 'Read' }] });
  const cte = 'WITH inv(a, b) AS (VALUES (1, 2)), bench AS (SELECT 1) SELECT * FROM inv JOIN bench ON true JOIN iceberg.sales.gold_orders ON true';
  assert.equal((await check('query_data', { sql: cte }, sys)).allow, true);
  const leak = 'WITH inv(a, b) AS (VALUES (1, 2)) SELECT * FROM inv JOIN iceberg.hr.gold_salaries ON true';
  const why = reason(await check('query_data', { sql: leak }, sys));
  assert.match(why, /not granted the table iceberg\.hr\.gold_salaries\./);
  assert.doesNotMatch(why, /\binv\b/);
});

test('METRICS follow their dataset when the system has no metric grant of its own', async () => {
  const sys = system({ data: [{ id: 'ds_orders', capability: 'Read' }] });
  assert.equal((await check('query_metric', { metricId: 'ds_orders.revenue' }, sys)).allow, true);
  assert.match(reason(await check('query_metric', { metricId: 'ds_salaries.avg_pay' }, sys)), /its dataset is not one of the datasets this system is granted/);
  // With its own metric grants, the metric list is what counts.
  const own = system({ metrics: [{ id: 'ds_orders.revenue', capability: 'Read' }] });
  assert.equal((await check('query_metric', { metricId: 'ds_orders.revenue' }, own)).allow, true);
  assert.equal((await check('query_metric', { metricId: 'ds_orders.margin' }, own)).allow, false);
});

test('POLYMORPHIC tools: "<kind>, <id>" and "<kind>:<id>" are checked against the kind they name', async () => {
  const sys = system({ data: [{ id: 'ds_orders', capability: 'Read' }] });
  assert.equal((await check('get_history', { kind: 'dataset', id: 'ds_orders' }, sys)).allow, true);
  assert.equal((await check('get_history', { kind: 'dataset', id: 'ds_hr' }, sys)).allow, false);
  assert.match(reason(await check('request_promotion', { kind: 'dataset', id: 'ds_orders' }, sys)), /read-only/);
  assert.equal((await check('get_history', { kind: 'app', id: 'app_1' }, sys)).allow, true, 'apps are not a grant kind');
  assert.equal((await check('get_lineage', { ref: 'dataset:ds_hr' }, sys)).allow, false);
  assert.equal((await check('get_lineage', { ref: 'dataset:ds_orders' }, sys)).allow, true);
});

test('PLAN: an Operating Model scope is a plan grant', async () => {
  const sys = system({ plan: [{ id: 'manual:domain', capability: 'Read' }] });
  assert.equal((await check('get_operating_manual', { scope: 'domain' }, sys)).allow, true);
  assert.match(reason(await check('get_operating_manual', { scope: 'company' }, sys)), /not granted plan item manual:company/);
  assert.match(reason(await check('update_operating_manual', { scope: 'domain', sections: [] }, sys)), /read-only/);
});

test('BROAD tools are refused while a kind they sweep is restricted, and say why', async () => {
  const sys = system({ data: [{ id: 'ds_orders', capability: 'Read' }] });
  assert.match(reason(await check('suggest_metrics', { goal: 'x' }, sys)), /reads every dataset and metric the running user can see/);
  assert.equal((await check('suggest_metrics', { goal: 'x' }, system({}))).allow, true);
});

test('CREATED in this run: a new artifact is usable afterwards, by id and in SQL', async () => {
  const sys = system({ data: [{ id: 'ds_orders', capability: 'Read' }] });
  const scope = grantScopeOf(sys);
  assert.equal((await checkGrantScope('get_dataset', { datasetId: 'ds_new' }, scope, RESOLVERS)).allow, false);
  const made = await checkGrantScope('create_dataset', { name: 'New' }, scope, RESOLVERS);
  assert.ok(made.allow && made.created, 'creating is allowed — nothing existing is touched');
  if (made.allow) made.created?.(JSON.stringify({ id: 'ds_new', name: 'New' }));
  assert.equal((await checkGrantScope('get_dataset', { datasetId: 'ds_new' }, scope, RESOLVERS)).allow, true);
  assert.equal((await checkGrantScope('ingest_dataset', { datasetId: 'ds_new', content: 'a' }, scope, RESOLVERS)).allow, true, 'the run may write what it created');
  assert.equal((await checkGrantScope('query_data', { sql: 'select * from iceberg.personal_u1.bronze_new' }, scope, RESOLVERS)).allow, true);
});

test('createdIds / createdFromSteps: the ids a creating tool answers with, and the ledger a resumed run rebuilds', () => {
  assert.deepEqual(createdIds('data', JSON.stringify({ id: 'ds_1' })), ['ds_1']);
  assert.deepEqual(createdIds('data', JSON.stringify({ dataset: { id: 'ds_2' }, cron: '* * * * *' })), ['ds_2']);
  assert.deepEqual(createdIds('workflows', JSON.stringify({ workflows: [{ id: 'wf_1' }, { id: 'wf_2' }] })), ['wf_1', 'wf_2']);
  assert.deepEqual(createdIds('metrics', JSON.stringify({ datasetId: 'ds_1', measure: { name: 'revenue' } })), ['ds_1.revenue']);
  assert.deepEqual(createdIds('data', 'not json'), []);
  const seed = createdFromSteps([
    { tool: 'create_dataset', result: JSON.stringify({ id: 'ds_new' }), isError: false },
    { tool: 'write_file', result: JSON.stringify({ id: 'f_new' }), isError: false },
    { tool: 'create_dataset', result: JSON.stringify({ error: { code: 'forbidden' } }), isError: true },
    { tool: 'get_dataset', result: JSON.stringify({ id: 'ds_seen' }), isError: false },
  ], (t) => (t === 'write_file' ? 'upload_file' : t));
  assert.deepEqual(seed, { data: ['ds_new'], files: ['f_new'] });
  const scope = grantScopeOf(system({ data: [{ id: 'ds_orders', capability: 'Read' }] }), seed);
  assert.ok(scope.created.data.has('ds_new') && scope.created.files.has('f_new'));
});

test('find is refused for an agent whose only grants name workflows (find lists and searches workflows as the user)', async () => {
  const wfOnly = system({ workflows: [{ id: 'wf_x', capability: 'Read' }] });
  const v = await check('find', { query: 'refunds' }, wfOnly);
  assert.equal(v.allow, false, 'a workflow-limited grant must not widen to every workflow through find');
  assert.match(reason(v), /find|every kind|widen|restrict/i);
  assert.ok(TOOL_RESOURCES.find?.broad?.kinds.includes('workflows'), 'find names the workflow kind among the kinds it spans');
  // NEGATIVE TWIN: the grant-scoped per-kind tools still serve that agent, and find stays open for an agent with no restriction.
  assert.equal((await check('get_workflow', { workflowId: 'wf_x' }, wfOnly)).allow, true);
  assert.equal((await check('find', { query: 'refunds' }, system({}))).allow, true);
});

test('an UNCLASSIFIED tool is refused, never run unchecked', async () => {
  const v = await check('some_future_tool', { datasetId: 'ds_orders' }, system({}));
  assert.match(reason(v), /has not been classified for resource grants/);
});

test('THE PROMPT says what is enforced, kind by kind — and nothing it does not do', () => {
  const sys = system({
    data: [{ id: 'ds_orders', capability: 'Read' }, { id: 'ds_stage', capability: 'Write-bounded' }],
    files: [{ folder: { path: '/Invoices', scope: 'personal' }, capability: 'Read' }],
  });
  const brief = grantScopeBrief(sys);
  assert.match(brief, /the engine ENFORCES it/);
  assert.match(brief, /- datasets: ds_orders \(read-only\), ds_stage/);
  assert.match(brief, /- files: only files in \/Invoices \(My files, read-only\)/);
  assert.match(brief, /No grant narrows these kinds, so the running user's own access applies to them: knowledge, workflows, metrics, connections, plan/);
  assert.doesNotMatch(brief, /DENIED by OPA|ONLY resource ids/);
  assert.equal(grantScopeBrief(system({})), '', 'no resource grant → nothing is claimed');
});

// ------------------------------------------------- find under a restricted grant (fast surface) --

test('find is refused for an agent whose grants limit it to specific items (it would widen the scope)', () => {
  const rule = TOOL_RESOURCES.find;
  assert.ok(rule?.broad, 'find is a broad tool: it searches every kind the user can see');
  assert.ok(rule.broad.kinds.includes('data') && rule.broad.kinds.includes('files') && rule.broad.kinds.includes('knowledge'));
  // NEGATIVE TWIN: the per-kind list tools stay grant-filtered rather than broad, so an agent can still read what it was granted.
  assert.equal(TOOL_RESOURCES.list_datasets?.broad, undefined);
});

// ------------------------------------------------ workflows are their own grant kind --

test('WF/K: a workflow grant covers the workflow tools and NOT knowledge notes; a note grant covers notes and NOT workflows', async () => {
  const wfOnly = system({ workflows: [{ id: 'wf_refunds', capability: 'Read' }] });
  assert.equal((await check('get_workflow', { workflowId: 'wf_refunds' }, wfOnly)).allow, true);
  const other = await check('get_workflow', { workflowId: 'wf_hr' }, wfOnly);
  assert.equal(other.allow, false);
  assert.match(reason(other), /workflow wf_hr/);
  // Knowledge is untouched by a workflow grant: its tools keep the running user's own access.
  assert.equal((await check('get_knowledge', { id: 'pk_any' }, wfOnly)).allow, true);

  const noteOnly = system({ knowledge: [{ id: 'pk_notes', capability: 'Read' }] });
  assert.equal((await check('get_knowledge', { id: 'pk_notes' }, noteOnly)).allow, true);
  assert.equal((await check('get_knowledge', { id: 'pk_other' }, noteOnly)).allow, false);
  // NEGATIVE TWIN: a restricted NOTE grant does not narrow workflows (a different kind), and
  // the deprecated `workflowId` spelling of get_knowledge is checked against the WORKFLOW grants.
  assert.equal((await check('get_workflow', { workflowId: 'wf_any' }, noteOnly)).allow, true);
  const legacyArg = await check('get_knowledge', { workflowId: 'wf_hr' }, wfOnly);
  assert.equal(legacyArg.allow, false, 'the deprecated argument cannot walk around a workflow restriction');
});

test('WF/K: a write grant on one kind does not let the other kind be written', async () => {
  const wfRead = system({ workflows: [{ id: 'wf_a', capability: 'Read' }] });
  assert.equal((await check('index_workflow', { workflowId: 'wf_a' }, wfRead)).allow, false, 'a Read workflow grant refuses a workflow write');
  const wfWrite = system({ workflows: [{ id: 'wf_a', capability: 'Write-bounded' }] });
  assert.equal((await check('index_workflow', { workflowId: 'wf_a' }, wfWrite)).allow, true);
  assert.equal((await check('retire_workflow', { workflowId: 'wf_a' }, wfWrite)).allow, true);
});

test('WF/K: search_knowledge checks each hit against ITS artifact — a wf_ hit by the workflow grants, a pk_ hit by the note grants', async () => {
  const sys = system({ workflows: [{ id: 'wf_refunds', capability: 'Read' }], knowledge: [{ id: 'pk_notes', capability: 'Read' }] });
  const v = await check('search_knowledge', { query: 'refunds' }, sys);
  assert.ok(v.allow && v.shape);
  const hits = { hits: [
    { unit: { id: 'u1', provenance: { workflowId: 'wf_refunds' } } },
    { unit: { id: 'u2', provenance: { workflowId: 'wf_hr' } } },
    { unit: { id: 'u3', provenance: { workflowId: 'pk_notes' } } },
    { unit: { id: 'u4', provenance: { workflowId: 'pk_other' } } },
  ] };
  const out = JSON.parse(((v.allow && v.shape ? v.shape(JSON.stringify(hits)) : null) as { text: string }).text);
  assert.deepEqual(out.hits.map((h: { unit: { id: string } }) => h.unit.id), ['u1', 'u3']);
  // A note-only restriction leaves workflow hits alone (the workflow kind is unrestricted), and the reverse.
  const notesOnly = system({ knowledge: [{ id: 'pk_notes', capability: 'Read' }] });
  const v2 = await check('search_knowledge', { query: 'x' }, notesOnly);
  const out2 = JSON.parse(((v2.allow && v2.shape ? v2.shape(JSON.stringify(hits)) : null) as { text: string }).text);
  assert.deepEqual(out2.hits.map((h: { unit: { id: string } }) => h.unit.id), ['u1', 'u2', 'u3']);
});

test('WF/K: the polymorphic tools route a wf_ id to the workflow grants whatever kind word was sent', async () => {
  const sys = system({ workflows: [{ id: 'wf_a', capability: 'Write-bounded' }], knowledge: [{ id: 'pk_a', capability: 'Read' }] });
  for (const kind of ['workflow', 'knowledge']) {
    assert.equal((await check('request_promotion', { kind, id: 'wf_a' }, sys)).allow, true, `${kind}/wf_a is a granted workflow`);
    assert.equal((await check('request_promotion', { kind, id: 'wf_b' }, sys)).allow, false, `${kind}/wf_b is not granted`);
  }
  // A note granted READ cannot be promoted (a write), and a note id under `knowledge` is checked as a note.
  assert.equal((await check('request_promotion', { kind: 'knowledge', id: 'pk_a' }, sys)).allow, false);
  assert.equal((await check('request_promotion', { kind: 'personal_knowledge', id: 'pk_a' }, sys)).allow, false);
});

test('WF/K: author_workflow creates a WORKFLOW the run may then use; save_knowledge_note a NOTE', async () => {
  const sys = system({ workflows: [{ id: 'wf_a', capability: 'Write-bounded' }], knowledge: [{ id: 'pk_a', capability: 'Write-bounded' }] });
  const scope = grantScopeOf(sys);
  const made = await checkGrantScope('author_workflow', { title: 'New' }, scope, RESOLVERS);
  assert.ok(made.allow && made.created);
  if (made.allow && made.created) made.created(JSON.stringify({ id: 'wf_new', title: 'New' }));
  assert.ok(scope.created.workflows.has('wf_new') && !scope.created.knowledge.has('wf_new'));
  assert.equal((await checkGrantScope('get_workflow', { workflowId: 'wf_new' }, scope, RESOLVERS)).allow, true);
  const note = await checkGrantScope('save_knowledge_note', { title: 'N', md: 'x' }, scope, RESOLVERS);
  assert.ok(note.allow && note.created);
  if (note.allow && note.created) note.created(JSON.stringify({ id: 'pk_new' }));
  assert.ok(scope.created.knowledge.has('pk_new') && !scope.created.workflows.has('pk_new'));
});
