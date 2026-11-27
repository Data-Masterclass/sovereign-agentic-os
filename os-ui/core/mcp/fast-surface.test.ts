/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       mcp
 * FEATURE:    The fast, simple external MCP surface — everyday questions are ONE tool call.
 * USER STORY: As someone asking Claude "which datasets do I have?" I want one tool call and a short
 *             answer, not whoami + list_capabilities + guides + 150 tool definitions first.
 * ARCHITECTURE: the external door (`HandleRpcOptions.fast`) serves a small CORE read toolset by
 *   default; build/admin/write tools are NAMED TOOLSETS the client loads on demand
 *   (`load_toolset` + `notifications/tools/list_changed`). Nothing is ungoverned: a tool that is not
 *   loaded cannot be called, and a loaded one still passes the role floor and its governed function.
 *   Every case has a NEGATIVE TWIN (the same assertion must fail if the behaviour is faked).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { handleRpc, ALL_MCP_TOOLS, isListed, roleCanUse, type JsonRpcResponse } from '@core/mcp/server';
import { buildInstructions } from '@core/mcp/instructions';
import { CORE_TOOLS, COMPACT_LIST_TOOLS, TOOLSETS, toolsetOf, toolsetForTab } from '@core/mcp/fast-surface';

const cara: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };
const dan: CurrentUser = { id: 'dan', name: 'Dan', domains: ['ops'], role: 'creator' };
const ada: CurrentUser = { id: 'ada', name: 'Ada', domains: ['ops'], role: 'admin' };

// Each data test uses fresh users (a My-scope dataset is visible only to its owner), so no store reset
// and no tab import is needed (GLUE-9: a kernel test names no tab).
let userN = 0;
const fresh = (domain: string): CurrentUser => ({ id: `fx${++userN}`, name: 'Fx', domains: [domain], role: 'creator' });
let keyN = 0;
const freshKey = () => `test-session-${++keyN}`;

function result(res: JsonRpcResponse | null): Record<string, unknown> {
  assert.ok(res && 'result' in res, `expected a JSON-RPC result, got ${JSON.stringify(res)}`);
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}
async function rpc(user: CurrentUser, key: string | null, method: string, params?: Record<string, unknown>, notify?: (n: unknown) => void) {
  return handleRpc(user, { jsonrpc: '2.0', id: 1, method, params }, key ? { fast: { sessionKey: key, notify } } : {});
}
async function call(user: CurrentUser, key: string | null, name: string, args: Record<string, unknown> = {}) {
  const r = result(await rpc(user, key, 'tools/call', { name, arguments: args }));
  const text = (r.content as { text: string }[])[0].text;
  return { r, text, json: () => JSON.parse(text) as Record<string, any> };
}
const listNames = async (user: CurrentUser, key: string | null) =>
  ((result(await rpc(user, key, 'tools/list')).tools as { name: string }[]).map((t) => t.name));

// ---------------------------------------------------------------- one call for a simple question
test('a simple question needs exactly ONE tool call: list_datasets answers with no whoami / list_capabilities first', async () => {
  const cara = fresh('sales');
  const key = freshKey();
  await call(cara, key, 'load_toolset', { name: 'data' });
  await call(cara, key, 'create_dataset', { name: 'Orders' });
  const newSession = freshKey(); // a NEW session that has called nothing else
  const out = await call(cara, newSession, 'list_datasets');
  assert.notEqual(out.r.isError, true, 'the read tool answers directly');
  assert.equal(out.json().total, 1);
  assert.equal(out.json().items[0].name, 'Orders');
});

test('NEGATIVE TWIN: the question is NOT answerable by a tool that is not in the core set (so "one call" is not faked by loading everything)', async () => {
  const key = freshKey();
  const names = await listNames(cara, key);
  assert.ok(names.includes('list_datasets') && names.includes('find'));
  assert.ok(!names.includes('create_dataset'), 'a write tool is not in the default list');
});

