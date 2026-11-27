/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       i18n
 * FEATURE:    Unit tests for coded server messages — envelope, client rendering, recipient-language text
 * USER STORY: As a maintainer I want proof that a coded error keeps its English byte-for-byte for API clients,
 *             that only dotted UI codes are ever looked up, that unknown codes and bad params fall back to the
 *             English the server sent, and that a notification renders in the recipient's language.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanParams, codedError, errorBody, errorBodyOf, isServerCode, serverMessageOf, withServerCode,
} from '@core/kernel/server-message';
import { englishOf, readServerMessage, renderServerMessage, type ServerTranslator } from '@core/i18n/server-message';
import { serverTextFor } from '@core/i18n/server-text';
import { assertServerEnglish } from '@core/testing/server-message';
import { catalogText, hasCatalogKey } from '@core/testing/catalog-text';

/** A translator over the on-disk catalog of one locale (the same ICU engine as next-intl). */
function catalogT(locale: string): ServerTranslator {
  const t = ((key: string, values?: Record<string, string | number>) => catalogText('server', { key, args: values }, locale)) as ServerTranslator;
  t.has = (key: string) => hasCatalogKey('server', key, locale);
  return t;
}

test('only dotted camelCase codes are UI codes; flat machine codes never are', () => {
  for (const c of ['auth.adminOnly', 'data.notFound', 'a.b.c']) assert.equal(isServerCode(c), true, c);
  for (const c of ['forbidden', 'not_found', 'policy_denied', 'opa-denied', 'ENOENT', 'Auth.x', 'auth.', '.x', 'auth.admin-only', '', 42, null]) {
    assert.equal(isServerCode(c), false, String(c));
  }
});

test('params keep only bounded strings and finite numbers', () => {
  assert.deepEqual(cleanParams({ name: 'x', n: 3, bad: { a: 1 }, nan: Number.NaN, arr: [1], fn: () => 1, '9x': 'y' }), { name: 'x', n: 3 });
  assert.equal(cleanParams(null), undefined);
  assert.equal(cleanParams(['a']), undefined);
  assert.equal((cleanParams({ s: 'x'.repeat(5000) })!.s as string).length, 2000);
});

test('errorBody: no code is exactly { error }; a code adds code (+ params)', () => {
  assert.deepEqual(errorBody('Nope'), { error: 'Nope' });
  assert.deepEqual(errorBody('Admin only', 'auth.adminOnly'), { error: 'Admin only', code: 'auth.adminOnly' });
  assert.deepEqual(errorBody('Hi x', 'a.b', { name: 'x' }), { error: 'Hi x', code: 'a.b', params: { name: 'x' } });
});

test('a coded error keeps status and English; only a branded error forwards its code', () => {
  const e = codedError(403, 'Admin only', 'auth.adminOnly');
  assert.equal(e.message, 'Admin only');
  assert.equal(e.status, 403);
  assert.deepEqual(errorBodyOf(e), { error: 'Admin only', code: 'auth.adminOnly' });
  // A Node / driver error with its own `code` is never forwarded.
  const node = Object.assign(new Error('ENOENT: no such file /secret/path'), { code: 'ENOENT' });
  assert.deepEqual(errorBodyOf(node), { error: 'ENOENT: no such file /secret/path' });
  const dotted = Object.assign(new Error('x'), { code: 'auth.adminOnly' });
  assert.deepEqual(serverMessageOf(dotted), {}, 'an unbranded error with a dotted code is still not forwarded');
  const tagged = withServerCode(Object.assign(new Error('Out'), { status: 404 }), 'a.b', { id: 'd1' });
  assert.deepEqual(errorBodyOf(tagged), { error: 'Out', code: 'a.b', params: { id: 'd1' } });
  assert.equal((tagged as { status?: number }).status, 404);
  assert.deepEqual(errorBodyOf('thrown string'), { error: undefined }, 'a thrown string yields no error text, as before');
});

test('the auth guards render their exact English and exist in every language', () => {
  for (const [english, code] of [
    ['Not authenticated', 'auth.notAuthenticated'],
    ['Complete first-run setup before using the platform', 'auth.setupRequired'],
    ['Admin only', 'auth.adminOnly'],
  ] as const) assertServerEnglish(errorBody(english, code));
});

test('renderServerMessage: known code → the active language; unknown / flat / missing → the English sent; else fallback', () => {
  const de = catalogT('de');
  assert.equal(renderServerMessage(de, { error: 'Admin only', code: 'auth.adminOnly' }), 'Nur für Admins');
  assert.equal(renderServerMessage(catalogT('en'), { error: 'Admin only', code: 'auth.adminOnly' }), 'Admin only');
  assert.equal(renderServerMessage(de, { error: 'Specific English', code: 'nope.unknownCode' }), 'Specific English');
  assert.equal(renderServerMessage(de, { error: 'Out of scope', code: 'forbidden' }), 'Out of scope', 'a flat code is never looked up');
  assert.equal(renderServerMessage(de, { error: 'x' }), 'x');
  assert.equal(renderServerMessage(de, {}, 'Failed'), 'Failed');
  assert.equal(renderServerMessage(de, null, 'Failed'), 'Failed');
  assert.equal(renderServerMessage(de, { reason: 'Blocked' }, 'Failed'), 'Failed', 'reads `error` unless told otherwise');
  assert.equal(renderServerMessage(de, { reason: 'Blocked' }, 'Failed', 'reason'), 'Blocked');
});

test('a translator that renders empty (next-intl\'s fallback for a formatting error) falls back to the English', () => {
  const empty = (() => '') as unknown as ServerTranslator;
  empty.has = () => true;
  assert.equal(renderServerMessage(empty, { error: 'Admin only', code: 'auth.adminOnly' }), 'Admin only');
});

test('readServerMessage / englishOf read only what they should', () => {
  assert.deepEqual(readServerMessage({ code: 'a.b', params: { n: 1, o: {} } }), { code: 'a.b', params: { n: 1 } });
  assert.equal(readServerMessage({ code: 'flat' }), null);
  assert.equal(englishOf('plain'), 'plain');
  assert.equal(englishOf({ error: '' }), undefined);
});

test('serverTextFor renders in the given (recipient) language, English for unknown locales or codes', () => {
  assert.equal(serverTextFor('de')('auth.adminOnly', undefined, 'Admin only'), 'Nur für Admins');
  assert.equal(serverTextFor('pl')('auth.adminOnly', undefined, 'Admin only'), 'Tylko dla administratorów');
  assert.equal(serverTextFor('en')('auth.adminOnly', undefined, 'Admin only'), 'Admin only');
  assert.equal(serverTextFor('xx')('auth.adminOnly', undefined, 'Admin only'), 'Admin only');
  assert.equal(serverTextFor(null)('auth.adminOnly', undefined, 'Admin only'), 'Admin only');
  assert.equal(serverTextFor('de')('nope.unknown', undefined, 'English'), 'English');
});
