/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       prefs
 * FEATURE:    Tests for the per-user language store
 * USER STORY: As a user my language is saved to my account (not just this browser); the run worker reads it fresh,
 *             so my scheduled agent answers in the language I chose after it booted.
 * ARCHITECTURE:
 *   - Real store, real `osMirror`, a stubbed OpenSearch (global fetch) that holds documents by id — the same
 *     shape the conversation tests use. `__resetLocaleForTests` simulates a fresh process (the worker).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetLocaleForTests, getSavedLocale, getUserLocale, getUserLocaleFresh, localeDocId, setUserLocale } from '@core/prefs/locale';

const DOCS = new Map<string, Record<string, unknown>>();
let DOWN = false;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (DOWN) throw new Error('connect ECONNREFUSED');
  const url = String(input);
  const method = init?.method ?? 'GET';
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const byId = url.match(/\/_doc\/([^?]+)/);
  if (byId) {
    const id = decodeURIComponent(byId[1]);
    if (method === 'PUT') { DOCS.set(id, JSON.parse(String(init?.body))); return json({ result: 'created' }, 201); }
    const d = DOCS.get(id);
    return d ? json({ _source: d }) : json({ found: false }, 404);
  }
  if (/_search/.test(url)) return json({ hits: { total: { value: DOCS.size }, hits: [...DOCS.values()].map((d) => ({ _source: d })) } });
  if (/_count/.test(url)) return json({ count: DOCS.size });
  return new Response(method === 'HEAD' ? null : '{}', { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

beforeEach(() => {
  DOCS.clear();
  DOWN = false;
  __resetLocaleForTests();
});

test('a user who never chose has no saved language and reads as English', async () => {
  assert.equal(await getSavedLocale('u-new'), null);
  assert.equal(await getUserLocale('u-new'), 'en');
});

test('a saved language is written to the shared store and read back', async () => {
  assert.deepEqual(await setUserLocale('u-ada', 'de'), { ok: true });
  assert.equal(await getUserLocale('u-ada'), 'de');
  assert.deepEqual(DOCS.get(localeDocId('u-ada'))?.locale, 'de');
  __resetLocaleForTests(); // another process / after a deploy
  assert.equal(await getUserLocale('u-ada'), 'de');
});

test('other prefs rows in the shared index are never read as a language', async () => {
  DOCS.set('viewsurface-u-ada', { userId: 'u-ada', viewSurface: 'run' });
  DOCS.set('tile-u-ada', { userId: 'u-ada', surface: 'home', order: ['a'] });
  DOCS.set('locale-u-ben', { userId: 'u-ben', locale: 'xx' });
  assert.equal(await getSavedLocale('u-ada'), null);
  assert.equal(await getSavedLocale('u-ben'), null, 'an unknown code is not a language');
});

test('the worker reads FRESH: a change made after its boot is seen; absent is English', async () => {
  assert.equal(await getUserLocale('u-ada'), 'en'); // the worker hydrated before the user chose
  DOCS.set(localeDocId('u-ada'), { userId: 'u-ada', locale: 'pl' }); // the web process saved meanwhile
  assert.equal(await getUserLocale('u-ada'), 'en', 'the cached copy is stale');
  assert.equal(await getUserLocaleFresh('u-ada'), 'pl');
  assert.equal(await getUserLocale('u-ada'), 'pl', 'the fresh read refreshes the cache');
  assert.equal(await getUserLocaleFresh('u-nobody'), 'en');
});

test('a store that does not confirm the write is reported, and nothing is remembered', async () => {
  DOWN = true;
  const r = await setUserLocale('u-ada', 'fr');
  assert.equal(r.ok, false);
  assert.equal(await getUserLocaleFresh('u-ada'), 'en', 'unreachable → the cache → English');
});
