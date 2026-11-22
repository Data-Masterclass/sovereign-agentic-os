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
import { plainError, parseStreamLines, confirmCardArgs, artifactLink } from '@tabs/home/lib/chat-view';

test('a forbidden refusal names the role in words and says who to ask', () => {
  const m = plainError({ code: 'forbidden', reason: 'promote requires domain_admin; you are creator', hint: 'Ask a domain_admin to run it, or keep your work Personal.' });
  assert.match(m, /domain admin/i);
  assert.match(m, /ask a domain admin/i);
  assert.doesNotMatch(m, /domain_admin/, 'no raw role id in user-facing text');
});

test('other typed codes get a plain sentence and keep the server hint; unknown codes fall back to the reason', () => {
  assert.match(plainError({ code: 'not_found', reason: 'no such dataset', hint: 'Check the id' }), /could not find/i);
  assert.match(plainError({ code: 'upstream_error', reason: 'fetch failed', hint: 'Check health' }), /not reachable|unavailable/i);
  assert.match(plainError({ code: 'weird', reason: 'something odd', hint: 'h' }), /something odd/);
});

test('NEGATIVE TWIN: a role that is not gated text is not rewritten as a role refusal', () => {
  assert.doesNotMatch(plainError({ code: 'bad_request', reason: 'x', hint: 'y' }), /ask a .* admin/i);
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
