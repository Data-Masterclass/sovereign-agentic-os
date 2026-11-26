/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Outlook draft and send on the Microsoft 365 account connection — the admin switch, the scopes,
 *             the confirm card, per-user grants, local validation and honest failures; each with a negative twin
 * USER STORY: As an admin I want drafting and sending mail off by default and on only where I allow it; as a
 *             user I want the chat to draft or send a plain-text mail as ME, only after I confirmed the whole
 *             message, never with anyone else's sign-in, and a "Reconnect to allow sending" when my sign-in
 *             predates the switch.
 * ARCHITECTURE: the REAL connections store, per-user credential store, account source, kernel external-tool
 *   layer and confirm gate, against a fake Microsoft Graph that records every request (method, path, body,
 *   bearer). The OPA decision is a double that mirrors external_mcp.rego, as in account-connections.test.ts.
 */
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { userConfirmGate, type ConfirmationPort } from '@core/runtime/confirm-gate';
import type { ToolExecutor } from '@core/runtime/agentic';
import { loadExternalTools, withExternalTools, externalClassifier, externalPromptBlock, wireName, type DecideFn, type TraceFn } from '@core/runtime/external-mcp';
import { connectCards, mailPreviewOf } from '@core/ui/chat-view';
import { fakeApi, type Route } from '@core/testing/account-fixtures';
import { buildAuthorizeUrl, type TokenSet } from '@core/auth/token-set';
import { grantHasScopes, scopesForTemplate, MICROSOFT_365_MAIL_WRITE_SCOPES } from '@core/auth/providers';

const realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const store = await import('@tabs/connections/lib/store');
const { createAccountSource } = await import('@tabs/connections/lib/external-mcp-source');
const { validateMailInput, MAIL_MAX_RECIPIENTS, MAIL_BODY_MAX } = await import('@tabs/connections/lib/account-tools');
after(() => { globalThis.fetch = realFetch; });

const dana: CurrentUser = { id: 'dana', name: 'Dana', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'domain_admin' };
const root: CurrentUser = { id: 'root', name: 'Root', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'admin' };
const anna: CurrentUser = { id: 'anna', name: 'Anna', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' };
const ben: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' };

const READ_SCOPES = 'offline_access User.Read Mail.Read Calendars.Read';
// Microsoft answers with the resource prefix; the check must normalise it.
const SEND_SCOPES = `${READ_SCOPES} https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send`;
const nowSec = () => Math.floor(Date.now() / 1000);
const tok = (accessToken: string, scope?: string): TokenSet => ({ accessToken, refreshToken: `R-${accessToken}`, expiresAt: nowSec() + 3600, ...(scope ? { scope } : {}) });

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

// ---------------------------------------------------------------- fake Graph ---

type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };
let writeStatus: Reply | null = null;
/** Per-step overrides for the reply flow. */
let patchStatus: Reply | null = null;
let deleteStatus: Reply | null = null;
let sendStatus: Reply | null = null;
const QUOTED = '<div>From: CFO<br>Original question &amp; context</div>';
const graphRoutes: Route[] = [
  { match: /\/v1\.0\/me\/sendMail$/, method: 'POST', reply: () => writeStatus ?? { status: 202, text: '' } },
  { match: /\/v1\.0\/me\/messages\/m1\/createReply$/, method: 'POST', reply: () => writeStatus ?? { status: 201, json: { id: 'draft-r1', webLink: 'https://outlook.office.com/draft-r1', body: { contentType: 'html', content: QUOTED }, toRecipients: [{ emailAddress: { address: 'cfo@example.com' } }, { emailAddress: { address: 'everyone@example.com' } }] } } },
  { match: /\/v1\.0\/me\/messages\/draft-r1\/send$/, method: 'POST', reply: () => sendStatus ?? { status: 202, text: '' } },
  { match: /\/v1\.0\/me\/messages\/draft-r1$/, method: 'PATCH', reply: () => patchStatus ?? { status: 200, json: { id: 'draft-r1', webLink: 'https://outlook.office.com/draft-r1' } } },
  { match: /\/v1\.0\/me\/messages\/draft-r1$/, method: 'DELETE', reply: () => deleteStatus ?? { status: 204, text: '' } },
  { match: /\/v1\.0\/me\/messages$/, method: 'POST', reply: () => writeStatus ?? { status: 201, json: { id: 'draft-1', webLink: 'https://outlook.office.com/draft-1' } } },
  { match: /\/v1\.0\/me\/messages\/m1\?\$select=subject,from$/, reply: () => ({ json: { subject: 'Q1 budget?', from: { emailAddress: { name: 'CFO', address: 'cfo@example.com' } } } }) },
  { match: /\/v1\.0\/me\/messages\?\$search=/, reply: () => ({ json: { value: [] } }) },
];
let graph: ReturnType<typeof fakeApi>;
let events: Record<string, unknown>[];