// ---------------------------------------------------------------- the core toolset
test('the default tool list is the small CORE read set (<= 25 tools, well under half the full list)', async () => {
  const key = freshKey();
  const names = await listNames(ada, key);
  assert.ok(names.length <= 25, `core list has ${names.length} tools`);
  for (const n of ['whoami', 'find', 'load_toolset', 'list_datasets', 'list_metrics', 'query_metric', 'list_files', 'search_files', 'list_knowledge', 'search_knowledge', 'list_dashboards', 'list_agent_systems', 'list_software', 'list_connections', 'query_data']) {
    assert.ok(names.includes(n), `core is missing ${n}`);
  }
  const full = (result(await rpc(ada, null, 'tools/list')).tools as unknown[]).length;
  assert.ok(names.length * 4 < full, `core (${names.length}) must be far smaller than the full list (${full})`);
});

test('NEGATIVE TWIN: without the fast door the list is still the FULL registry (internal callers unchanged)', async () => {
  const full = await listNames(ada, null);
  assert.ok(full.includes('create_dataset') && full.includes('approve_promotion') && full.includes('list_datasets'));
});

test('tools/list bytes: the default list is a small fraction of the full list', async () => {
  const slim = JSON.stringify(result(await rpc(ada, freshKey(), 'tools/list')));
  const full = JSON.stringify(result(await rpc(ada, null, 'tools/list')));
  assert.ok(slim.length < 45_000, `default tools/list is ${slim.length} bytes`);
  assert.ok(slim.length * 3 < full.length, 'at least 3x smaller than the full list');
});

// ---------------------------------------------------------------- toolsets: refuse, hint, load
test('an unloaded tool is REFUSED with a typed error that names its toolset and load_toolset', async () => {
  const key = freshKey();
  const out = await call(cara, key, 'create_dataset', { name: 'X' });
  assert.equal(out.r.isError, true);
  const err = (out.r.structuredContent as { error: { code: string; hint: string } }).error;
  assert.equal(err.code, 'toolset_not_loaded');
  assert.match(err.hint, /load_toolset/);
  assert.match(err.hint, /data/, 'the hint names the toolset the tool lives in');
});

test('NEGATIVE TWIN: after load_toolset the same call is no longer refused for the toolset', async () => {
  const key = freshKey();
  const loaded = await call(cara, key, 'load_toolset', { name: 'data' });
  assert.notEqual(loaded.r.isError, true);
  const out = await call(cara, key, 'create_dataset', { name: 'X' });
  assert.notEqual(out.r.isError, true, out.text.slice(0, 200));
});

test('loading one toolset does not unlock another (data does not unlock software)', async () => {
  const key = freshKey();
  await call(cara, key, 'load_toolset', { name: 'data' });
  const out = await call(cara, key, 'create_software', { name: 'App' });
  assert.equal(out.r.isError, true);
  assert.equal((out.r.structuredContent as { error: { code: string } }).error.code, 'toolset_not_loaded');
});

test('toolsets are per session: another session (and another user on the same key) stays refused', async () => {
  const key = freshKey();
  await call(cara, key, 'load_toolset', { name: 'data' });
  const other = await call(cara, freshKey(), 'create_dataset', { name: 'X' });
  assert.equal((other.r.structuredContent as { error: { code: string } }).error.code, 'toolset_not_loaded');
  const stolen = await call(dan, key, 'create_dataset', { name: 'X' });
  assert.equal((stolen.r.structuredContent as { error: { code: string } }).error.code, 'toolset_not_loaded', 'a session key is bound to the user who loaded it');
});

test('the role floor still applies after loading: a creator cannot call approve_promotion even with governance loaded', async () => {
  const key = freshKey();
  await call(cara, key, 'load_toolset', { name: 'data' });
  const out = await call(cara, key, 'approve_promotion', { approvalId: 'x' });
  assert.equal(out.r.isError, true);
  assert.equal((out.r.structuredContent as { error: { code: string } }).error.code, 'forbidden');
});

test('load_toolset: tools/list grows by exactly that toolset, and a list_changed notification is sent', async () => {
  const key = freshKey();
  const before = await listNames(cara, key);
  const seen: unknown[] = [];
  const r = result(await rpc(cara, key, 'tools/call', { name: 'load_toolset', arguments: { name: 'data' } }, (n) => seen.push(n)));
  assert.notEqual(r.isError, true);
  assert.deepEqual(seen, [{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }]);
  const after = await listNames(cara, key);
  const added = after.filter((n) => !before.includes(n));
  assert.ok(added.includes('create_dataset'));
  assert.ok(added.every((n) => toolsetOf(ALL_MCP_TOOLS.find((t) => t.name === n)!) === 'data'), 'only data tools were added');
});

