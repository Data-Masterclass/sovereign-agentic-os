/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Home chat view logic — plain-language errors, the live event stream, secret masking
 * USER STORY: As a user I want a refusal explained in plain words with the next step, steps that
 *             appear as they happen, and no secret echoed back on the confirmation card.
 * ARCHITECTURE: pure functions of `tabs/home/lib/chat-view.ts`; the React shell only maps them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeText, HOME_LOCALES } from '@core/testing/home-messages';
import { plainError, parseStreamLines, confirmCardArgs, artifactLink, streamStatusText, connectCards, STARTERS } from '@tabs/home/lib/chat-view';

test('a status event is a quiet line, not an error; other events have none', () => {
  assert.equal(streamStatusText({ type: 'status', status: 'retrying', message: 'The model is busy — retrying…' }), 'The model is busy — retrying…');
  assert.equal(streamStatusText({ type: 'status', message: '   ' }), null);
  assert.equal(streamStatusText({ type: 'error', error: 'x', message: 'y' }), null);
  assert.equal(streamStatusText({ type: 'step', name: 'whoami' }), null);
});

test('a forbidden refusal names the role in words and says who to ask', () => {
  const m = homeText(plainError({ code: 'forbidden', reason: 'promote requires domain_admin; you are creator', hint: 'Ask a domain_admin to run it, or keep your work Personal.' }));
  assert.match(m, /domain admin/i);
  assert.match(m, /ask a domain admin/i);
  assert.doesNotMatch(m, /domain_admin/, 'no raw role id in user-facing text');
});

test('other typed codes get a plain sentence and keep the server hint; unknown codes fall back to the reason', () => {
  assert.match(homeText(plainError({ code: 'not_found', reason: 'no such dataset', hint: 'Check the id' })), /could not find/i);
  assert.match(homeText(plainError({ code: 'upstream_error', reason: 'fetch failed', hint: 'Check health' })), /not reachable|unavailable/i);
  assert.match(homeText(plainError({ code: 'weird', reason: 'something odd', hint: 'h' })), /something odd/);
});

test('NEGATIVE TWIN: a role that is not gated text is not rewritten as a role refusal', () => {
  assert.doesNotMatch(homeText(plainError({ code: 'bad_request', reason: 'x', hint: 'y' })), /ask a .* admin/i);
});

test('the stream parser yields whole events only and keeps a partial line for the next chunk', () => {
  const a = parseStreamLines('', '{"type":"step","tool":"whoami"}\n{"type":"do');
  assert.deepEqual(a.events.map((e) => e.type), ['step']);
  const b = parseStreamLines(a.rest, 'ne"}\nnot json\n');
  assert.deepEqual(b.events.map((e) => e.type), ['done']);
  assert.equal(b.rest, '');
});

test('the confirmation card shows what will run but masks secret-looking arguments', () => {
  const shown = confirmCardArgs({ name: 'crm', apiKey: 'sk-live-123', nested: { password: 'p', ok: 1 }, token: 't' });
  const flat = JSON.stringify(shown);
  assert.doesNotMatch(flat, /sk-live-123|"p"|"t"/);
  assert.match(flat, /crm/);
  assert.match(flat, /••••/);
});

test('results link to the real artifact in its tab, from a fixed route map', () => {
  assert.equal(artifactLink('dashboard', 'd-1'), '/dashboards?focus=d-1');
  assert.equal(artifactLink('dataset', 'a b'), '/data?focus=a%20b');
  assert.equal(artifactLink('unknown-kind', 'x'), null, 'no model-supplied href');
});

import { linkForResult } from '@tabs/home/lib/chat-view';

test('a create tool\'s result links to its artifact; a read tool or an unparseable result links nowhere', () => {
  assert.equal(linkForResult('create_dashboard', '{"id":"d-9","name":"Sales"}')?.href, '/dashboards?focus=d-9');
  assert.equal(linkForResult('define_metric', '{"metric":{"id":"m-1"}}')?.href, '/metrics?focus=m-1');
  assert.equal(linkForResult('whoami', '{"id":"u-1"}'), null);
  assert.equal(linkForResult('create_dataset', 'plain text'), null);
});