const realOpaFailOpen = config.opaFailOpen;
beforeEach(() => {
  config.opaFailOpen = true;
  store.__resetConnections();
  graph = fakeApi(graphRoutes);
  writeStatus = null;
  patchStatus = null;
  deleteStatus = null;
  sendStatus = null;
  failWrites = false;
  events = [];
  store.__setProviderRevoke(async () => ({ revoked: false, detail: 'test' }));
});
afterEach(() => { config.opaFailOpen = realOpaFailOpen; });

const trace: TraceFn = async (e) => { events.push(e as unknown as Record<string, unknown>); };
/** When set, every non-GET request fails like a lost connection (no answer). */
let failWrites = false;
const vendorFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  failWrites && (init?.method ?? 'GET') !== 'GET' ? Promise.reject(new TypeError('fetch failed')) : graph.fetch(input, init)) as typeof fetch;
const source = () => createAccountSource({ fetchImpl: vendorFetch, refresh: async (_c, prev) => prev });
const deps = () => ({ source: source(), decide, trace });
const inner: ToolExecutor = async (name) => ({ text: JSON.stringify({ error: { code: 'unknown_tool', reason: name, hint: '' } }), isError: true });
const run = (user: CurrentUser, name: string, args: Record<string, unknown>, o: { confirmed?: boolean } = {}) =>
  withExternalTools(user, inner, { ...deps(), confirmed: o.confirmed })(name, args);
const json = (t: string) => JSON.parse(t) as Record<string, any>;
const writes = () => graph.calls.filter((c) => c.method !== 'GET');

async function m365(opts: { allowMailSend?: boolean; by?: CurrentUser; scope?: 'my' | 'domain' | 'company' } = {}) {
  return store.createAccountConnection(opts.by ?? dana, { kind: 'microsoft-365', name: 'Microsoft 365', scope: opts.scope ?? 'domain', ...(opts.allowMailSend ? { allowMailSend: true } : {}) });
}
const NEW_MAIL = { to: ['cfo@example.com'], cc: ['team@example.com'], subject: 'Q1 budget', body: 'Hi,\n\nthe Q1 budget is 1.2M.\n\nAnna' };
const REPLY = { to: ['cfo@example.com'], body: 'Thanks — agreed.', replyToMessageId: 'm1' };

// ---------------------------------------------------------------- the switch ---

