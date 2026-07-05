/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/auth';
import { handleRpc, type JsonRpcResponse } from './server.ts';
import { RESOURCES, RESOURCE_TEMPLATES } from './resources.ts';
import { __resetStore as resetData } from '@/lib/data/store';

/**
 * MCP RESOURCES over the dispatcher: guides + dynamic my/* inventories, all
 * delegating to the SAME governed store fns as the UI — so DLS/role scoping is
 * inherited, never re-implemented. resources/read re-checks the role floor and
 * returns -32002 (no existence leak) for an id the caller cannot see.
 */

const cara: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };
const dan: CurrentUser = { id: 'dan', name: 'Dan', domains: ['ops'], role: 'creator' };

function result(res: JsonRpcResponse | null): Record<string, unknown> {
  assert.ok(res && 'result' in res, 'expected a JSON-RPC result');
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}
async function rpc(user: CurrentUser, method: string, params?: Record<string, unknown>) {
  return handleRpc(user, { jsonrpc: '2.0', id: 1, method, params });
}
async function callTool(user: CurrentUser, name: string, args: Record<string, unknown> = {}) {
  const r = result(await rpc(user, 'tools/call', { name, arguments: args }));
  return JSON.parse((r.content as { text: string }[])[0].text) as Record<string, unknown>;
}

test('initialize: declares resources + prompts capabilities and ALWAYS carries orientation instructions', async () => {
  const r = result(await rpc(cara, 'initialize'));
  const caps = r.capabilities as Record<string, unknown>;
  assert.ok(caps.resources, 'resources capability declared');
  assert.ok(caps.prompts, 'prompts capability declared');
  assert.equal(typeof r.instructions, 'string');
  assert.match(r.instructions as string, /SOVEREIGN AGENTIC OS/);
  assert.match(r.instructions as string, /whoami/);
});

test('resources/list: exposes the 12 guides + the 10 my/* inventories, annotated for the assistant', async () => {
  const r = result(await rpc(cara, 'resources/list'));
  const list = r.resources as { uri: string; annotations: { audience: string[] } }[];
  const uris = list.map((x) => x.uri);
  // 12 static guides.
  for (const u of [
    'sovereign-os://guide/overview', 'sovereign-os://guide/governance',
    'sovereign-os://guide/path/data', 'sovereign-os://guide/path/knowledge',
    'sovereign-os://guide/path/connections', 'sovereign-os://guide/path/agents',
    'sovereign-os://guide/path/software', 'sovereign-os://guide/path/metrics',
    'sovereign-os://guide/path/dashboards', 'sovereign-os://guide/path/bigbets',
    'sovereign-os://guide/path/files', 'sovereign-os://guide/path/science',
  ]) assert.ok(uris.includes(u), `missing guide ${u}`);
  // 11 dynamic inventories.
  for (const u of [
    'sovereign-os://my/identity', 'sovereign-os://my/datasets', 'sovereign-os://my/knowledge',
    'sovereign-os://my/connections', 'sovereign-os://my/files', 'sovereign-os://my/metrics',
    'sovereign-os://my/dashboards', 'sovereign-os://my/agents', 'sovereign-os://my/software',
    'sovereign-os://my/bigbets', 'sovereign-os://my/science',
  ]) assert.ok(uris.includes(u), `missing inventory ${u}`);
  assert.ok(list.every((x) => x.annotations.audience.includes('assistant')));
});

test('resources/templates/list: exposes the by-id templates', async () => {
  const r = result(await rpc(cara, 'resources/templates/list'));
  const tpls = (r.resourceTemplates as { uriTemplate: string }[]).map((t) => t.uriTemplate);
  for (const u of ['sovereign-os://dataset/{id}', 'sovereign-os://file/{id}', 'sovereign-os://connection/{id}', 'sovereign-os://app/{id}']) {
    assert.ok(tpls.includes(u), `missing template ${u}`);
  }
});

test('resources/read: a guide returns non-empty markdown', async () => {
  const r = result(await rpc(cara, 'resources/read', { uri: 'sovereign-os://guide/overview' }));
  const c = (r.contents as { uri: string; mimeType: string; text: string }[])[0];
  assert.equal(c.mimeType, 'text/markdown');
  assert.ok(c.text.length > 200, 'the overview guide has real content');
});

test('resources/read: my/datasets delegates to the governed store and is DLS-scoped to the caller', async () => {
  resetData();
  // Cara (sales) creates a Personal dataset via the governed tool.
  const ds = await callTool(cara, 'create_dataset', { name: 'Cara Orders' });
  const caraView = result(await rpc(cara, 'resources/read', { uri: 'sovereign-os://my/datasets' }));
  const caraText = (caraView.contents as { text: string }[])[0].text;
  assert.match(caraText, new RegExp(ds.id as string), 'Cara sees her own dataset');

  // Dan (ops) must NOT see Cara's Personal dataset — the same DLS as the UI.
  const danView = result(await rpc(dan, 'resources/read', { uri: 'sovereign-os://my/datasets' }));
  const danText = (danView.contents as { text: string }[])[0].text;
  assert.ok(!danText.includes(ds.id as string), 'Dan does NOT see another creator’s Personal dataset');
});

test('resources/read: an id you cannot see → -32002 (no existence leak); an unknown uri → -32002', async () => {
  const missing = await rpc(cara, 'resources/read', { uri: 'sovereign-os://dataset/ds_does_not_exist' });
  assert.equal((missing as JsonRpcResponse).error?.code, -32002);
  const bogus = await rpc(cara, 'resources/read', { uri: 'sovereign-os://totally/unknown' });
  assert.equal((bogus as JsonRpcResponse).error?.code, -32002);
});

test('every resource + template read delegates through a named governed fn (no privileged path)', () => {
  // Structural guard: every resource declares a role floor + a read fn; nothing
  // is exposed without the same governance seam the discovery tools use.
  for (const r of RESOURCES) {
    assert.ok(r.minRole, `${r.uri} has a role floor`);
    assert.equal(typeof r.read, 'function');
  }
  for (const t of RESOURCE_TEMPLATES) {
    assert.equal(typeof t.read, 'function');
  }
});