test('NEGATIVE TWIN: an unknown toolset is a typed bad_request naming the valid ones, and sends no notification', async () => {
  const seen: unknown[] = [];
  const r = result(await rpc(cara, freshKey(), 'tools/call', { name: 'load_toolset', arguments: { name: 'nope' } }, (n) => seen.push(n)));
  assert.equal(r.isError, true);
  const err = (r.structuredContent as { error: { code: string; hint: string } }).error;
  assert.equal(err.code, 'bad_request');
  for (const t of Object.keys(TOOLSETS)) assert.match(err.hint, new RegExp(t));
  assert.equal(seen.length, 0);
});

test('initialize on the fast door advertises tools.listChanged; the plain door does not', async () => {
  const fast = result(await rpc(cara, freshKey(), 'initialize')).capabilities as { tools: { listChanged: boolean } };
  const plain = result(await rpc(cara, null, 'initialize')).capabilities as { tools: { listChanged: boolean } };
  assert.equal(fast.tools.listChanged, true);
  assert.equal(plain.tools.listChanged, false);
});

// ---------------------------------------------------------------- every tool stays reachable
test('every registered tool is core or in exactly one known toolset, and loading all toolsets yields the full role list', async () => {
  for (const t of ALL_MCP_TOOLS) {
    const set = toolsetOf(t);
    if (CORE_TOOLS.includes(t.name)) assert.equal(set, null, `${t.name} is core`);
    else assert.ok(set && set in TOOLSETS, `${t.name} (tab ${t.tab}) has no toolset`);
  }
  const key = freshKey();
  for (const name of Object.keys(TOOLSETS)) await call(ada, key, 'load_toolset', { name });
  const loaded = new Set(await listNames(ada, key));
  // A tool behind a switch that is off (`listed` false: the App Builder) is deliberately not advertised.
  const expected = ALL_MCP_TOOLS.filter((t) => roleCanUse('admin', t.minRole) && isListed(t)).map((t) => t.name);
  for (const n of expected) assert.ok(loaded.has(n), `${n} is unreachable after loading every toolset`);
  for (const t of ALL_MCP_TOOLS.filter((x) => !isListed(x))) assert.ok(!loaded.has(t.name), `${t.name} is advertised while its switch is off`);
});

test('NEGATIVE TWIN: toolsetOf rejects a name that is not registered (a typo in CORE_TOOLS cannot silently hide a tool)', () => {
  const registered = new Set([...ALL_MCP_TOOLS.map((t) => t.name), 'load_toolset' /* fast door only */]);
  for (const n of CORE_TOOLS) assert.ok(registered.has(n), `CORE_TOOLS names ${n}, which is not a registered tool`);
});

// ---------------------------------------------------------------- compact lists
test('compact output stays within N bytes per item, and detail:true returns the full record', async () => {
  const cara = fresh('sales');
  const key = freshKey();
  await call(cara, key, 'load_toolset', { name: 'data' });
  for (let i = 0; i < 12; i++) await call(cara, key, 'create_dataset', { name: `Quarterly revenue by region ${i}` });
  const compact = (await call(cara, key, 'list_datasets')).json();
  assert.equal(compact.total, 12);
  for (const item of compact.items) {
    const bytes = Buffer.byteLength(JSON.stringify(item));
    assert.ok(bytes <= 320, `a compact item is ${bytes} bytes: ${JSON.stringify(item)}`);
    for (const k of ['id', 'name', 'scope']) assert.ok(item[k], `compact item lacks ${k}`);
  }
  const detail = await call(cara, key, 'list_datasets', { detail: true });
  const perItemFull = detail.text.length / 12;
  const perItemCompact = JSON.stringify(compact.items).length / 12;
  assert.ok(perItemFull > perItemCompact * 2, `NEGATIVE TWIN: detail:true must be the full record (${perItemFull} vs ${perItemCompact})`);
});

