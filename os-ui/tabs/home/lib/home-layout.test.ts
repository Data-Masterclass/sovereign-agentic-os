/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Home layout — chat first, golden-path tiles compact but still routing
 * USER STORY: As a user I want a big chat on Home and the tiles still one click away.
 * ARCHITECTURE: the pure launcher plus a source-text tripwire on the page (a `.tsx` page cannot be
 *             imported under node --test).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launcherFor } from '@tabs/home/lib/launcher';

const OSUI = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p: string) => readFileSync(resolve(OSUI, p), 'utf8');

test('the tiles still route: every golden path keeps its exact tab and deep link', () => {
  const hrefs = Object.fromEntries(launcherFor('creator').map((c) => [c.id, c.href]));
  assert.deepEqual(hrefs, {
    data: '/data?from=home&action=create',
    files: '/unstructured?from=home&action=create',
    knowledge: '/knowledge?from=home&action=create',
    connections: '/connections', // Builder-gated: explore only, no create action
    metrics: '/metrics?from=home&action=create',
    dashboards: '/dashboards?from=home&action=create',
    agents: '/agents?from=home&action=create',
    workflows: '/workflows?from=home&action=create',
    software: '/software?from=home&action=create',
  });
});

test('NEGATIVE TWIN: a dimmed tile never carries a create action', () => {
  for (const c of launcherFor('creator').filter((x) => !x.canAct)) assert.doesNotMatch(c.href, /action=/);
});

test('Home renders the chat and the launcher in its compact form', () => {
  const page = read('app/page.tsx');
  assert.match(page, /HomeChat/);
  assert.match(page, /<HomeLauncher[^>]*compact/);
  assert.doesNotMatch(page, /<HomeLauncher cards=\{feed\.launcher\} \/>/, 'no full-size gallery any more');
  const tile = read('tabs/home/ui/HomeLauncher.tsx');
  assert.match(tile, /href=\{c\.href\}/, 'the tile still links to the card href');
});

test('the chat shell talks to the governed assistant route only, and renders no model markup', () => {
  const ui = read('tabs/home/ui/HomeChat.tsx');
  // The turn itself is sent by the one chat session both Home and the panel render.
  const session = read('core/ui/chat-session.ts');
  assert.match(session, /'\/api\/assistant\/chat'/);
  assert.match(ui, /chatSession\.send\(/);
  // The decision POST lives in the card shared with the drawer.
  const card = read('core/ui/ConfirmCard.tsx');
  assert.match(card, /\/api\/assistant\/chat/);
  assert.match(card, /confirmation: \{ id: p\.confirmationId/);
  assert.match(ui, /sendDecision\(/);
  for (const src of [ui, card, session]) assert.doesNotMatch(src, /dangerouslySetInnerHTML|eval\(|new Function/);
});

test('history and save-as: the chat uses the per-user conversation routes, and each route scopes by the signed-in user', () => {
  const ui = read('tabs/home/ui/HomeChat.tsx');
  assert.match(ui, /fetch\('\/api\/assistant\/conversations'\)/);
  assert.match(ui, /saveAs: k/);
  for (const f of ['app/api/assistant/conversations/route.ts', 'app/api/assistant/conversations/[id]/route.ts']) {
    const src = read(f);
    assert.match(src, /requireUser/, `${f} needs a signed-in user`);
    assert.match(src, /user\.id/, `${f} scopes every read by the caller's id`);
  }
  const chat = read('app/api/assistant/chat/route.ts');
  assert.match(chat, /canContinue\(user\.id, conversationId\)/, 'a conversation of another user cannot be continued');
});