// ---------------------------------------------------------------- i18n: English unchanged, every language present --

test('i18n: the English a refusal, a link and a connect card read is exactly what it was before i18n', () => {
  assert.equal(homeText(plainError({ code: 'forbidden', reason: 'promote requires domain_admin', hint: '' })),
    'This needs the domain admin role, and yours does not allow it. Ask a domain admin to do it, or keep the work in your own space.');
  assert.equal(homeText(plainError({ code: 'forbidden', reason: 'nope', hint: 'Ask an admin.' })), 'You are not allowed to do this. Ask an admin.');
  assert.equal(homeText(plainError({ code: 'forbidden', reason: 'nope', hint: '' })), 'You are not allowed to do this.');
  assert.equal(homeText(plainError({ code: 'not_found', reason: 'x', hint: '' })), 'I could not find that.');
  assert.equal(homeText(plainError({ code: 'conflict', reason: 'it is retired', hint: '' })), "That is not possible in the item's current state. it is retired");
  assert.equal(homeText(plainError({ code: 'bad_request', reason: 'name is empty', hint: '' })), 'Something in the request was not valid: name is empty');
  assert.equal(homeText(plainError({ code: 'engine_unavailable', reason: 'x', hint: 'Check health.' })),
    'A platform component is not reachable right now, so nothing was changed or invented. Check health.');
  assert.equal(homeText(linkForResult('create_dataset', '{"id":"ds_1"}')!.label), 'Open the data product');
  const [card] = connectCards([{ name: 'notion__c1__search', error: { code: 'needs_connect' } }]);
  assert.equal(homeText(card.action), 'Connect your Notion account');
  assert.equal(homeText(card.note), 'This needs your own Notion sign-in. The OS keeps it on the server and uses it only for you.');
  const [mail] = connectCards([{ name: 'm365__c2__mail_send', error: { code: 'needs_connect' } }]);
  assert.equal(homeText(mail.action), 'Reconnect to allow sending');
  assert.equal(homeText(mail.note), 'Drafting and sending mail needs your own Microsoft 365 sign-in with the two mail permissions. Sign in once more and accept them; nothing was sent.');
});

test('i18n: every key the view returns exists in all seven languages', () => {
  const views = [
    plainError({ code: 'forbidden', reason: 'requires builder', hint: '' }),
    plainError({ code: 'forbidden', reason: 'requires creator', hint: 'h' }),
    plainError({ code: 'forbidden', reason: 'requires creator', hint: '' }),
    plainError({ code: 'not_found', reason: 'x', hint: 'h' }),
    plainError({ code: 'conflict', reason: '', hint: '' }),
    plainError({ code: 'upstream_error', reason: 'x', hint: '' }),
    plainError({ code: 'upstream_error', reason: 'x', hint: 'h' }),
    plainError({ code: 'weird', reason: 'x', hint: '' }),
    ...connectCards([{ name: 'gdrive__c3__list', error: { code: 'needs_connect' } }, { name: 'm365__c4__mail_draft', error: { code: 'needs_connect' } }]).flatMap((c) => [c.action, c.note]),
    ...STARTERS.flatMap((s) => [{ key: `chatView.starters.${s.id}.label` }, { key: `chatView.starters.${s.id}.prompt` }]),
  ];
  for (const l of HOME_LOCALES) for (const v of views) assert.ok(homeText(v, l).length > 0, `${l}: ${v.key}`);
  for (const s of STARTERS) {
    assert.equal(homeText({ key: `chatView.starters.${s.id}.prompt` }), s.prompt);
    assert.equal(homeText({ key: `chatView.starters.${s.id}.label` }), s.label);
  }
});