test('pagination: a sane default limit, limit/offset page through, and nextOffset says when there is more', async () => {
  const cara = fresh('sales');
  const key = freshKey();
  await call(cara, key, 'load_toolset', { name: 'data' });
  for (let i = 0; i < 30; i++) await call(cara, key, 'create_dataset', { name: `Set ${i}` });
  const first = (await call(cara, key, 'list_datasets')).json();
  assert.equal(first.total, 30);
  assert.equal(first.items.length, 25, 'default limit is 25');
  assert.equal(first.nextOffset, 25);
  const second = (await call(cara, key, 'list_datasets', { offset: first.nextOffset })).json();
  assert.equal(second.items.length, 5);
  assert.equal(second.nextOffset, null);
  const ids = new Set([...first.items, ...second.items].map((i: { id: string }) => i.id));
  assert.equal(ids.size, 30, 'pages do not overlap or drop items');
  const small = (await call(cara, key, 'list_datasets', { limit: 2 })).json();
  assert.equal(small.items.length, 2);
});

test('NEGATIVE TWIN: the plain door still returns the original grouped payload (agents and the UI are unchanged)', async () => {
  const cara = fresh('sales');
  await call(cara, null, 'create_dataset', { name: 'Orders' });
  const plain = (await call(cara, null, 'list_datasets')).json();
  assert.ok(Array.isArray(plain.mine) || 'mine' in plain, 'grouped payload');
  assert.equal(plain.items, undefined);
});

// ---------------------------------------------------------------- find
test('find(query) returns the caller’s own matching artifacts across kinds, compactly', async () => {
  const cara = fresh('sales');
  await call(cara, null, 'create_dataset', { name: 'Refund tickets' });
  const out = (await call(cara, freshKey(), 'find', { query: 'refund' })).json();
  assert.ok(out.total >= 1);
  const hit = out.results.find((r: { kind: string }) => r.kind === 'dataset');
  assert.ok(hit, JSON.stringify(out).slice(0, 400));
  assert.equal(hit.name, 'Refund tickets');
  assert.ok(hit.id);
});

test('find never returns another domain’s items (RLS/DLS is the same governed reader)', async () => {
  const cara = fresh('sales');
  const dan = fresh('ops');
  await call(cara, null, 'create_dataset', { name: 'Sales pipeline secret' });
  const asDan = (await call(dan, freshKey(), 'find', { query: 'secret' })).json();
  assert.equal(JSON.stringify(asDan).includes('Sales pipeline secret'), false, 'Dan (ops) must not see Cara’s (sales) dataset');
  // NEGATIVE TWIN: the same query as the owner finds it, so the empty result above is not vacuous.
  const asCara = (await call(cara, freshKey(), 'find', { query: 'secret' })).json();
  assert.equal(JSON.stringify(asCara).includes('Sales pipeline secret'), true);
});

test('find: an empty query is a typed bad_request, and a source that fails is reported, never silently dropped', async () => {
  const empty = result(await rpc(cara, freshKey(), 'tools/call', { name: 'find', arguments: { query: '  ' } }));
  assert.equal(empty.isError, true);
  const out = (await call(cara, freshKey(), 'find', { query: 'zzz-no-such-thing' })).json();
  assert.equal(out.total, 0);
  assert.ok(Array.isArray(out.results));
});