test('switch OFF (the default): no mail_draft / mail_send offered, and the sign-in asks for no mail-write scope', async () => {
  const c = await m365();
  assert.equal(c.allowMailSend, undefined);
  await store.storeUserAccountCredential(c.id, anna.id, tok('TOKEN-ANNA', SEND_SCOPES), { subject: 'anna@example.com' });
  const x = await loadExternalTools(anna, deps());
  assert.ok(x.specs.some((s) => s.name === wireName('m365', c.id, 'mail_search')), 'reads are offered');
  assert.equal(x.specs.some((s) => /__mail_(draft|send)$/.test(s.name)), false);
  assert.doesNotMatch(externalPromptBlock(x), /MAIL \(only where/);
  const cfg = store.accountAuthorizeConfig(c)!;
  assert.equal(cfg.scopes.some((s) => /Mail\.(ReadWrite|Send)/.test(s)), false);
  const url = buildAuthorizeUrl(cfg, { clientId: 'cid', redirectUri: 'https://os.example/cb', state: 's' });
  assert.doesNotMatch(url, /Mail\.ReadWrite|Mail\.Send/);
  // Guessing the tool name changes nothing: unknown tool, nothing reaches Microsoft.
  const r = await run(anna, wireName('m365', c.id, 'mail_send'), NEW_MAIL, { confirmed: true });
  assert.equal(json(r.text).error.code, 'unknown_tool');
  assert.equal(graph.calls.length, 0);
});

test('TWIN switch ON: both tools are offered as writes, and the authorize request adds Mail.ReadWrite + Mail.Send', async () => {
  const c = await m365({ allowMailSend: true });
  assert.equal(c.allowMailSend, true);
  const x = await loadExternalTools(anna, deps());
  for (const t of ['mail_draft', 'mail_send']) {
    const spec = x.specs.find((s) => s.name === wireName('m365', c.id, t));
    assert.ok(spec, t);
    assert.match(spec!.description, /CHANGES DATA/);
  }
  assert.match(externalPromptBlock(x), /MAIL \(only where/);
  const url = new URL(buildAuthorizeUrl(store.accountAuthorizeConfig(c)!, { clientId: 'cid', redirectUri: 'https://os.example/cb', state: 's' }));
  const scopes = url.searchParams.get('scope')!.split(' ');
  for (const s of ['Mail.ReadWrite', 'Mail.Send', 'Mail.Read', 'offline_access']) assert.ok(scopes.includes(s), s);
  // Other templates never get them.
  assert.equal(scopesForTemplate('onedrive', { allowMailSend: true }).some((s) => /Mail/.test(s)), false);
});

test('who may switch it: a creator cannot; a domain admin can on a Domain connection; Company needs an admin; never with a shared credential', async () => {
  await assert.rejects(store.createAccountConnection(anna, { kind: 'microsoft-365', scope: 'my', allowMailSend: true }), /domain admin or an administrator/);
  await assert.rejects(store.createAccountConnection(dana, { kind: 'gdrive', scope: 'domain', allowMailSend: true }), /Only a Microsoft 365/);
  await assert.rejects(store.createAccountConnection(dana, { kind: 'microsoft-365', scope: 'domain', credentialMode: 'shared', sharedAcknowledged: true, allowMailSend: true }), /per-user sign-in/);
  const c = await m365();
  await assert.rejects(store.setMailSend(c.id, anna, true), /Not permitted|domain admin/);
  assert.equal((await store.setMailSend(c.id, dana, true)).allowMailSend, true);
  assert.equal(store.canAllowMailSend(c, dana), true);
  assert.equal(store.canAllowMailSend(c, anna), false);
  assert.equal((await store.setMailSend(c.id, dana, false)).allowMailSend, undefined, 'off removes the flag');
  const company = await store.createAccountConnection(root, { kind: 'microsoft-365', scope: 'company' });
  await assert.rejects(store.setMailSend(company.id, dana, true), /administrator|Not permitted/);
  assert.equal((await store.setMailSend(company.id, root, true)).allowMailSend, true);
  // Switching the connection to a shared credential switches mail off in effect: no tools, no scopes.
  const shared = await m365({ allowMailSend: true });
  await store.setCredentialMode(shared.id, dana, 'shared', true);
  const live = await store.getConnectionForUser(shared.id, dana);
  assert.equal(store.mailSendAllowed(live), false);
  assert.equal(store.accountAuthorizeConfig(live)!.scopes.includes('Mail.Send'), false);
  assert.equal(live.allowMailSend, undefined, 'cleared for good: switching back to per-user does not bring it back');
  await store.setCredentialMode(shared.id, dana, 'per_user');
  assert.equal(store.mailSendAllowed(await store.getConnectionForUser(shared.id, dana)), false);
});

test('promotion and demotion switch mail off; re-enabling needs the new scope\'s authority', async () => {
  const mine = await m365({ allowMailSend: true, scope: 'my' });
  assert.equal(mine.allowMailSend, true);
  const up = await store.promoteConnection(mine.id, dana);
  assert.equal(up.visibility, 'Shared');
  assert.equal(up.allowMailSend, undefined, 'off after promotion');
  assert.equal((await store.setMailSend(up.id, dana, true)).allowMailSend, true, 'the domain admin re-enables it at Domain scope');
  const top = await store.promoteConnection(up.id, root);
  assert.equal(top.allowMailSend, undefined, 'off after promotion to Company');
  await assert.rejects(store.setMailSend(top.id, dana, true), /administrator|Not permitted/);
  await store.setMailSend(top.id, root, true);
  const down = await store.demoteConnection(top.id, root);
  assert.equal(down.allowMailSend, undefined, 'off after demotion');
});

// ---------------------------------------------------------------- grants ---

test('a sign-in without the mail scopes gets "Reconnect to allow sending" — before any card, and with no Graph write', async () => {
  const c = await m365({ allowMailSend: true });
  await store.storeUserAccountCredential(c.id, anna.id, tok('TOKEN-ANNA', READ_SCOPES), { subject: 'anna@example.com' });
  const tool = wireName('m365', c.id, 'mail_send');
  assert.equal(await externalClassifier(anna, deps())(tool, NEW_MAIL), 'free', 'not parked: the user is never asked to confirm a call that cannot run');
  for (const confirmed of [false, true]) {
    const r = await run(anna, tool, NEW_MAIL, { confirmed });
    const e = json(r.text).error;
    assert.equal(e.code, 'needs_connect');
    assert.match(e.reason, /does not allow drafting and sending mail yet/);
    assert.match(e.hint, /Reconnect to allow sending/);
  }
  assert.equal(graph.calls.length, 0);
  const cards = connectCards([{ name: tool, error: { code: 'needs_connect' } }]);
  assert.equal(cards[0].action, 'Reconnect to allow sending');
  assert.equal(connectCards([{ name: wireName('m365', c.id, 'mail_search'), error: { code: 'needs_connect' } }])[0].action, 'Connect your Microsoft 365 account');
  // The Connections row says so too.
  assert.equal((await store.accountStatus(c.id, anna)).mailSendGranted, false);
  // TWIN: after reconnecting with the scopes, the same call parks for confirmation.
  await store.storeUserAccountCredential(c.id, anna.id, tok('TOKEN-ANNA', SEND_SCOPES), { subject: 'anna@example.com' });
  assert.equal((await store.accountStatus(c.id, anna)).mailSendGranted, true);
  assert.equal(await externalClassifier(anna, deps())(tool, NEW_MAIL), 'confirm');
});

test('grantHasScopes normalises the Graph prefix and case, and an absent grant holds nothing', () => {
  assert.equal(grantHasScopes(SEND_SCOPES, MICROSOFT_365_MAIL_WRITE_SCOPES), true);
  assert.equal(grantHasScopes('mail.readwrite MAIL.SEND', MICROSOFT_365_MAIL_WRITE_SCOPES), true);
  assert.equal(grantHasScopes('Mail.ReadWrite', MICROSOFT_365_MAIL_WRITE_SCOPES), false);
  assert.equal(grantHasScopes('Mail.ReadWrite.Shared Mail.Send.Shared', MICROSOFT_365_MAIL_WRITE_SCOPES), false);
  assert.equal(grantHasScopes(undefined, MICROSOFT_365_MAIL_WRITE_SCOPES), false);
});

test('user B can never send through A\'s grant: not connected → Connect card; connected without the scopes → reconnect; then B\'s own token', async () => {
  const c = await m365({ allowMailSend: true });
  await store.storeUserAccountCredential(c.id, anna.id, tok('TOKEN-ANNA', SEND_SCOPES), { subject: 'anna@example.com' });
  const tool = wireName('m365', c.id, 'mail_send');
  const b1 = json((await run(ben, tool, NEW_MAIL, { confirmed: true })).text).error;
  assert.equal(b1.code, 'needs_connect');
  assert.match(b1.reason, /Connect your Microsoft 365 account first/);
  await store.storeUserAccountCredential(c.id, ben.id, tok('TOKEN-BEN', READ_SCOPES), { subject: 'ben@example.com' });
  const b2 = json((await run(ben, tool, NEW_MAIL, { confirmed: true })).text).error;
  assert.match(b2.hint, /Reconnect to allow sending/, 'Anna\'s grant does not cover Ben');
  assert.equal(graph.calls.length, 0);
  await store.storeUserAccountCredential(c.id, ben.id, tok('TOKEN-BEN', SEND_SCOPES), { subject: 'ben@example.com' });
  const ok = await run(ben, tool, NEW_MAIL, { confirmed: true });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(writes().length, 1);
  assert.equal(writes()[0].token, 'TOKEN-BEN');
});

// ---------------------------------------------------------------- confirm, then exactly one call ---

async function ready() {
  const c = await m365({ allowMailSend: true });
  await store.storeUserAccountCredential(c.id, anna.id, tok('TOKEN-ANNA', SEND_SCOPES), { subject: 'anna@example.com' });
  return c;
}

test('not confirmed: the gate parks the full message and nothing reaches Microsoft', async () => {
  const c = await ready();
  const tool = wireName('m365', c.id, 'mail_send');
  const parked: { tool: string; args: Record<string, unknown> }[] = [];
  const port: ConfirmationPort = { create: (req) => { parked.push(req); return { confirmationId: 'c1', tool: req.tool, args: req.args, expiresAt: 'x' }; } };
  const gated = userConfirmGate(withExternalTools(anna, inner, deps()), { classify: externalClassifier(anna, deps()), userId: anna.id, conversationId: 'conv1', surface: 'ask' }, port);
  const g = await gated(tool, NEW_MAIL);
  assert.match(g.text, /NOT EXECUTED/);
  assert.equal(parked.length, 1);
  assert.equal(graph.calls.length, 0, 'no Graph call of any kind before the confirmation');
  // An unconfirmed direct call is held by OPA, also without a Graph call.
  assert.equal(json((await run(anna, tool, NEW_MAIL)).text).error.code, 'needs_confirmation');
  assert.equal(graph.calls.length, 0);
  // The card shows the whole message, uncut.
  const long = { ...NEW_MAIL, body: 'x'.repeat(MAIL_BODY_MAX) };
  const preview = mailPreviewOf(tool, long)!;
  assert.deepEqual([preview.kind, preview.to, preview.cc, preview.subject], ['send', NEW_MAIL.to, NEW_MAIL.cc, 'Q1 budget']);
  assert.equal(preview.body.length, MAIL_BODY_MAX);
  assert.equal(mailPreviewOf(wireName('m365', c.id, 'mail_draft'), REPLY)!.subject, null, 'a reply keeps the thread\'s subject');
  assert.equal(mailPreviewOf(wireName('m365', c.id, 'mail_search'), NEW_MAIL), null);
});

test('confirmed send of a new mail: exactly one POST /me/sendMail with the plain-text message', async () => {
  const c = await ready();
  const r = await run(anna, wireName('m365', c.id, 'mail_send'), NEW_MAIL, { confirmed: true });
  assert.equal(r.isError, false, r.text);
  assert.equal(json(r.text).sent, true);
  assert.equal(graph.calls.length, 1);
  const w = graph.calls[0];
  assert.equal(w.method, 'POST');
  assert.equal(new URL(w.url).pathname, '/v1.0/me/sendMail');
  assert.deepEqual(JSON.parse(w.body!), {
    message: { subject: 'Q1 budget', body: { contentType: 'Text', content: NEW_MAIL.body }, toRecipients: [{ emailAddress: { address: 'cfo@example.com' } }], ccRecipients: [{ emailAddress: { address: 'team@example.com' } }] },
    saveToSentItems: true,
  });
});

test('confirmed reply: createReply (no body) → PATCH exact recipients + escaped text above the quote → send', async () => {
  const c = await ready();
  const body = 'Thanks <a href=x>link</a> & "quote" \'single\'\nsecond line';
  const r = await run(anna, wireName('m365', c.id, 'mail_send'), { ...REPLY, cc: ['cto@example.com'], body }, { confirmed: true });
  assert.equal(r.isError, false, r.text);
  assert.equal(json(r.text).sent, true);
  const seq = writes().map((w) => `${w.method} ${new URL(w.url).pathname}`);
  assert.deepEqual(seq, ['POST /v1.0/me/messages/m1/createReply', 'PATCH /v1.0/me/messages/draft-r1', 'POST /v1.0/me/messages/draft-r1/send']);
  assert.equal(writes()[0].body, undefined, 'createReply is sent with no body');
  const patch = JSON.parse(writes()[1].body!);
  // Recipients REPLACED exactly by the confirmed lists (the draft had cfo + everyone@).
  assert.deepEqual(patch.toRecipients, [{ emailAddress: { address: 'cfo@example.com' } }]);
  assert.deepEqual(patch.ccRecipients, [{ emailAddress: { address: 'cto@example.com' } }]);
  assert.equal(patch.body.contentType, 'HTML');
  assert.equal(patch.body.content, `<div>Thanks &lt;a href=x&gt;link&lt;/a&gt; &amp; &quot;quote&quot; &#39;single&#39;<br>second line</div><br>${QUOTED}`);
  assert.equal(patch.body.content.includes('<a href'), false, 'model markup never renders live');
});

test('TWIN reply draft: createReply → PATCH, never send; Cc emptied when the card had none', async () => {
  const c = await ready();
  const r = await run(anna, wireName('m365', c.id, 'mail_draft'), REPLY, { confirmed: true });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual([json(r.text).draftId, json(r.text).webLink], ['draft-r1', 'https://outlook.office.com/draft-r1']);
  assert.deepEqual(writes().map((w) => w.method), ['POST', 'PATCH']);
  assert.deepEqual(JSON.parse(writes()[1].body!).ccRecipients, [], 'exactly the card: no Cc');
  assert.equal(graph.calls.some((x) => /\/send$|sendMail/.test(x.url)), false);
});

test('a failed PATCH removes the orphan reply draft and says so; if the delete fails too, it says that', async () => {
  const c = await ready();
  const tool = wireName('m365', c.id, 'mail_send');
  patchStatus = { status: 400, json: { error: { code: 'ErrorInvalidRecipients' } } };
  const e1 = json((await run(anna, tool, REPLY, { confirmed: true })).text).error;
  assert.deepEqual(writes().map((w) => w.method), ['POST', 'PATCH', 'DELETE']);
  assert.match(e1.reason, /Nothing was sent/);
  assert.match(e1.reason, /unfinished reply draft was removed/);
  assert.equal(graph.calls.some((x) => /\/send$/.test(x.url)), false);
  graph.calls.length = 0;
  deleteStatus = { status: 500 };
  const e2 = json((await run(anna, tool, REPLY, { confirmed: true })).text).error;
  assert.match(e2.reason, /could not be removed: delete it from your Drafts/);
});

test('the card names the thread: precheck reads the original\'s subject and sender (display-only context)', async () => {
  const c = await ready();
  const tool = wireName('m365', c.id, 'mail_send');
  const out = await externalClassifier(anna, deps())(tool, REPLY);
  assert.deepEqual(out, { confirm: true, context: { thread: { subject: 'Q1 budget?', from: 'CFO <cfo@example.com>' } } });
  const parked: { args: Record<string, unknown> }[] = [];
  const port: ConfirmationPort = { create: (req) => { parked.push(req); return { confirmationId: 'c1', tool: req.tool, args: req.args, expiresAt: 'x' }; } };
  const gated = userConfirmGate(withExternalTools(anna, inner, deps()), { classify: externalClassifier(anna, deps()), userId: anna.id, conversationId: 'conv1', surface: 'ask' }, port);
  const g = await gated(tool, REPLY);
  assert.deepEqual(g.parked?.context, { thread: { subject: 'Q1 budget?', from: 'CFO <cfo@example.com>' } });
  assert.equal('thread' in parked[0].args, false, 'the context is never stored as an argument');
  assert.equal(writes().length, 0);
  const preview = mailPreviewOf(tool, REPLY, g.parked?.context)!;
  assert.deepEqual(preview.thread, { subject: 'Q1 budget?', from: 'CFO <cfo@example.com>' });
  // TWIN: a model-supplied "thread" in the args is not what the card shows.
  assert.equal(mailPreviewOf(tool, { ...REPLY, thread: { subject: 'fake' } }, undefined)!.thread, undefined);
});

test('confirmed draft: exactly one POST /me/messages; returns the draft id and link, sends nothing', async () => {
  const c = await ready();
  const r = await run(anna, wireName('m365', c.id, 'mail_draft'), NEW_MAIL, { confirmed: true });
  assert.equal(r.isError, false, r.text);
  const out = json(r.text);
  assert.deepEqual([out.draftId, out.webLink], ['draft-1', 'https://outlook.office.com/draft-1']);
  assert.equal(graph.calls.length, 1);
  assert.equal(new URL(graph.calls[0].url).pathname, '/v1.0/me/messages');
  const body = JSON.parse(graph.calls[0].body!);
  assert.equal(body.subject, 'Q1 budget');
  assert.deepEqual(body.body, { contentType: 'Text', content: NEW_MAIL.body });
  assert.equal(graph.calls.some((x) => /sendMail|\/send$|\/reply$/.test(x.url)), false);
});

// ---------------------------------------------------------------- local validation ---

test('invalid input is refused locally with a clear reason and zero network calls — even when confirmed', async () => {
  const c = await ready();
  const tool = wireName('m365', c.id, 'mail_send');
  const many = Array.from({ length: MAIL_MAX_RECIPIENTS + 1 }, (_, i) => `p${i}@example.com`);
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ ...NEW_MAIL, to: many, cc: [] }, /at most 10 recipients/],
    [{ ...NEW_MAIL, to: many.slice(0, 6), cc: many.slice(6) }, /at most 10 recipients/],
    [{ ...NEW_MAIL, to: ['not-an-address'] }, /not a valid e-mail address/],
    [{ ...NEW_MAIL, to: ['Anna <anna@example.com>'] }, /not a valid e-mail address/],
    [{ ...NEW_MAIL, cc: ['a@b'] }, /not a valid e-mail address/],
    [{ ...NEW_MAIL, to: [] }, /at least one recipient/],
    [{ ...NEW_MAIL, body: 'x'.repeat(MAIL_BODY_MAX + 1) }, /at most 20000/],
    [{ ...NEW_MAIL, body: '' }, /plain-text "body"/],
    [{ ...NEW_MAIL, subject: '' }, /needs a "subject"/],
    [{ ...NEW_MAIL, subject: 'a\nBcc: x@y.com' }, /one line/],
    [{ ...REPLY, subject: 'RE: changed' }, /keeps the thread's subject/],
    [{ ...NEW_MAIL, attachments: [{ name: 'a.pdf' }] }, /not supported/],
    [{ ...NEW_MAIL, bcc: ['x@example.com'] }, /not supported/],
  ];
  for (const [args, reason] of cases) {
    assert.equal(await externalClassifier(anna, deps())(tool, args), 'free', `not parked: ${reason}`);
    for (const confirmed of [false, true]) {
      const e = json((await run(anna, tool, args, { confirmed })).text).error;
      assert.equal(e.code, 'invalid_request', `${reason}`);
      assert.match(e.reason, reason);
    }
  }
  assert.equal(graph.calls.length, 0);
  // TWIN: exactly ten distinct recipients pass.
  assert.equal(validateMailInput({ ...NEW_MAIL, to: many.slice(0, 5), cc: many.slice(5, 10) }).to.length, 5);
  const d = validateMailInput({ ...NEW_MAIL, to: ['a@example.com', 'A@example.com'], cc: ['A@EXAMPLE.com', ...many.slice(0, 9)] });
  assert.deepEqual(d.to, ['a@example.com'], 'deduplicated case-insensitively, first spelling kept');
  assert.equal(d.cc.length, 9, 'an address already in To is dropped from Cc: what is counted is what is sent');
});

