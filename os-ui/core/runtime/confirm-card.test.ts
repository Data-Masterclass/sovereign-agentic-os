/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Confirm card's content — derived from the tool name and the stored arguments.
 * USER STORY: As a user I want the card to tell me plainly what will run, to mark what I cannot
 *             take back, and never to show a secret or offer a shortcut the server did not allow.
 * ARCHITECTURE: the pure projection (`confirm-card.ts`) against the real classification tables.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_MCP_TOOLS } from '@core/mcp/server';
import { SESSION_ALLOWABLE_TOOLS, needsUserConfirm } from '@core/mcp/tool-classes';
import {
  MAX_CARD_ARGS_CHARS,
  consequenceLine,
  describeConfirmation,
  isDangerTool,
  maskForDisplay,
  parseConfirmCards,
  plainTitle,
} from '@core/runtime/confirm-card';

const base = { confirmationId: 'cfm_1', expiresAt: '2026-11-19T12:10:00.000Z' };

test('every tool that can be parked gets a plain title, a consequence line and a server-decided third-button flag', () => {
  for (const t of ALL_MCP_TOOLS.filter((x) => needsUserConfirm(x.name))) {
    const card = describeConfirmation({ ...base, tool: t.name, args: { id: 'x' }, description: t.description });
    assert.ok(card.title.length > 2 && !card.title.includes('_'), `${t.name}: title '${card.title}'`);
    assert.ok(card.consequence.length > 30, `${t.name}: no consequence line`);
    assert.match(card.consequence, /runs as you, with your own rights, only if you confirm/);
    assert.doesNotMatch(card.consequence, /second person|safety preset/, `${t.name}: the agent-run wording leaked onto a self-confirm card`);
    assert.equal(card.sessionAllowable, Object.hasOwn(SESSION_ALLOWABLE_TOOLS, t.name), `${t.name}: third-button flag`);
    assert.equal(card.danger, /^(delete|archive|retire)(_|$)/.test(t.name), `${t.name}: danger flag`);
    assert.ok(!(card.danger && card.sessionAllowable), `${t.name}: a danger tool must never be allowable for a conversation`);
    assert.ok(card.description.length <= 240);
  }
});

test('titles, danger and consequences for the tools the owner named', () => {
  assert.equal(plainTitle('create_dataset'), 'create dataset');
  assert.equal(plainTitle('delete'), 'delete an app');
  assert.equal(plainTitle('request_deploy'), 'file a deploy request');
  assert.equal(plainTitle('constructor'), 'constructor');
  assert.equal(plainTitle(''), 'run an unnamed tool');
  for (const name of ['delete', 'archive', 'retire', 'retire_dataset', 'retire_connection', 'retire_knowledge']) assert.equal(isDangerTool(name), true, name);
  for (const name of ['create_dataset', 'request_deploy', 'deleted_items', 'unarchive', 'retirement']) assert.equal(isDangerTool(name), false, name);
  // The hold gate's own reason is reused where it fits…
  assert.match(consequenceLine('delete'), /^It is destructive: it deletes an app\./);
  assert.match(consequenceLine('request_deploy'), /^It asks for a go-live\. Your confirmation files the request; the review it opens is still decided by a person\./);
  assert.match(consequenceLine('request_promotion'), /My → Domain boundary\. The domain-admin step it leads to still applies\./);
  // …and a plain My-scope write says the plain thing.
  assert.match(consequenceLine('create_dataset'), /^Nothing has been changed yet\./);
});

test('key arguments are the readable scalars first; secrets are masked at any depth; a huge payload is clipped for display only', () => {
  const args = {
    contentBase64: 'QUJD',
    name: 'Orders',
    datasetId: 'ds_1',
    password: 'hunter2',
    config: { apiKey: 'sk-live-1', host: 'db.internal', nested: [{ token: 't-9', ok: true }] },
    note: 'line one\nline two',
    empty: '',
  };
  const card = describeConfirmation({ ...base, tool: 'configure_connection', args });
  assert.deepEqual(card.keyArgs.slice(0, 2), [{ name: 'name', value: 'Orders' }, { name: 'datasetId', value: 'ds_1' }]);
  assert.equal(card.keyArgs.length, 4);
  assert.ok(card.keyArgs.every((k) => k.name !== 'empty'));
  const shown = JSON.stringify(card);
  assert.doesNotMatch(shown, /hunter2|sk-live-1|t-9/);
  assert.match(card.argsJson, /"host": "db.internal"/);
  assert.match(card.argsJson, /"password": "••••••"/);
  assert.equal(args.password, 'hunter2', 'masking never touches the real arguments');
  assert.deepEqual(maskForDisplay({ token: '', secret: null }), { token: '', secret: null }, 'an empty secret is shown as empty, not as if one were set');

  const huge = describeConfirmation({ ...base, tool: 'upload_file', args: { name: 'f', content: 'x'.repeat(MAX_CARD_ARGS_CHARS * 2) } });
  assert.ok(huge.argsJson.length < MAX_CARD_ARGS_CHARS + 300);
  assert.match(huge.argsJson, /more characters not shown; the full arguments are held on the server and are what runs/);
});

test('parseConfirmCards drops anything malformed and offers the third button only on a literal true', () => {
  assert.deepEqual(parseConfirmCards(null), []);
  assert.deepEqual(parseConfirmCards('x'), []);
  const good = describeConfirmation({ ...base, tool: 'create_dataset', args: { name: 'A' } });
  const parsed = parseConfirmCards([good, null, { tool: 'x' }, { ...good, confirmationId: 'cfm_2', sessionAllowable: 1, danger: 'yes', keyArgs: [{ name: 'a' }, { name: 'b', value: 'c' }] }]);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], good);
  assert.equal(parsed[1].sessionAllowable, false);
  assert.equal(parsed[1].danger, false);
  assert.deepEqual(parsed[1].keyArgs, [{ name: 'b', value: 'c' }]);
});