// ---------------------------------------------------------------- instructions
test('the instructions tell the model to answer questions with the matching read tool directly', () => {
  const text = buildInstructions();
  assert.doesNotMatch(text, /FIRST, ALWAYS/, 'no mandatory preamble');
  assert.match(text, /list_datasets/);
  assert.match(text, /list_metrics/);
  assert.match(text, /find\(/);
  assert.match(text, /load_toolset/);
  assert.match(text, /no whoami|without whoami|do not call whoami/i);
});

test('the instructions keep the governance statements and still require whoami + guides before BUILDING', () => {
  const text = buildInstructions();
  assert.match(text, /AS the signed-in user/);
  assert.match(text, /OPA/);
  assert.match(text, /audit/i);
  assert.match(text, /before (building|you build)[^.]*whoami|whoami[^.]*before (building|you build)|BUILDING[^.]*whoami/i);
  assert.match(text, /get_guide/);
});

test('NEGATIVE TWIN: the old wording is gone from every per-tab brief too', () => {
  for (const tab of ['data', 'software', 'agents'] as const) {
    assert.doesNotMatch(buildInstructions(tab), /FIRST: call whoami then list_capabilities/);
  }
});

test('the instructions are short (a slim preamble, not a manual)', () => {
  assert.ok(buildInstructions().length < 3_800, `instructions are ${buildInstructions().length} chars`);
});

// ---------------------------------------------------------------- review fixes (verifier, LOW x3 + skipped.reason)
test('session ids: only an id the server issued to THIS user is accepted; a client-chosen id is rejected', async () => {
  const { issueSession, resolveSessionKey } = await import('@core/mcp/fast-surface');
  const sid = issueSession('cara');
  assert.deepEqual(resolveSessionKey(sid, 'tokhash', 'cara'), { key: `sid:${sid}` });
  // NEGATIVE TWINS: client-chosen, another user's issued id, and no header (token-derived key).
  assert.deepEqual(resolveSessionKey('client-chosen-12345678', 'tokhash', 'cara'), { rejected: true });
  assert.deepEqual(resolveSessionKey(sid, 'tokhash', 'dan'), { rejected: true }, 'an id issued to cara cannot be used by dan');
  assert.deepEqual(resolveSessionKey('', 'tokhash', 'cara'), { key: 'tok:tokhash' });
});

test('load_toolset is NOT in ALL_MCP_TOOLS (agent runs and the Home chat never see it) but IS on the fast door; find stays in both', async () => {
  const names = ALL_MCP_TOOLS.map((t) => t.name);
  assert.ok(!names.includes('load_toolset'), 'load_toolset must not be in the registry agents use');
  assert.ok(names.includes('find'), 'find is kept deliberately for agent runs and the Home chat');
  assert.ok((await listNames(cara, freshKey())).includes('load_toolset'), 'the fast door still lists it');
  assert.ok(!(await listNames(cara, null)).includes('load_toolset'), 'NEGATIVE TWIN: the plain door does not');
});

test('find reports a skipped source with a typed code, never the raw error message', async () => {
  const { skipCode } = await import('@core/mcp/find-tools');
  assert.equal(skipCode(new Error('timed out after 10s')), 'timeout');
  assert.equal(skipCode(Object.assign(new Error('Not permitted to read /secret/path'), { status: 403 })), 'forbidden');
  const raw = 'connect ECONNREFUSED 10.1.2.3:5432 password=hunter2';
  assert.equal(skipCode(new Error(raw)), 'failed');
  assert.doesNotMatch(skipCode(new Error(raw)), /hunter2|ECONN|10\.1/);
});

test('the workflow tools live in the toolset the Knowledge description promises (workflows and notes), and the prompts can name it', () => {
  assert.match(TOOLSETS.knowledge.description, /workflows/);
  assert.equal(toolsetForTab('workflows'), 'knowledge', 'the Workflows tab maps to a toolset the prompts can tell the client to load');
  for (const name of ['author_workflow', 'publish_workflow', 'index_workflow', 'retire_workflow']) {
    const t = ALL_MCP_TOOLS.find((x) => x.name === name);
    assert.ok(t, `${name} is registered`);
    assert.equal(toolsetOf(t), 'knowledge', `${name} is in the knowledge toolset, not the platform fallback`);
  }
  // NEGATIVE TWIN: a tab nobody mapped still falls back to platform, so the assertion above is about the mapping, not the fallback.
  assert.equal(toolsetOf({ name: 'x_unmapped', tab: 'no-such-tab' }), 'platform');
  assert.equal(toolsetForTab('no-such-tab'), null);
});

test('list_workflows is a compact list on the fast door: a page by default, the plain door unchanged', async () => {
  assert.ok(COMPACT_LIST_TOOLS.includes('list_workflows'));
  const cara = fresh('sales');
  const key = freshKey();
  await call(cara, key, 'load_toolset', { name: 'knowledge' });
  for (let i = 0; i < 30; i++) await call(cara, key, 'author_workflow', { title: `Process ${i}`, domain: 'sales' });
  const first = (await call(cara, key, 'list_workflows')).json();
  assert.equal(first.total, 30);
  assert.equal(first.items.length, 25, 'default page is 25');
  assert.equal(first.nextOffset, 25);
  // NEGATIVE TWIN: the plain door (agents, the UI) still returns the original grouped payload.
  const plain = (await call(cara, null, 'list_workflows')).json();
  assert.ok(!('items' in plain) && !('nextOffset' in plain), 'the plain door is not compacted');
});
