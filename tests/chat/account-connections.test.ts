/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Account connections in the Home chat — per-user sign-in, Microsoft 365 / OneDrive / Google Drive /
 *             Notion tools, revoke, refresh, email → knowledge and spreadsheet → dataset; each with a negative twin
 * USER STORY: As a user I want the chat to read MY mail, files and Notion with MY own sign-in, never anyone
 *             else's, and to save what it extracted into the OS behind my confirmation.
 * ARCHITECTURE: the REAL connections store, per-user credential store, account source, kernel external-tool
 *   layer, confirm gate and `save_knowledge_note`, against fakes of Microsoft Graph, Google Drive and Notion's
 *   MCP server. The OPA decision is a double that mirrors external_mcp.rego (the policy has its own rego tests).
 */
import { test, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { userConfirmGate, type ConfirmationPort } from '@core/runtime/confirm-gate';
import type { ToolExecutor } from '@core/runtime/agentic';
import {
  loadExternalTools, withExternalTools, externalClassifier, externalPromptBlock, wireName,
  PREVIEW_TABLE_TOOL, IMPORT_TABLE_TOOL, EXTRACT_WRITE_TOOLS, type DecideFn,
} from '@core/runtime/external-mcp';
import { connectCards } from '@core/ui/chat-view';
import { startNotionStub, fetchToStub, type NotionStub } from '@core/testing/notion-mcp-stub';
import { fakeApi, xlsx, type Route } from '@core/testing/account-fixtures';
import type { TokenSet } from '@core/auth/token-set';

const realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const store = await import('@tabs/connections/lib/store');
const { createAccountSource } = await import('@tabs/connections/lib/external-mcp-source');
const { registerUserRevocation, revokeUserEverywhere, __resetUserRevocations } = await import('@core/kernel/user-revocation');
const { knowledgeWriteTools } = await import('@tabs/knowledge/mcp/knowledge-write-tools');
const { __resetStore, getPersonalKnowledge } = await import('@tabs/knowledge/lib/personal-store');
const { __resetIndex } = await import('@tabs/knowledge/lib/index-store');

const dana: CurrentUser = { id: 'dana', name: 'Dana', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'domain_admin' };
const anna: CurrentUser = { id: 'anna', name: 'Anna', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' };
const ben: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' };
const hugo: CurrentUser = { id: 'hugo', name: 'Hugo', domains: ['hr'], allDomains: ['hr'], activeDomain: null, role: 'creator' };
const nowSec = () => Math.floor(Date.now() / 1000);
const tok = (accessToken: string, ttl = 3600, refreshToken = `R-${accessToken}`): TokenSet => ({ accessToken, refreshToken, expiresAt: nowSec() + ttl });

/** Mirrors external_mcp.rego: visibility, archived, the token rule by credential mode, read/confirm. */
const decide: DecideFn = async (i) => {
  const inp = i as { user: { id: string; domains: string[] }; connection: { owner: string; domain: string; visibility: string; auth: string; archived: boolean; credential_mode?: string }; read_only: boolean; confirmed: boolean };
  const c = inp.connection;
  const visible = c.owner === inp.user.id || ((c.visibility === 'Shared' || c.visibility === 'Certified') && (!c.domain || inp.user.domains.includes(c.domain)));
  if (!visible) return { effect: 'deny', reason: 'connection_not_visible' };
  if (c.archived) return { effect: 'deny', reason: 'archived' };
  const tokenOk = c.auth !== 'oauth' || c.owner === inp.user.id || c.credential_mode === 'per_user' || c.credential_mode === 'shared';
  if (!tokenOk) return { effect: 'deny', reason: 'token_belongs_to_owner' };
  if (inp.read_only) return { effect: 'allow', reason: 'read' };
  return inp.confirmed ? { effect: 'allow', reason: 'confirmed' } : { effect: 'requires_approval', reason: 'write_needs_confirmation' };
};

// ---------------------------------------------------------------- fake vendors ---

const budgetXlsx = xlsx({ Notes: [['hi']], 'Budget 2026': [['Cost centre', 'Amount', 'Due'], ['Marketing', 500, { date: 46023 }], ['R&D, Labs', 700.5, { date: 46054 }]] }, { deflate: true });

const graphRoutes: Route[] = [
  { match: /\/v1\.0\/me\/messages\?\$search=/, reply: (u) => ({ json: { value: [{ id: 'm1', subject: `Budget decisions (${u.searchParams.get('$search')})`, from: { emailAddress: { address: 'cfo@example.com' } }, receivedDateTime: '2026-11-20T09:00:00Z', bodyPreview: 'We decided…', webLink: 'https://outlook.office.com/m1' }] } }) },
  { match: /\/v1\.0\/me\/messages\/m1\?/, reply: () => ({ json: { id: 'm1', subject: 'Budget decisions', from: { emailAddress: { address: 'cfo@example.com' } }, toRecipients: [{ emailAddress: { address: 'anna@example.com' } }], receivedDateTime: '2026-11-20T09:00:00Z', webLink: 'https://outlook.office.com/m1', body: { contentType: 'text', content: 'Decision 1: freeze hiring.\nDecision 2: Q1 budget is 1.2M.' } } }) },
  { match: /\/v1\.0\/me\/calendarView\?/, reply: () => ({ json: { value: [{ id: 'e1', subject: 'Budget review', start: { dateTime: '2026-11-25T10:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-11-25T11:00:00' }, organizer: { emailAddress: { address: 'cfo@example.com' } }, location: { displayName: 'Room 1' }, webLink: 'https://outlook.office.com/e1' }] } }) },
  { match: /\/v1\.0\/search\/query$/, method: 'POST', reply: () => ({ json: { value: [{ hitsContainers: [{ hits: [{ resource: { id: 'x1', name: 'budget.xlsx', size: budgetXlsx.length, lastModifiedDateTime: '2026-11-19T00:00:00Z', webUrl: 'https://contoso.sharepoint.com/budget.xlsx', parentReference: { driveId: 'd1' } } }] }] }] } }) },
  { match: /\/v1\.0\/(me\/drive|drives\/d1)\/items\/x1\?/, reply: () => ({ json: { id: 'x1', name: 'budget.xlsx', size: budgetXlsx.length, file: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, webUrl: 'https://contoso.sharepoint.com/budget.xlsx' } }) },
  { match: /\/v1\.0\/(me\/drive|drives\/d1)\/items\/x1\/content$/, reply: () => ({ bytes: budgetXlsx }) },
  { match: /\/v1\.0\/me\/drive\/items\/big\?/, reply: () => ({ json: { id: 'big', name: 'huge.xlsx', size: 99 * 1024 * 1024, file: { mimeType: 'x' } } }) },
];
const driveRoutes: Route[] = [
  { match: /\/drive\/v3\/files\?q=fullText/, reply: () => ({ json: { files: [{ id: 'g1', name: 'Plan', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-11-01T00:00:00Z', webViewLink: 'https://docs.google.com/g1' }] } }) },
  { match: /\/drive\/v3\/files\/g1\?fields/, reply: () => ({ json: { id: 'g1', name: 'Plan', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/g1' } }) },
  { match: /\/drive\/v3\/files\/g1\/export\?mimeType=text%2Fplain/, reply: () => ({ text: 'The plan: ship it.' }) },
];

let notion: NotionStub;
before(async () => { notion = await startNotionStub([{ id: 'p1', title: 'Q3 plan', url: 'https://www.notion.so/p1', text: '# Q3', lastEdited: '2026-11-01T00:00:00Z' }], ['AT', 'N-BEN']); });
after(async () => { await notion.close(); globalThis.fetch = realFetch; });

let graph: ReturnType<typeof fakeApi>;
let gdrive: ReturnType<typeof fakeApi>;
let refreshed: string[];
let refreshFails: boolean;
let revoked: { provider: string; token: string }[];

/** One fetch for every vendor: Graph, Drive, then Notion's stub. */
function vendorFetch(): typeof fetch {
  const notionFetch = fetchToStub(notion);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input);
    if (u.startsWith('https://graph.microsoft.com')) return graph.fetch(input, init);
    if (u.startsWith('https://www.googleapis.com')) return gdrive.fetch(input, init);
    return notionFetch(input, init);
  }) as typeof fetch;
}

const realOpaFailOpen = config.opaFailOpen;
beforeEach(() => {
  config.opaFailOpen = true;
  store.__resetConnections(); __resetStore(); __resetIndex();
  graph = fakeApi(graphRoutes);
  gdrive = fakeApi(driveRoutes);
  notion.calls.length = 0;
  refreshed = [];
  refreshFails = false;
  revoked = [];
  store.__setProviderRevoke(async (provider, token) => { revoked.push({ provider, token }); return { revoked: provider === 'google', detail: 'test' }; });
});
afterEach(() => { config.opaFailOpen = realOpaFailOpen; });

const source = () => createAccountSource({
  fetchImpl: vendorFetch(),
  refresh: async (_c, prev) => {
    if (refreshFails) throw new Error('invalid_grant');
    refreshed.push(prev.accessToken);
    return { ...prev, accessToken: `${prev.accessToken}-new`, expiresAt: nowSec() + 3600 };
  },
});
const deps = () => ({ source: source(), decide });
const saveTool = knowledgeWriteTools.find((t) => t.name === 'save_knowledge_note')!;
type Seen = { name: string; args: Record<string, unknown> }[];
/** The governed inner executor: the real save_knowledge_note; dataset tools recorded and answered like the governed ones. */
function inner(user: CurrentUser, seen: Seen = []): ToolExecutor {
  return async (name, args) => {
    seen.push({ name, args });
    if (name === 'save_knowledge_note') return { text: JSON.stringify(await saveTool.call(user, args)), isError: false };
    if (name === 'create_dataset') return { text: JSON.stringify({ id: 'ds_new1', name: args.name, owner: user.id, visibility: 'Personal' }), isError: false };
    if (name === 'ingest_dataset') return { text: JSON.stringify({ ok: true, bronzeRegistered: true, rowCount: 2, datasetId: args.datasetId }), isError: false };
    if (name === 'document_dataset') return { text: JSON.stringify({ id: args.datasetId }), isError: false };
    return { text: JSON.stringify({ error: { code: 'unknown_tool', reason: name, hint: '' } }), isError: true };
  };
}
const run = (user: CurrentUser, name: string, args: Record<string, unknown>, o: { confirmed?: boolean; seen?: Seen } = {}) =>
  withExternalTools(user, inner(user, o.seen), { ...deps(), confirmed: o.confirmed })(name, args);
const json = (t: string) => JSON.parse(t) as Record<string, any>;

async function domainM365() {
  return store.createAccountConnection(dana, { kind: 'microsoft-365', name: 'Microsoft 365', scope: 'domain' });
}

// ---------------------------------------------------------------- admin: add a connection ---

test('a domain admin adds a Domain Microsoft 365 connection: per-user by default, visible to the domain', async () => {
  const c = await domainM365();
  assert.equal(c.credentialMode, 'per_user');
  assert.equal(c.visibility, 'Shared');
  assert.equal(c.template, 'microsoft-365');
  assert.ok((await store.listConnectionsForUser(anna)).some((x) => x.id === c.id));
  assert.equal((await store.listConnectionsForUser(hugo)).some((x) => x.id === c.id), false, 'another domain does not see it');
});

test('TWIN: a creator cannot add a Domain connection, and a shared credential needs the warned tick and the role', async () => {
  await assert.rejects(store.createAccountConnection(anna, { kind: 'gdrive', scope: 'domain' }), /domain admin/);
  await assert.rejects(store.createAccountConnection(dana, { kind: 'gdrive', scope: 'domain', credentialMode: 'shared' }), /Tick the confirmation/);
  await assert.rejects(store.createAccountConnection(dana, { kind: 'gdrive', scope: 'company' }), /administrator/);
  await assert.rejects(store.createAccountConnection(dana, { kind: 'slack', scope: 'my' }), /Unknown account connection/);
  const shared = await store.createAccountConnection(dana, { kind: 'gdrive', scope: 'domain', credentialMode: 'shared', sharedAcknowledged: true });
  assert.equal(shared.credentialMode, 'shared');
  const mine = await store.createAccountConnection(anna, { kind: 'notion', scope: 'my' });
  assert.equal(mine.visibility, 'Personal');
});

// ---------------------------------------------------------------- per-user isolation ---

test('per-user: each user runs on their OWN token; a user who has not connected gets needs_connect and a Connect card', async () => {
  const c = await domainM365();
  await store.storeUserAccountCredential(c.id, anna.id, tok('TOKEN-ANNA'), { subject: 'anna@example.com' });
  const tool = wireName('m365', c.id, 'mail_search');

  const a = await run(anna, tool, { query: 'budget' });
  assert.equal(a.isError, false, a.text);
  assert.equal(graph.calls.at(-1)!.token, 'TOKEN-ANNA');
  assert.equal(a.text.includes('TOKEN-ANNA'), false, 'the model never sees a token');

  const before = graph.calls.length;
  const b = await run(ben, tool, { query: 'budget' });
  assert.equal(b.isError, true);
  assert.equal(json(b.text).error.code, 'needs_connect');
  assert.equal(graph.calls.length, before, 'nothing reached Microsoft on Ben\'s behalf — no fallback to Anna\'s token');
  const cards = connectCards([{ name: tool, error: { code: 'needs_connect' } }]);
  assert.deepEqual(cards.map((x) => x.connectionId), [c.id]);
  assert.match(cards[0].href, /^\/api\/connections\/connect\?connectionId=/);

  await store.storeUserAccountCredential(c.id, ben.id, tok('TOKEN-BEN'));
  assert.equal((await run(ben, tool, { query: 'x' })).isError, false);
  assert.equal(graph.calls.at(-1)!.token, 'TOKEN-BEN');
  assert.equal((await run(anna, tool, { query: 'x' })).isError, false);
  assert.equal(graph.calls.at(-1)!.token, 'TOKEN-ANNA');
});

test('TWIN: a user outside the domain gets no tools and cannot call by guessing the id; the record holds no token', async () => {
  const c = await domainM365();
  await store.storeUserAccountCredential(c.id, anna.id, tok('TOKEN-ANNA'));
  const x = await loadExternalTools(hugo, deps());
  assert.equal(x.specs.some((s) => s.name.includes(c.id)), false);
  const r = await run(hugo, wireName('m365', c.id, 'mail_search'), { query: 'x' });
  assert.equal(json(r.text).error.code, 'unknown_connection');
  assert.equal(JSON.stringify(await store.getConnectionForUser(c.id, anna)).includes('TOKEN-ANNA'), false);
});

test('status shows whom you are connected as; disconnect forgets only your own sign-in', async () => {
  const c = await domainM365();
  await store.storeUserAccountCredential(c.id, anna.id, tok('TOKEN-ANNA'), { subject: 'anna@example.com' });
  await store.storeUserAccountCredential(c.id, ben.id, tok('TOKEN-BEN'));
  const s = await store.accountStatus(c.id, anna);
  assert.deepEqual([s.connected, s.subject, s.credentialMode, s.canConnect], [true, 'anna@example.com', 'per_user', true]);
  assert.equal(JSON.stringify(s).includes('TOKEN'), false);
  assert.equal((await store.disconnectAccount(c.id, anna)).disconnected, true);
  assert.equal((await store.accountStatus(c.id, anna)).connected, false);
  assert.equal((await store.accountStatus(c.id, ben)).connected, true, 'Ben is untouched');
});

// ---------------------------------------------------------------- revoke and refresh ---

test('deactivating a user revokes their sign-ins on every per-user connection, nobody else\'s', async () => {
  const c1 = await domainM365();
  const c2 = await store.createAccountConnection(dana, { kind: 'gdrive', scope: 'domain' });
  await store.storeUserAccountCredential(c1.id, anna.id, tok('A1'));
  await store.storeUserAccountCredential(c2.id, anna.id, tok('A2'));
  await store.storeUserAccountCredential(c1.id, ben.id, tok('B1'));
  assert.equal(await store.revokeUserAccountCredentials(anna.id), 2);
  assert.equal(json((await run(anna, wireName('m365', c1.id, 'mail_search'), {})).text).error.code, 'needs_connect');
  assert.equal((await run(ben, wireName('m365', c1.id, 'mail_search'), { query: 'q' })).isError, false);
  assert.equal(await store.revokeUserAccountCredentials(anna.id), 0, 'idempotent');
});

test('an expired token is refreshed silently, stored, and used; a failed refresh asks the user to connect again', async () => {
  const c = await domainM365();
  await store.storeUserAccountCredential(c.id, anna.id, tok('OLD', -10));
  const r = await run(anna, wireName('m365', c.id, 'calendar_events'), {});
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(refreshed, ['OLD']);
  assert.equal(graph.calls.at(-1)!.token, 'OLD-new');
  await run(anna, wireName('m365', c.id, 'calendar_events'), {});
  assert.deepEqual(refreshed, ['OLD'], 'the refreshed token was stored, no second refresh');

  await store.storeUserAccountCredential(c.id, ben.id, tok('STALE', -10));
  refreshFails = true;
  const b = await run(ben, wireName('m365', c.id, 'calendar_events'), {});
  assert.equal(json(b.text).error.code, 'needs_connect');
});

test('concurrent calls refresh once (serialised per user and connection)', async () => {
  const c = await domainM365();
  await store.storeUserAccountCredential(c.id, anna.id, tok('OLD', -10));
  const t = wireName('m365', c.id, 'calendar_events');
  const rs = await Promise.all([run(anna, t, {}), run(anna, t, {}), run(anna, t, {})]);
  assert.ok(rs.every((r) => !r.isError));
  assert.deepEqual(refreshed, ['OLD']);
});

// ---------------------------------------------------------------- shared credential ---

test('shared: everyone in scope runs on the owner\'s credential (the explicit choice), and the audit says whose', async () => {
  const c = await store.createAccountConnection(dana, { kind: 'microsoft-365', scope: 'domain', credentialMode: 'shared', sharedAcknowledged: true });
  await store.completeAccountOAuth(c.id, dana, tok('TOKEN-DANA'));
  const r = await run(ben, wireName('m365', c.id, 'mail_search'), { query: 'x' });
  assert.equal(r.isError, false, r.text);
  assert.equal(graph.calls.at(-1)!.token, 'TOKEN-DANA');
  const s = await store.resolveAccountSession(c.id, ben);
  assert.deepEqual([s.credentialMode, s.credentialSubject], ['shared', 'dana (shared)']);
});

test('TWIN: a legacy connection (no credential mode) stays owner-only', async () => {
  const c = await store.createConnection(anna, { name: 'Old drive', template: 'gdrive', endpoint: '', credential: '' });
  await store.storeConnectionTokens(c.id, anna.id, tok('LEGACY'));
  await assert.rejects(store.resolveAccountSession(c.id, ben), /not yours/);
  assert.equal((await store.resolveAccountSession(c.id, anna)).accessToken, 'LEGACY');
});

// ---------------------------------------------------------------- the four connectors ---

test('Microsoft 365: mail, a message with provenance, calendar and SharePoint search, read-only', async () => {
  const c = await domainM365();
  await store.storeUserAccountCredential(c.id, anna.id, tok('T'));
  const x = await loadExternalTools(anna, deps());
  const names = x.specs.map((s) => s.name);
  for (const t of ['mail_search', 'mail_get', 'calendar_events', 'teams_chats', 'files_search', 'file_read']) assert.ok(names.includes(wireName('m365', c.id, t)), t);
  assert.ok(names.includes(PREVIEW_TABLE_TOOL) && names.includes(IMPORT_TABLE_TOOL));
  assert.deepEqual(EXTRACT_WRITE_TOOLS, ['save_knowledge_note']);
  assert.match(externalPromptBlock(x), /needs_connect/);
  assert.match(externalPromptBlock(x), /save_knowledge_note/);

  const m = json((await run(anna, wireName('m365', c.id, 'mail_get'), { id: 'm1' })).text);
  assert.equal(m.provenance.message_id, 'm1');
  assert.equal(m.provenance.link, 'https://outlook.office.com/m1');
  assert.match(m.body, /freeze hiring/);
  const cal = json((await run(anna, wireName('m365', c.id, 'calendar_events'), {})).text);
  assert.equal(cal.events[0].subject, 'Budget review');
  const files = json((await run(anna, wireName('m365', c.id, 'files_search'), { query: 'budget' })).text);
  assert.equal(files.files[0].driveId, 'd1');
  const sheet = json((await run(anna, wireName('m365', c.id, 'file_read'), { itemId: 'x1', driveId: 'd1', sheet: 'Budget 2026' })).text);
  assert.deepEqual(sheet.columns, ['Cost centre', 'Amount', 'Due']);
  assert.equal(graph.calls.every((k) => k.method === 'GET' || /search\/query/.test(k.url)), true, 'reads only');
  // every tool is a read: none parks
  const classify = externalClassifier(anna, deps());
  assert.equal(await classify(wireName('m365', c.id, 'mail_get')), 'free');
});

test('TWIN: Microsoft errors are plain: a refused token asks to reconnect, a file over the limit is too_large', async () => {
  const c = await domainM365();
  await store.storeUserAccountCredential(c.id, anna.id, tok('T'));
  const big = json((await run(anna, wireName('m365', c.id, 'file_read'), { itemId: 'big' })).text);
  assert.equal(big.error.code, 'too_large');
  graph = fakeApi([{ match: /./, reply: () => ({ status: 401, json: {} }) }]);
  const r = json((await run(anna, wireName('m365', c.id, 'mail_search'), {})).text);
  assert.equal(r.error.code, 'needs_connect');
});

test('Google Drive: search and read a Google Doc as text with the user\'s own token', async () => {
  const c = await store.createAccountConnection(dana, { kind: 'gdrive', scope: 'domain' });
  await store.storeUserAccountCredential(c.id, ben.id, tok('G-BEN'));
  const s = json((await run(ben, wireName('gdrive', c.id, 'files_search'), { query: 'plan' })).text);
  assert.equal(s.files[0].id, 'g1');
  const d = json((await run(ben, wireName('gdrive', c.id, 'file_read'), { fileId: 'g1' })).text);
  assert.equal(d.text, 'The plan: ship it.');
  assert.ok(gdrive.calls.every((k) => k.token === 'G-BEN'));
});

test('OneDrive: the file tools only (no mail), with the user\'s own token', async () => {
  const c = await store.createAccountConnection(anna, { kind: 'onedrive', scope: 'my' });
  await store.storeUserAccountCredential(c.id, anna.id, tok('OD'));
  const names = (await loadExternalTools(anna, deps())).specs.map((s) => s.name);
  assert.ok(names.includes(wireName('onedrive', c.id, 'file_read')));
  assert.equal(names.includes(wireName('onedrive', c.id, 'mail_search')), false);
  const t = json((await run(anna, wireName('onedrive', c.id, 'file_read'), { itemId: 'x1' })).text);
  assert.equal(t.kind, 'table');
});

test('Notion per-user: Ben\'s own Notion token reaches Notion; before he connects, the placeholder tools answer needs_connect', async () => {
  const c = await store.createAccountConnection(dana, { kind: 'notion', scope: 'domain' });
  const x = await loadExternalTools(ben, deps());
  assert.ok(x.specs.some((s) => s.name === wireName('notion', c.id, 'notion-search')), 'offered before connecting');
  assert.equal(json((await run(ben, wireName('notion', c.id, 'notion-search'), { query: 'Q3' })).text).error.code, 'needs_connect');
  assert.equal(notion.calls.length, 0);
  const reg = { clientId: 'cid', tokenEndpoint: 'https://mcp.notion.com/token', mcpEndpoint: 'https://mcp.notion.com/mcp', resource: 'https://mcp.notion.com/mcp' };
  await store.completeAccountOAuth(c.id, ben, tok('N-BEN'), { reg });
  const r = await run(ben, wireName('notion', c.id, 'notion-search'), { query: 'Q3' });
  assert.equal(r.isError, false, r.text);
  assert.equal(notion.calls.at(-1)!.token, 'N-BEN');
});

// ---------------------------------------------------------------- extract → write into the OS ---

test('email → knowledge: the chat reads a message and saves the decisions as a note in My knowledge, behind the confirm gate', async () => {
  const c = await domainM365();
  await store.storeUserAccountCredential(c.id, anna.id, tok('T'));
  const m = json((await run(anna, wireName('m365', c.id, 'mail_get'), { id: 'm1' })).text);
  const md = ['---', `source: ${JSON.stringify(m.provenance.source)}`, `message_id: ${JSON.stringify(m.provenance.message_id)}`, `subject: ${JSON.stringify(m.provenance.subject)}`, `date: ${JSON.stringify(m.provenance.date)}`, `link: ${JSON.stringify(m.provenance.link)}`, '---', '', '# Budget decisions', '', '- Freeze hiring', '- Q1 budget 1.2M', ''].join('\n');
  // the gate parks the write
  const parked: unknown[] = [];
  const port: ConfirmationPort = { create: (req) => { parked.push(req); return { confirmationId: 'c1', tool: req.tool, args: req.args, expiresAt: 'x' }; } };
  const seen: Seen = [];
  const gated = userConfirmGate(withExternalTools(anna, inner(anna, seen), deps()), { classify: externalClassifier(anna, deps()), userId: anna.id, conversationId: 'conv1', surface: 'ask' }, port);
  const g = await gated('save_knowledge_note', { title: 'Budget decisions', md, folder: '/meetings' });
  assert.equal(parked.length, 1);
  assert.equal(seen.length, 0, 'nothing written before the user confirms');
  assert.match(g.text, /NOT EXECUTED/);
  // confirmed: the real governed save, in Anna's My scope
  const saved = await run(anna, 'save_knowledge_note', { title: 'Budget decisions', md, folder: '/meetings' }, { confirmed: true });
  assert.equal(saved.isError, false, saved.text);
  const note = await getPersonalKnowledge(json(saved.text).id, anna);
  assert.ok(note);
  assert.match(JSON.stringify(note), /message_id/);
  await assert.rejects(Promise.resolve().then(() => getPersonalKnowledge(json(saved.text).id, ben)).then((n) => { if (n) throw new Error('visible'); throw new Error('hidden'); }), /hidden|not found|not permitted|403|404/i, 'Ben cannot read Anna\'s note');
});

test('spreadsheet → dataset: preview is free; the import parks, then creates the dataset in My data with the sheet as CSV and its provenance', async () => {
  const c = await domainM365();
  await store.storeUserAccountCredential(c.id, anna.id, tok('T'));
  const p = json((await run(anna, PREVIEW_TABLE_TOOL, { connectionId: c.id, fileId: 'x1', driveId: 'd1', sheet: 'Budget 2026' })).text);
  assert.deepEqual(p.columns, ['Cost centre', 'Amount', 'Due']);
  assert.equal(p.rowsInSheet, 2);
  assert.deepEqual(p.sheets, ['Notes', 'Budget 2026']);
  assert.equal(await externalClassifier(anna, deps())(PREVIEW_TABLE_TOOL), 'free');
  assert.equal(await externalClassifier(anna, deps())(IMPORT_TABLE_TOOL), null, 'the gate\'s own rule: an import is a write and parks');

  const unconfirmed = json((await run(anna, IMPORT_TABLE_TOOL, { connectionId: c.id, fileId: 'x1', datasetName: 'Budget 2026' })).text);
  assert.equal(unconfirmed.error.code, 'needs_confirmation');

  const seen: Seen = [];
  const r = await run(anna, IMPORT_TABLE_TOOL, { connectionId: c.id, fileId: 'x1', driveId: 'd1', sheet: 'Budget 2026', datasetName: 'Budget 2026' }, { confirmed: true, seen });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(seen.map((s) => s.name), ['create_dataset', 'ingest_dataset', 'document_dataset']);
  assert.equal(seen[0].args.name, 'Budget 2026');
  assert.equal(seen[1].args.content, 'Cost centre,Amount,Due\nMarketing,500,2026-01-01\n"R&D, Labs",700.5,2026-02-01\n');
  assert.equal(seen[1].args.fileName, 'budget.csv');
  assert.match(String(seen[2].args.description), /budget\.xlsx, sheet "Budget 2026".*Imported by anna/);
  const out = json(r.text);
  assert.equal(out.dataset.id, 'ds_new1');
  assert.equal(out.provenance.connection, c.id);
  assert.equal(out.provenance.imported_by, 'anna');
});

test('TWIN: Ben cannot import from a sheet with Anna\'s sign-in, and a non-spreadsheet is refused plainly', async () => {
  const c = await domainM365();
  await store.storeUserAccountCredential(c.id, anna.id, tok('T'));
  const seen: Seen = [];
  const r = await run(ben, IMPORT_TABLE_TOOL, { connectionId: c.id, fileId: 'x1', datasetName: 'Stolen' }, { confirmed: true, seen });
  assert.equal(json(r.text).error.code, 'needs_connect', r.text);
  assert.equal(seen.length, 0, 'no dataset was created');
  gdrive = fakeApi([...driveRoutes]);
  const g = await store.createAccountConnection(dana, { kind: 'gdrive', scope: 'domain' });
  await store.storeUserAccountCredential(g.id, ben.id, tok('G'));
  const notSheet = json((await run(ben, PREVIEW_TABLE_TOOL, { connectionId: g.id, fileId: 'g1' })).text);
  assert.equal(notSheet.error.code, 'tool_error', JSON.stringify([notSheet, gdrive.calls, graph.calls.slice(-2)]));
  assert.match(notSheet.error.reason, /not a spreadsheet/);
});

// ---------------------------------------------------------------- review follow-ups ---

test('a shared credential is refused on a My connection, and promote / demote reset it to per-user until re-confirmed', async () => {
  await assert.rejects(store.createAccountConnection(dana, { kind: 'gdrive', scope: 'my', credentialMode: 'shared', sharedAcknowledged: true }), /My connection is yours alone/);
  const mine = await store.createAccountConnection(dana, { kind: 'gdrive', scope: 'my' });
  await assert.rejects(store.setCredentialMode(mine.id, dana, 'shared', true), /promote it before sharing/);
  const c = await store.createAccountConnection(dana, { kind: 'gdrive', scope: 'domain', credentialMode: 'shared', sharedAcknowledged: true });
  assert.equal(c.credentialMode, 'shared');
  const admin: CurrentUser = { ...dana, id: 'ada', role: 'admin' };
  const promoted = await store.promoteConnection(c.id, admin);
  assert.deepEqual([promoted.visibility, promoted.credentialMode], ['Certified', 'per_user'], 'a wider audience needs the tick again');
  await store.setCredentialMode(c.id, admin, 'shared', true);
  const demoted = await store.demoteConnection(c.id, admin);
  assert.deepEqual([demoted.visibility, demoted.credentialMode], ['Shared', 'per_user']);
});

test('an OAuth callback re-checks: a connection switched to shared mid-flow does not take a non-owner\'s sign-in', async () => {
  const c = await domainM365();
  await store.setCredentialMode(c.id, dana, 'shared', true);
  await assert.rejects(store.completeAccountOAuth(c.id, ben, tok('B')), /no longer connect/);
  assert.equal((await store.accountStatus(c.id, ben)).connected, false);
});

test('deleting a connection purges every user\'s sign-in and revokes each at the provider', async () => {
  const c = await store.createAccountConnection(dana, { kind: 'gdrive', scope: 'domain' });
  await store.storeUserAccountCredential(c.id, anna.id, tok('GA'));
  await store.storeUserAccountCredential(c.id, ben.id, tok('GB'));
  const report = await store.deleteConnection(c.id, dana);
  assert.ok(report.physical.some((p) => /2 sign-in\(s\) purged/.test(p.reason)), JSON.stringify(report.physical));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(revoked.map((r) => r.token).sort(), ['R-GA', 'R-GB']);
  const { userCredentials } = await import('@tabs/connections/lib/user-credentials');
  assert.equal(userCredentials().has(c, anna.id), false);
  assert.equal(userCredentials().has(c, ben.id), false);
  assert.deepEqual(userCredentials().users(c), []);
});

test('disconnect revokes the grant at Google; deactivation through the kernel registry revokes on every path', async () => {
  const g = await store.createAccountConnection(dana, { kind: 'gdrive', scope: 'domain' });
  await store.storeUserAccountCredential(g.id, anna.id, tok('GA'));
  const out = await store.disconnectAccount(g.id, anna);
  assert.equal(out.provider?.revoked, true);
  assert.deepEqual(revoked, [{ provider: 'google', token: 'R-GA' }]);

  __resetUserRevocations();
  registerUserRevocation('connections', store.revokeUserAccountCredentials);
  const c = await domainM365();
  await store.storeUserAccountCredential(c.id, ben.id, tok('MB'));
  assert.deepEqual(await revokeUserEverywhere(ben.id), { connections: 1 });
  assert.equal((await store.accountStatus(c.id, ben)).connected, false);
  registerUserRevocation('broken', async () => { throw new Error('vault down'); });
  await assert.rejects(revokeUserEverywhere(ben.id), /vault down/, 'a failed revoke is raised, never swallowed');
  __resetUserRevocations();
});