// ---------------------------------------------------------------- honest failures, no token anywhere ---

test('a 403 naming a missing permission → "Reconnect to allow sending"; any other 403 → Microsoft\'s own refusal, no reconnect loop', async () => {
  const c = await ready();
  const tool = wireName('m365', c.id, 'mail_send');
  for (const error of [{ code: 'Authorization_RequestDenied', message: 'Insufficient privileges to complete the operation.' }, { code: 'ErrorAccessDenied', message: 'Access is denied. The token lacks the required permissions or scopes.' }]) {
    writeStatus = { status: 403, json: { error } };
    const e = json((await run(anna, tool, NEW_MAIL, { confirmed: true })).text).error;
    assert.equal(e.code, 'needs_connect', error.code);
    assert.match(e.hint, /Reconnect to allow sending/);
  }
  for (const error of [{ code: 'ErrorSendAsDenied', message: 'The user account which was used to submit this request does not have the right to send mail on behalf of the specified sending account.' }, { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again.' }]) {
    writeStatus = { status: 403, json: { error } };
    const e = json((await run(anna, tool, NEW_MAIL, { confirmed: true })).text).error;
    assert.equal(e.code, 'no_access', error.code);
    assert.match(e.reason, new RegExp(`Microsoft refused to send this mail: ${error.code}`));
    assert.match(e.reason, /Nothing was sent/);
    assert.doesNotMatch(`${e.reason} ${e.hint}`, /Reconnect to allow sending/);
    assert.equal(JSON.stringify(e).includes('on behalf of'), false, 'the vendor\'s message text is never echoed');
  }
});

test('429 → rate_limited with the wait; never retried', async () => {
  const c = await ready();
  writeStatus = { status: 429, headers: { 'retry-after': '17' } };
  const e429 = json((await run(anna, wireName('m365', c.id, 'mail_send'), NEW_MAIL, { confirmed: true })).text).error;
  assert.equal(e429.code, 'rate_limited');
  assert.match(e429.reason, /limiting requests/);
  assert.match(e429.reason, /Nothing was sent/);
  assert.match(e429.hint, /17 s/);
  assert.equal(writes().length, 1, 'a rate-limited write is not repeated');
});

test('a timeout or 5xx on a write: the outcome is unknown — check Sent Items / Drafts, never "try again"', async () => {
  const c = await ready();
  failWrites = true;
  for (const [tool, args, said] of [['mail_send', NEW_MAIL, /not known whether the mail was sent/], ['mail_draft', NEW_MAIL, /not known whether the mail was drafted/], ['mail_send', REPLY, /not known whether it created a reply draft/]] as const) {
    const e = json((await run(anna, wireName('m365', c.id, tool), args, { confirmed: true })).text).error;
    assert.equal(e.code, 'outcome_unknown', `${tool} ${String(said)}`);
    assert.match(e.reason, said);
    assert.match(e.hint, /Check (Sent Items and Drafts|your Drafts)/);
    assert.doesNotMatch(e.hint, /^Try again/);
  }
  failWrites = false;
  writeStatus = { status: 503 };
  const e503 = json((await run(anna, wireName('m365', c.id, 'mail_send'), NEW_MAIL, { confirmed: true })).text).error;
  assert.equal(e503.code, 'outcome_unknown');
  // The reply's final send step: unknown, and the prepared reply is named in Drafts.
  writeStatus = null;
  sendStatus = { status: 504 };
  const eSend = json((await run(anna, wireName('m365', c.id, 'mail_send'), REPLY, { confirmed: true })).text).error;
  assert.equal(eSend.code, 'outcome_unknown');
  assert.match(eSend.reason, /not known whether the reply was sent/);
  // TWIN: a 4xx is a known refusal, not an unknown outcome.
  sendStatus = { status: 400 };
  assert.equal(json((await run(anna, wireName('m365', c.id, 'mail_send'), REPLY, { confirmed: true })).text).error.code, 'tool_error');
});

test('the audit says "sent as <UPN>" with the per-user attribution; no token in any result, error or trace', async () => {
  const c = await ready();
  const tool = wireName('m365', c.id, 'mail_send');
  const okRun = await run(anna, tool, NEW_MAIL, { confirmed: true });
  const sent = events.find((e) => e.decision === 'allow')!;
  assert.ok(sent, 'one allow trace');
  assert.equal(sent.actingUser, 'anna');
  assert.equal(sent.credentialMode, 'per_user');
  assert.equal(sent.credentialSubject, 'anna@example.com');
  assert.equal(sent.tool, 'm365.mail_send');
  const out = sent.output as Record<string, unknown>;
  assert.deepEqual([out.action, out.mode, out.sentAs, out.recipients], ['mail_send', 'new', 'anna@example.com', 2]);
  assert.equal(okRun.text.includes('sentAs'), false, 'the audit is not shown to the model');
  writeStatus = { status: 403 };
  const failRun = await run(anna, tool, NEW_MAIL, { confirmed: true });
  const invalid = await run(anna, tool, { ...NEW_MAIL, to: ['bad'] }, { confirmed: true });
  const all = JSON.stringify([okRun, failRun, invalid, events]);
  assert.equal(all.includes('TOKEN-ANNA'), false);
  assert.equal(all.includes('R-TOKEN-ANNA'), false);
  // the vendor did receive the bearer: it is used, just never echoed
  assert.equal(graph.calls[0].token, 'TOKEN-ANNA');
});
