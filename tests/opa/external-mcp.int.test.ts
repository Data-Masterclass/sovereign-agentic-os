/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * FEATURE:    External MCP tools in the chat, decided by the chart's real OPA
 * USER STORY: As a user I want the chat to use my Notion as me, with OPA deciding every call.
 * ARCHITECTURE: external-mcp.int.test — the chat's external MCP tools on the chart's REAL OPA, with the real connections
 * store, MCP client, confirm gate and `save_knowledge_note` against a stub of Notion's MCP server over HTTP
 * (no real Notion call). The policy is `external_mcp.rego`, loaded by the chart's own OPA ConfigMap.
 *   - a read is allowed by OPA and reaches the stub with the user's token;
 *   - a write is parked by the gate (OPA answers requires_approval) and the stub sees none; after the
 *     confirmation OPA allows it and the stub sees exactly one;
 *   - TWIN: another user handed the same connection is denied BY OPA (the source is bypassed here on purpose);
 *   - TWIN: a shared connection with per-user OAuth is denied to anyone but its owner;
 *   - the import saves My-scope notes through the governed tool, and a re-import updates the same note.
 *
 * Run: OPA_IT_URL=http://127.0.0.1:18181 node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test ../tests/opa/external-mcp.int.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const OPA = process.env.OPA_IT_URL;
if (!OPA) throw new Error('external-mcp.int.test needs OPA_IT_URL (a real OPA container)');
process.env.OPA_URL = OPA;
process.env.OS_OPA_DATA_BUNDLE = '';
await import('./it-auth.ts');
const { startNotionStub, fetchToStub } = await import('@core/testing/notion-mcp-stub'); // captures the real fetch
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) =>
  String(url).startsWith(OPA!) ? nativeFetch(url, init) : Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { userConfirmGate } = await import('@core/runtime/confirm-gate');
const { loadExternalTools, withExternalTools, externalClassifier, wireName, opaDecision, IMPORT_TOOL } = await import('@core/runtime/external-mcp');
const { createConnection, storeNotionConnection } = await import('@tabs/connections/lib/store');
const { createNotionMcpSource } = await import('@tabs/connections/lib/external-mcp-source');
const { knowledgeWriteTools } = await import('@tabs/knowledge/mcp/knowledge-write-tools');
const { listPersonalKnowledge } = await import('@tabs/knowledge/lib/personal-store');
const { config } = await import('@core/kernel/config');
config.opaFailOpen = true; // the knowledge index's own OPA read is not under test

const nora = { id: 'nora-it', name: 'Nora', domains: ['sales'], role: 'creator' as const };
const omar = { id: 'omar-it', name: 'Omar', domains: ['sales'], role: 'builder' as const };
const stub = await startNotionStub([{ id: 'p1', title: 'Plan', url: 'https://www.notion.so/p1', text: '# Plan\n\nbody', lastEdited: '2026-11-01T00:00:00Z' }]);
const c = await createConnection(nora, { name: 'My Notion', template: 'notion-mcp', endpoint: '', credential: '' });
await storeNotionConnection(c.id, nora.id, { accessToken: 'AT', refreshToken: 'RT', expiresAt: Math.floor(Date.now() / 1000) + 3600 },
  { clientId: 'cid', tokenEndpoint: 'https://mcp.notion.com/token', mcpEndpoint: 'https://mcp.notion.com/mcp', resource: 'https://mcp.notion.com/mcp' });
const source = createNotionMcpSource({ fetchImpl: fetchToStub(stub) });
const deps = { source, decide: opaDecision };

const saveTool = knowledgeWriteTools.find((t) => t.name === 'save_knowledge_note')!;
const inner = (user: typeof nora) => async (name: string, args: Record<string, unknown>) =>
  name === 'save_knowledge_note'
    ? { text: JSON.stringify(await saveTool.call(user, args)), isError: false }
    : { text: '{"error":{"code":"unknown_tool","reason":"x","hint":""}}', isError: true };
const parked: unknown[] = [];
const gated = userConfirmGate(withExternalTools(nora, inner(nora), deps), {
  userId: nora.id, conversationId: 'conv-it', surface: 'ask', classify: externalClassifier(nora, deps),
}, { create: (r) => { parked.push(r); return { confirmationId: 'c1', tool: r.tool, args: r.args, expiresAt: 'x' }; } });

test('a read is allowed by OPA and reaches Notion with the user\'s token', async () => {
  const r = await gated(wireName('notion', c.id, 'notion-search'), { query: 'Plan' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.parked, undefined);
  assert.equal(stub.calls.at(-1)!.token, 'AT');
});

test('a write is parked (OPA: requires_approval); confirmed, OPA allows it and the stub sees exactly one', async () => {
  const name = wireName('notion', c.id, 'notion-create-pages');
  const out = await gated(name, { pages: [] });
  assert.ok(out.parked);
  assert.equal(stub.writes.length, 0);
  const done = await withExternalTools(nora, inner(nora), { ...deps, confirmed: true })(name, { pages: [] });
  assert.equal(done.isError, false, done.text);
  assert.equal(stub.writes.length, 1);
});

test('TWIN: another user handed the same connection is denied by OPA, not by the source', async () => {
  // The source is made to answer as Nora for Omar, so the only thing that can refuse him is OPA.
  const lenient = { ...source, listConnections: async () => source.listConnections(nora), listTools: async () => source.listTools(nora, c.id) };
  const r = await withExternalTools(omar, inner(omar), { source: lenient, decide: opaDecision })(wireName('notion', c.id, 'notion-search'), { query: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /policy_denied/);
  assert.match(r.text, /not yours/i);
  const x = await loadExternalTools(omar, { source: lenient, decide: opaDecision });
  assert.deepEqual(x.specs, [], 'OPA hides the connection from the tool list too');
});

test('TWIN: a Shared connection with per-user OAuth is still owner-only', async () => {
  const shared = { ...(await source.listConnections(nora))[0], visibility: 'Shared' };
  const lenient = { ...source, listConnections: async () => [shared], listTools: async () => source.listTools(nora, c.id) };
  const r = await withExternalTools(omar, inner(omar), { source: lenient, decide: opaDecision })(wireName('notion', c.id, 'notion-search'), { query: 'x' });
  assert.match(r.text, /owner/);
  assert.equal(JSON.parse(r.text).error.code, 'policy_denied');
});

test('the import saves a My-scope note through the governed tool; a re-import updates it', async () => {
  const args = { connectionId: c.id, pages: [{ id: 'p1' }] };
  assert.equal((await gated(IMPORT_TOOL, args)).parked !== undefined, true);
  const confirmed = withExternalTools(nora, inner(nora), { ...deps, confirmed: true });
  const one = JSON.parse((await confirmed(IMPORT_TOOL, args)).text);
  assert.equal(one.imported[0].action, 'created');
  const two = JSON.parse((await confirmed(IMPORT_TOOL, args)).text);
  assert.equal(two.imported[0].action, 'updated');
  assert.equal(listPersonalKnowledge(nora).mine.length, 1);
});

test('shutdown', async () => { await stub.close(); });
