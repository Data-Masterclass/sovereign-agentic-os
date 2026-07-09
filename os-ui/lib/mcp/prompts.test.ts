/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { handleRpc, type JsonRpcResponse } from './server.ts';
import { PROMPTS } from './prompts.ts';

/**
 * MCP PROMPTS: the 11 golden-path workflow templates. `prompts/get` renders TEXT
 * ONLY — it executes nothing, so a prompt can never bypass governance. A creator
 * following a promote step still hits the Builder floor in the actual tool.
 */

const creator: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };
const builder: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'builder' };

function result(res: JsonRpcResponse | null): Record<string, unknown> {
  assert.ok(res && 'result' in res, 'expected a JSON-RPC result');
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}
async function rpc(user: CurrentUser, method: string, params?: Record<string, unknown>) {
  return handleRpc(user, { jsonrpc: '2.0', id: 1, method, params });
}

const EXPECTED = [
  'build_data_product', 'author_and_publish_knowledge', 'connect_data_source',
  'build_agent_system', 'build_and_ship_software', 'define_metric', 'build_dashboard',
  'create_big_bet', 'upload_and_share_file', 'score_and_wire_prediction',
  // mcp-v2 surfaces wave — one golden-path prompt per new surface.
  'frame_strategy', 'reuse_from_marketplace', 'work_the_queue', 'check_my_runs',
  'orient_me',
];

test('prompts/list: exposes exactly the 15 golden-path prompts', async () => {
  const r = result(await rpc(creator, 'prompts/list'));
  const names = (r.prompts as { name: string }[]).map((p) => p.name);
  assert.equal(PROMPTS.length, 15);
  for (const n of EXPECTED) assert.ok(names.includes(n), `missing prompt ${n}`);
  assert.equal(names.length, 15);
});

test('prompts/get: score_and_wire_prediction renders the Science golden path honestly', async () => {
  const r = result(await rpc(creator, 'prompts/get', { name: 'score_and_wire_prediction', arguments: { model: 'churn_model' } }));
  const text = (r.messages as { content: { text: string } }[])[0].content.text;
  assert.match(text, /YOUR ROLE: creator/, 'a live role banner');
  assert.match(text, /list_models/, 'discovers scoreable models first');
  assert.match(text, /get_model/, 'reads the model card');
  assert.match(text, /science_predict/, 'scores through the governed door');
  assert.match(text, /ml\.enabled=false/, 'states the honest ml-disabled behaviour');
  assert.match(text, /⛔/, 'the human promote gate is marked');
  assert.match(text, /Science — golden path/i, 'the science guide is embedded');
});

test('prompts/get: returns a rendered user message with the live role banner + step script + guide', async () => {
  const r = result(await rpc(creator, 'prompts/get', { name: 'build_data_product', arguments: { name: 'Orders' } }));
  const msgs = r.messages as { role: string; content: { type: string; text: string } }[];
  assert.equal(msgs[0].role, 'user');
  const text = msgs[0].content.text;
  assert.match(text, /YOUR ROLE: creator/, 'a live role banner');
  assert.match(text, /CREATOR/, 'the creator lockdown is stated up front');
  assert.match(text, /request_promotion/, 'the script names the real tool sequence');
  assert.match(text, /⛔/, 'the Builder checkpoint is marked');
  assert.match(text, /golden path/i, 'the pathway guide is embedded');
});

test('prompts/get: the banner is role-aware — a builder is told they CAN approve', async () => {
  const r = result(await rpc(builder, 'prompts/get', { name: 'build_data_product', arguments: { name: 'Orders' } }));
  const text = (r.messages as { content: { text: string } }[])[0].content.text;
  assert.match(text, /YOUR ROLE: builder/);
  assert.match(text, /CAN approve/i);
});

test('prompts/get: a missing required argument → -32602 (rendered nothing, executed nothing)', async () => {
  const res = await rpc(creator, 'prompts/get', { name: 'build_data_product', arguments: {} });
  assert.equal((res as JsonRpcResponse).error?.code, -32602);
});

test('prompts/get: an unknown prompt → -32602', async () => {
  const res = await rpc(creator, 'prompts/get', { name: 'no_such_prompt', arguments: {} });
  assert.equal((res as JsonRpcResponse).error?.code, -32602);
});

test('NO BYPASS: prompts/get executes nothing — it returns text, never a governed side effect', async () => {
  // Rendering the promote-heavy prompt as a creator yields only a message; the
  // real gate still lives in approve_promotion (proven in write-tools.test.ts).
  const res = await rpc(creator, 'prompts/get', { name: 'upload_and_share_file', arguments: { name: 'x.md' } });
  const r = result(res);
  assert.ok(Array.isArray(r.messages), 'text only');
  assert.equal((r.messages as unknown[]).length, 1);
});
