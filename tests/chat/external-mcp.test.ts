/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    External MCP tools in the chat + import into knowledge — behaviour, each with a negative twin
 * USER STORY: As a user I want the chat to use my Notion as me, to hold any write for my confirmation,
 *             and to copy the pages I pick into My knowledge without duplicates or silent gaps.
 * ARCHITECTURE: the REAL connections store, source, MCP client, confirm gate and `save_knowledge_note`,
 *   against a stub of Notion's MCP server over real HTTP. The OPA decision is a test double here
 *   (`decide`); the real policy runs in tests/opa/external-mcp.int.test.ts.
 */
import { test, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { userConfirmGate, type ConfirmationPort } from '@core/runtime/confirm-gate';
import type { ToolExecutor } from '@core/runtime/agentic';
import {
  loadExternalTools, withExternalTools, externalClassifier, wireName, parseWire, noteMarkdown,
  PREVIEW_TOOL, IMPORT_TOOL, IMPORT_MAX_PAGES, type DecideFn, type ExternalMcpSource, type TraceFn,
} from '@core/runtime/external-mcp';
import type { TraceEvent } from '@core/infra/agent-governed';
import { startNotionStub, fetchToStub, type NotionStub, type StubPage } from '@core/testing/notion-mcp-stub';

const realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const { createConnection, storeNotionConnection, __resetConnections } = await import('@tabs/connections/lib/store');
const { createNotionMcpSource } = await import('@tabs/connections/lib/external-mcp-source');
const { knowledgeWriteTools } = await import('@tabs/knowledge/mcp/knowledge-write-tools');
const { __resetStore, listPersonalKnowledge, getPersonalKnowledge } = await import('@tabs/knowledge/lib/personal-store');
const { __resetIndex } = await import('@tabs/knowledge/lib/index-store');

const nora: CurrentUser = { id: 'nora', name: 'Nora', domains: ['sales'], role: 'creator' };
const omar: CurrentUser = { id: 'omar', name: 'Omar', domains: ['sales'], role: 'builder' };
const nowSec = () => Math.floor(Date.now() / 1000);

const pages: StubPage[] = [
  { id: 'p1', title: 'Q3 plan', url: 'https://www.notion.so/p1', text: '# Q3 plan\n\nShip the thing.', lastEdited: '2026-11-01T10:00:00.000Z' },
  { id: 'p2', title: 'Q3 retro', url: 'https://www.notion.so/p2', text: '# Retro\n\nWhat went well.', lastEdited: '2026-11-02T10:00:00.000Z' },
  { id: 'big', title: 'Q3 giant', url: 'https://www.notion.so/big', text: 'x'.repeat(513 * 1024), lastEdited: '2026-11-03T10:00:00.000Z' },
];

/** The policy double: owner only, read allows, a write needs `confirmed`. */
const decide: DecideFn = async (i) => {
  const inp = i as { user: { id: string }; connection: { owner: string }; read_only: boolean; confirmed: boolean };
  if (inp.connection.owner !== inp.user.id) return { effect: 'deny', reason: 'connection_not_visible' };
  if (inp.read_only) return { effect: 'allow', reason: 'read' };
  return inp.confirmed ? { effect: 'allow', reason: 'confirmed' } : { effect: 'requires_approval', reason: 'write_needs_confirmation' };
};

let stub: NotionStub;
let source: ExternalMcpSource;
let connId: string;
before(async () => { stub = await startNotionStub(pages); });
after(async () => { await stub.close(); globalThis.fetch = realFetch; });

const realOpaFailOpen = config.opaFailOpen;
beforeEach(async () => {
  config.opaFailOpen = true;
  __resetConnections(); __resetStore(); __resetIndex();
  stub.calls.length = 0; stub.writes.length = 0;
  stub.mode.down = false; stub.mode.unauthorized = false; stub.mode.refuseRefresh = false;
  const c = await createConnection(nora, { name: 'My Notion', template: 'notion-mcp', endpoint: '', credential: '' });
  connId = c.id;
  await storeNotionConnection(c.id, nora.id, { accessToken: 'AT', refreshToken: 'RT', expiresAt: nowSec() + 3600 },
    { clientId: 'cid', tokenEndpoint: 'https://mcp.notion.com/token', mcpEndpoint: 'https://mcp.notion.com/mcp', resource: 'https://mcp.notion.com/mcp' });
  source = createNotionMcpSource({ fetchImpl: fetchToStub(stub) });
});
afterEach(() => { config.opaFailOpen = realOpaFailOpen; });

const saveTool = knowledgeWriteTools.find((t) => t.name === 'save_knowledge_note')!;
/** The governed inner executor: only the real `save_knowledge_note`, recording every tool it was asked for. */
function inner(user: CurrentUser, seen: string[] = []): ToolExecutor {
  return async (name, args) => {
    seen.push(name);
    if (name !== 'save_knowledge_note') return { text: JSON.stringify({ error: { code: 'unknown_tool', reason: name, hint: '' } }), isError: true };
    return { text: JSON.stringify(await saveTool.call(user, args)), isError: false };
  };
}
const deps = () => ({ source, decide });
const run = (user: CurrentUser, name: string, args: Record<string, unknown>, o: { confirmed?: boolean; seen?: string[] } = {}) =>
  withExternalTools(user, inner(user, o.seen), { ...deps(), confirmed: o.confirmed })(name, args);
const json = (t: string) => JSON.parse(t) as Record<string, any>;

// ---------------------------------------------------------------- tools offered ---

test('the owner gets the Notion tools, namespaced per connection', async () => {
  const x = await loadExternalTools(nora, deps());
  assert.ok(x.specs.some((s) => s.name === wireName('notion', connId, 'notion-search')));
  assert.ok(x.specs.some((s) => s.name === PREVIEW_TOOL) && x.specs.some((s) => s.name === IMPORT_TOOL));
  for (const s of x.specs) assert.match(s.name, /^[A-Za-z0-9_-]{1,64}$/, 'a valid tool name for OpenAI-compatible APIs');
  assert.deepEqual(parseWire(wireName('notion', connId, 'notion-fetch')), { provider: 'notion', connectionId: connId, tool: 'notion-fetch' });
});

test('TWIN: a user without the connection gets no Notion tools, and not even the import tools', async () => {
  const x = await loadExternalTools(omar, deps());
  assert.deepEqual(x.specs, []);
  assert.equal(x.any, false);
});

test("TWIN: one user's connection cannot be used by another user, even by guessing its id", async () => {
  const r = await run(omar, wireName('notion', connId, 'notion-search'), { query: 'Q3' });
  assert.equal(r.isError, true);
  assert.equal(json(r.text).error.code, 'unknown_connection');
  assert.equal(stub.calls.length, 0, 'nothing reached Notion');
  // and the source itself refuses, whatever the policy says
  await assert.rejects(source.call(omar, connId, 'notion-search', { query: 'Q3' }), /not yours/);
  const own = await run(nora, wireName('notion', connId, 'notion-search'), { query: 'Q3' });
  assert.equal(own.isError, false);
});

test('a read runs as the user: Notion receives the user\'s token, the model gets no token', async () => {
  const r = await run(nora, wireName('notion', connId, 'notion-search'), { query: 'plan' });
  assert.equal(r.isError, false);
  assert.equal(stub.calls[0].token, 'AT');
  assert.equal(r.text.includes('AT'), false);
  assert.equal(JSON.stringify(await loadExternalTools(nora, deps())).includes('"AT"'), false);
});

// ---------------------------------------------------------------- reads free, writes park ---

const port = (parked: unknown[]): ConfirmationPort => ({
  create: (req) => { parked.push(req); return { confirmationId: 'c1', tool: req.tool, args: req.args, expiresAt: 'x' }; },
});
const gated = (user: CurrentUser, parked: unknown[]) =>
  userConfirmGate(withExternalTools(user, inner(user), deps()), {
    userId: user.id, conversationId: 'conv-1', surface: 'ask', classify: externalClassifier(user, deps()),
  }, port(parked));

test('a Notion write tool parks behind the confirm card; the stub saw no write', async () => {
  const parked: unknown[] = [];
  const out = await gated(nora, parked)(wireName('notion', connId, 'notion-create-pages'), { pages: [{ title: 'x' }] });
  assert.ok(out.parked, 'parked');
  assert.equal(parked.length, 1);
  assert.equal(stub.writes.length, 0);
});

test('TWIN: a Notion read runs at once, with no card', async () => {
  const parked: unknown[] = [];
  const out = await gated(nora, parked)(wireName('notion', connId, 'notion-search'), { query: 'plan' });
  assert.equal(out.parked, undefined);
  assert.equal(parked.length, 0);
  assert.equal(stub.calls.length, 1);
});

test('after the same user confirms, the write runs once; unconfirmed, the executor refuses it too', async () => {
  const direct = await run(nora, wireName('notion', connId, 'notion-create-pages'), { pages: [] });
  assert.equal(json(direct.text).error.code, 'needs_confirmation', 'the second layer: no confirmation, no call');
  assert.equal(stub.writes.length, 0);
  const done = await run(nora, wireName('notion', connId, 'notion-create-pages'), { pages: [] }, { confirmed: true });
  assert.equal(done.isError, false);
  assert.equal(stub.writes.length, 1);
});

test('preview is a read: no card; import is a write: parks, and does not run unconfirmed', async () => {
  const parked: unknown[] = [];
  const g = gated(nora, parked);
  assert.equal((await g(PREVIEW_TOOL, { connectionId: connId, query: 'Q3' })).parked, undefined);
  const imp = await g(IMPORT_TOOL, { connectionId: connId, pages: [{ id: 'p1' }, { id: 'p2' }] });
  assert.ok(imp.parked);
  assert.equal(parked.length, 1, 'ONE card for the whole selection');
  assert.equal(listPersonalKnowledge(nora).mine.length, 0, 'nothing saved before the confirmation');
  const direct = await run(nora, IMPORT_TOOL, { connectionId: connId, pages: [{ id: 'p1' }] });
  assert.equal(json(direct.text).error.code, 'needs_confirmation');
});

// ---------------------------------------------------------------- preview ---

test('the preview lists title, link, size and last edited, and states the limits', async () => {
  const r = await run(nora, PREVIEW_TOOL, { connectionId: connId, query: 'Q3' });
  const p = json(r.text);
  assert.equal(p.found, 3);
  const first = p.pages.find((x: any) => x.id === 'p1');
  assert.equal(first.title, 'Q3 plan');
  assert.equal(first.url, 'https://www.notion.so/p1');
  assert.equal(first.lastEdited, '2026-11-01T10:00:00.000Z');
  assert.equal(first.sizeBytes, Buffer.byteLength('# Q3 plan\n\nShip the thing.'));
  assert.equal(p.pages.find((x: any) => x.id === 'big').importable, false);
  assert.match(p.limits, /512 KB/);
  assert.equal(listPersonalKnowledge(nora).mine.length, 0, 'a preview saves nothing');
});

// ---------------------------------------------------------------- import ---

test('the import writes knowledge notes in My scope — and only save_knowledge_note, never a workflow', async () => {
  const seen: string[] = [];
  const r = await run(nora, IMPORT_TOOL, { connectionId: connId, pages: [{ id: 'p1', title: 'Q3 plan' }, { id: 'p2' }] }, { confirmed: true, seen });
  assert.equal(r.isError, false);
  const out = json(r.text);
  assert.equal(out.imported.length, 2);
  assert.deepEqual([...new Set(seen)], ['save_knowledge_note'], 'no workflow tool was ever asked for');
  const mine = listPersonalKnowledge(nora).mine;
  assert.equal(mine.length, 2);
  assert.ok(mine.every((n) => n.visibility === 'Personal' && n.owner === 'nora'));
  assert.equal(mine[0].folder, '/imports/notion');
  assert.equal(listPersonalKnowledge(omar).mine.length, 0, "not in anyone else's scope");
});

test('TWIN: the same call asking for a workflow tool would be refused by the governed door, not saved', async () => {
  const seen: string[] = [];
  const r = await inner(nora, seen)('author_knowledge', { title: 'x' });
  assert.equal(r.isError, true);
});

test('provenance is stored: source, page id, url, last_edited, imported_at, imported_by', async () => {
  await run(nora, IMPORT_TOOL, { connectionId: connId, pages: [{ id: 'p1' }] }, { confirmed: true });
  const note = getPersonalKnowledge(listPersonalKnowledge(nora).mine[0].id, nora);
  assert.match(note.md, /^---\nsource: "notion"\n/);
  assert.match(note.md, /source_page_id: "p1"/);
  assert.match(note.md, /source_url: "https:\/\/www\.notion\.so\/p1"/);
  assert.match(note.md, /last_edited: "2026-11-01T10:00:00\.000Z"/);
  assert.match(note.md, /imported_at: "\d{4}-\d\d-\d\dT/);
  assert.match(note.md, /imported_by: "nora"/);
  assert.match(note.md, /# Q3 plan\n\nShip the thing\./, 'the page body follows as markdown');
  assert.equal(note.sourceKey, `notion:${connId}:p1`);
});

test('re-importing a page updates its note; it never creates a duplicate', async () => {
  await run(nora, IMPORT_TOOL, { connectionId: connId, pages: [{ id: 'p1' }] }, { confirmed: true });
  const id1 = listPersonalKnowledge(nora).mine[0].id;
  stub.pages.get('p1')!.text = '# Q3 plan\n\nChanged in Notion.';
  const again = json((await run(nora, IMPORT_TOOL, { connectionId: connId, pages: [{ id: 'p1' }] }, { confirmed: true })).text);
  const mine = listPersonalKnowledge(nora).mine;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, id1);
  assert.equal(again.imported[0].action, 'updated');
  assert.match(getPersonalKnowledge(id1, nora).md, /Changed in Notion\./);
});

test('TWIN: a different page is a new note', async () => {
  await run(nora, IMPORT_TOOL, { connectionId: connId, pages: [{ id: 'p1' }] }, { confirmed: true });
  await run(nora, IMPORT_TOOL, { connectionId: connId, pages: [{ id: 'p2' }] }, { confirmed: true });
  assert.equal(listPersonalKnowledge(nora).mine.length, 2);
});

test('a partial import reports each failed page; nothing is silently skipped', async () => {
  const r = await run(nora, IMPORT_TOOL, { connectionId: connId, pages: [{ id: 'p1' }, { id: 'gone' }, { id: 'big' }] }, { confirmed: true });
  const out = json(r.text);
  assert.equal(r.isError, false);
  assert.equal(out.imported.length, 1);
  const byId = Object.fromEntries(out.failed.map((f: any) => [f.pageId, f]));
  assert.equal(byId.gone.code, 'no_access');
  assert.match(byId.gone.reason, /no access/i);
  assert.equal(byId.big.code, 'too_large');
  assert.match(out.summary, /1 imported.*2 failed/);
});

test('when every page fails the result is an error, not a success', async () => {
  const r = await run(nora, IMPORT_TOOL, { connectionId: connId, pages: [{ id: 'gone' }] }, { confirmed: true });
  assert.equal(r.isError, true);
  assert.equal(json(r.text).error.code, 'import_failed');
});

test('the selection is capped, and a truncated page is saved as truncated and said so', async () => {
  const many = Array.from({ length: IMPORT_MAX_PAGES + 1 }, (_, i) => ({ id: `p${i}` }));
  const r = await run(nora, IMPORT_TOOL, { connectionId: connId, pages: many }, { confirmed: true });
  assert.equal(json(r.text).error.code, 'invalid_request');
  stub.pages.set('long', { id: 'long', title: 'Long', url: 'https://www.notion.so/long', text: 'start', lastEdited: '2026-11-04T00:00:00Z', truncated: true });
  const t = json((await run(nora, IMPORT_TOOL, { connectionId: connId, pages: [{ id: 'long' }] }, { confirmed: true })).text);
  assert.match(t.imported[0].partial, /first part/);
  assert.match(getPersonalKnowledge(t.imported[0].noteId, nora).md, /truncated_by_source: true/);
});

test('noteMarkdown is pure and escapes values', () => {
  const md = noteMarkdown({ provider: 'notion', connectionId: 'c', pageId: 'a"b', page: { title: 't', url: 'u', lastEdited: null, markdown: 'm', truncated: false }, importedAt: 'now', importedBy: 'me' });
  assert.match(md, /source_page_id: "a\\"b"/);
  assert.match(md, /last_edited: "not reported"/);
});

// ---------------------------------------------------------------- typed errors ---

test('an expired sign-in that cannot be refreshed is a plain oauth_expired error, and the connection asks to reconnect', async () => {
  const c2 = await createConnection(nora, { name: 'Old Notion', template: 'notion-mcp', endpoint: '', credential: '' });
  await storeNotionConnection(c2.id, nora.id, { accessToken: 'old', refreshToken: 'RT', expiresAt: nowSec() - 60 },
    { clientId: 'cid', tokenEndpoint: 'https://mcp.notion.com/token', mcpEndpoint: 'https://mcp.notion.com/mcp', resource: 'https://mcp.notion.com/mcp' });
  stub.mode.refuseRefresh = true;
  const r = await run(nora, wireName('notion', c2.id, 'notion-search'), { query: 'x' });
  assert.equal(json(r.text).error.code, 'oauth_expired');
  assert.match(json(r.text).error.hint, /Reconnect/);
  const x = await loadExternalTools(nora, deps());
  assert.ok(x.notes.some((n) => /Old Notion/.test(n) && /oauth_expired/.test(n)), 'the turn says so, not silence');
});

test('TWIN: an expired token that CAN be refreshed is refreshed and the call goes through', async () => {
  const c2 = await createConnection(nora, { name: 'Stale Notion', template: 'notion-mcp', endpoint: '', credential: '' });
  await storeNotionConnection(c2.id, nora.id, { accessToken: 'old', refreshToken: 'RT', expiresAt: nowSec() - 60 },
    { clientId: 'cid', tokenEndpoint: 'https://mcp.notion.com/token', mcpEndpoint: 'https://mcp.notion.com/mcp', resource: 'https://mcp.notion.com/mcp' });
  const r = await run(nora, wireName('notion', c2.id, 'notion-search'), { query: 'plan' });
  assert.equal(r.isError, false);
  assert.equal(stub.calls.at(-1)!.token, 'AT-refreshed');
});

test('an unreachable MCP server is a plain mcp_unreachable error', async () => {
  const fresh = createNotionMcpSource({ fetchImpl: fetchToStub(stub) }); // no cached tool list
  stub.mode.down = true;
  const r = await withExternalTools(nora, inner(nora), { source: fresh, decide })(wireName('notion', connId, 'notion-search'), { query: 'x' });
  assert.equal(r.isError, true);
  assert.equal(json(r.text).error.code, 'mcp_unreachable');
  const x = await loadExternalTools(nora, { source: fresh, decide });
  assert.ok(x.notes.some((n) => /mcp_unreachable/.test(n)));
});

test('a page the account cannot open is a plain no_access error', async () => {
  const r = await run(nora, wireName('notion', connId, 'notion-fetch'), { id: 'secret' });
  assert.equal(json(r.text).error.code, 'no_access');
});

test('no policy answer is a refusal, never a call', async () => {
  const down: DecideFn = async () => ({ effect: 'deny', reason: 'policy_unreachable' });
  const r = await withExternalTools(nora, inner(nora), { source, decide: down })(wireName('notion', connId, 'notion-search'), { query: 'x' });
  assert.equal(json(r.text).error.code, 'policy_unreachable');
  assert.equal(stub.calls.length, 0);
});

// ---------------------------------------------------------------- audit: who acted, whose credential ---

const recorder = () => {
  const events: TraceEvent[] = [];
  const trace: TraceFn = async (e) => { events.push(e); };
  return { events, trace };
};

test('audit: a Notion read is traced with the acting user and the connection owner\'s credential, never the token', async () => {
  const { events, trace } = recorder();
  const r = await withExternalTools(nora, inner(nora), { source, decide, trace })(wireName('notion', connId, 'notion-search'), { query: 'plan', api_key: 'sk-x' });
  assert.equal(r.isError, false);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.actingUser, 'nora');
  assert.equal(e.credentialMode, 'shared');
  assert.equal(e.credentialSubject, 'nora');
  assert.equal(e.decision, 'allow');
  assert.equal(e.tool, 'notion.notion-search');
  assert.match(String(e.principal), /^conn-/, 'keyed by the connection principal');
  const text = JSON.stringify(e);
  assert.equal(text.includes('"AT"'), false, 'the OAuth token never reaches the trace');
  assert.equal(text.includes('sk-x'), false, 'a secret-named arg is redacted');
});

test('audit TWIN: a parked write and a policy refusal are traced too (not only the calls that ran)', async () => {
  const { events, trace } = recorder();
  await withExternalTools(nora, inner(nora), { source, decide, trace })(wireName('notion', connId, 'notion-create-pages'), { pages: [] });
  assert.equal(events[0].decision, 'requires_approval');
  assert.equal(events[0].actingUser, 'nora');
  const down: DecideFn = async () => ({ effect: 'deny', reason: 'policy_unreachable' });
  await withExternalTools(nora, inner(nora), { source, decide: down, trace })(wireName('notion', connId, 'notion-search'), { query: 'x' });
  assert.equal(events[1].decision, 'deny');
  assert.equal(events[1].credentialSubject, 'nora');
  assert.equal(stub.writes.length, 0);
});
