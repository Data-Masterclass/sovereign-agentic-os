/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       i18n
 * FEATURE:    Unit tests for the language contract, the English fallback, the AI answer language and the formatters
 * USER STORY: As a maintainer I want proof that English stays exactly as it was, that a missing translation shows
 *             English rather than a key, and that the AI is told the user's language — and nothing for English.
 * ARCHITECTURE:
 *   - Pure modules only (config, fallback, answer-language, format): no Next, no JSON through the bundler. The
 *     catalogs themselves are checked by scripts/check-i18n.mjs and its own tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_LOCALE, LOCALES, LOCALE_NAMES, NAMESPACES, TAB_NAMESPACES,
  isLocale, localeCookieStale, parseLocaleCookie, resolveRequestLocale, serializeLocaleCookie, toLocale,
} from '@core/i18n/config';
import { missingMessageText, withEnglishFallback } from '@core/i18n/fallback';
import { answerLanguageInstruction, runLocaleSubject, withAnswerLanguage } from '@core/i18n/answer-language';
import {
  formatBytes, formatCompactNumber, formatCurrency, formatDate, formatNumber, formatRelativeTime,
  formatShortRelativeTime, formattersFor,
} from '@core/i18n/format';
import { fmtCompact } from '@core/ui/charts/format';
import { userPrefWriteDecision } from '@core/infra/governed';
import { relativeTime } from '@core/ui/git/git-view';
import { formatSize } from '@core/ui/chat-attachments-view';

// ---------------------------------------------------------------- config --

test('config: seven languages, English first and default, each named in its own language', () => {
  assert.deepEqual([...LOCALES], ['en', 'de', 'fr', 'es', 'it', 'pl', 'cs']);
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.deepEqual(LOCALES.map((l) => LOCALE_NAMES[l]), ['English', 'Deutsch', 'Français', 'Español', 'Italiano', 'Polski', 'Čeština']);
  assert.ok(isLocale('cs'));
  assert.ok(!isLocale('de-DE'));
  assert.equal(toLocale('xx'), 'en');
  assert.equal(toLocale(undefined), 'en');
});

test('config: one namespace per tab module (the closed set of 13) plus the shared ones', () => {
  const tabs = readdirSync(join(process.cwd(), 'tabs')).filter((d) => !d.startsWith('.')).sort();
  assert.deepEqual([...TAB_NAMESPACES].sort(), tabs, 'a tab module without a namespace (or the reverse)');
  assert.deepEqual(NAMESPACES.slice(0, 4), ['shell', 'common', 'settings', 'server']);
});

test('config: the catalog folder holds exactly the namespaces, for every locale', () => {
  for (const l of LOCALES) {
    const files = readdirSync(join(process.cwd(), 'messages', l)).sort();
    assert.deepEqual(files, NAMESPACES.map((n) => `${n}.json`).sort(), `messages/${l}`);
  }
});

test('config: the CI check carries the same languages and namespaces', () => {
  const src = readFileSync(join(process.cwd(), '..', 'scripts', 'check-i18n.mjs'), 'utf8');
  for (const l of LOCALES) assert.match(src, new RegExp(`'${l}'`), `check-i18n.mjs lacks ${l}`);
  for (const n of NAMESPACES) assert.match(src, new RegExp(`'${n}'`), `check-i18n.mjs lacks ${n}`);
});

test('cookie: bound to the user who chose; a second person on the same browser does not inherit it', () => {
  const raw = serializeLocaleCookie('de', 'u-ada@x');
  assert.equal(parseLocaleCookie(raw, 'u-ada@x'), 'de');
  assert.equal(parseLocaleCookie(raw, 'u-ben'), null);
  assert.equal(parseLocaleCookie(raw), 'de', 'signed out: the locale part alone');
  assert.equal(parseLocaleCookie('xx.u-ada', 'u-ada'), null);
  assert.equal(parseLocaleCookie('de', 'u-ada'), null, 'an unbound cookie is not trusted for a signed-in user');
  assert.equal(parseLocaleCookie(undefined), null);
  assert.equal(parseLocaleCookie('de.%E0%A4%A', 'x'), null, 'a malformed id never throws');
});

test('request locale: the saved preference wins; this user\'s cookie is only the fallback; then English', () => {
  // A second device still carries the old cookie: the saved preference (the AI's language too) wins.
  assert.equal(resolveRequestLocale({ cookie: serializeLocaleCookie('fr', 'u1'), userId: 'u1', saved: 'de' }), 'de');
  assert.equal(resolveRequestLocale({ cookie: serializeLocaleCookie('fr', 'u2'), userId: 'u1', saved: 'de' }), 'de');
  // Store unreachable / nothing saved on this pod yet: this user's cookie stands in; another user's never does.
  assert.equal(resolveRequestLocale({ cookie: serializeLocaleCookie('fr', 'u1'), userId: 'u1', saved: null }), 'fr');
  assert.equal(resolveRequestLocale({ cookie: serializeLocaleCookie('fr', 'u2'), userId: 'u1', saved: null }), 'en');
  assert.equal(resolveRequestLocale({ cookie: null, userId: 'u1', saved: null }), 'en');
  // Signed out (the sign-in page): the cookie's locale alone. No Accept-Language anywhere.
  assert.equal(resolveRequestLocale({ cookie: serializeLocaleCookie('pl', 'u1') }), 'pl');
  assert.equal(resolveRequestLocale({}), 'en');
});

test('stale cookie: re-set only when a saved preference exists and the cookie does not mirror it', () => {
  assert.equal(localeCookieStale({ cookie: serializeLocaleCookie('fr', 'u1'), userId: 'u1', saved: 'de' }), true);
  assert.equal(localeCookieStale({ cookie: null, userId: 'u1', saved: 'de' }), true, 'a new device gets its mirror');
  assert.equal(localeCookieStale({ cookie: serializeLocaleCookie('de', 'u2'), userId: 'u1', saved: 'de' }), true, 'another user\'s cookie');
  assert.equal(localeCookieStale({ cookie: serializeLocaleCookie('de', 'u1'), userId: 'u1', saved: 'de' }), false);
  assert.equal(localeCookieStale({ cookie: serializeLocaleCookie('fr', 'u1'), userId: 'u1', saved: null }), false, 'nothing known to sync to');
  assert.equal(localeCookieStale({ cookie: serializeLocaleCookie('fr', 'u1') }), false, 'signed out');
});

test('logout clears the locale cookie; the prefs GET re-sets it from the saved preference', () => {
  const logout = readFileSync(join(process.cwd(), 'app', 'api', 'auth', 'logout', 'route.ts'), 'utf8');
  assert.match(logout, /res\.cookies\.set\(LOCALE_COOKIE, '', sessionCookieOptions\(\{ maxAge: 0 \}\)\)/);
  const prefs = readFileSync(join(process.cwd(), 'app', 'api', 'prefs', 'locale', 'route.ts'), 'utf8');
  assert.match(prefs, /if \(saved\) res\.cookies\.set\(LOCALE_COOKIE, serializeLocaleCookie\(saved, user\.id\)/);
  assert.match(prefs, /authorize\(`user:\$\{user\.id\}`, 'user\.pref\.write', userPrefWriteDecision\(user, 'locale'\)\)/, 'the save is governed');
});

// --------------------------------------------------------------- fallback --

test('fallback: a missing or empty translation shows English, never a key', () => {
  const en = { nav: { home: 'Home', data: 'Data' }, title: 'Settings' };
  const de = { nav: { home: 'Start', data: '' } } as never;
  assert.deepEqual(withEnglishFallback(en, de), { nav: { home: 'Start', data: 'Data' }, title: 'Settings' });
  assert.deepEqual(withEnglishFallback(en, null), en);
  assert.deepEqual(withEnglishFallback(en, { nav: 'oops' } as never), en, 'a wrong shape cannot break a subtree');
  assert.equal(missingMessageText(), '');
});

// --------------------------------------------------------- answer language --

test('answer language: English adds nothing; every other language is named, informal, and keeps content verbatim', () => {
  assert.equal(answerLanguageInstruction('en'), '');
  assert.equal(answerLanguageInstruction(undefined), '');
  assert.equal(answerLanguageInstruction('klingon'), '');
  const names: Record<string, string> = { de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pl: 'Polish', cs: 'Czech' };
  for (const [loc, name] of Object.entries(names)) {
    const chat = answerLanguageInstruction(loc, 'chat');
    assert.match(chat, new RegExp(`ANSWER LANGUAGE: ${name}`));
    assert.match(chat, /informal address/);
    assert.match(chat, /Do NOT translate existing content/);
    const gen = answerLanguageInstruction(loc, 'generated');
    assert.match(gen, new RegExp(`human-readable text value.*in ${name}`));
    assert.match(gen, /never translate them/);
  }
});

test('withAnswerLanguage: appends to the system message, prepends one when absent, English returns the same array', () => {
  const msgs = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'Q' }];
  assert.equal(withAnswerLanguage(msgs, 'en'), msgs);
  const de = withAnswerLanguage(msgs, 'de');
  assert.equal(msgs[0].content, 'SYS', 'input not mutated');
  assert.match(de[0].content, /^SYS\n\n--- ANSWER LANGUAGE: German ---/);
  assert.equal(de[1], msgs[1]);
  const noSys = withAnswerLanguage([{ role: 'user', content: 'Q' }], 'cs', 'chat');
  assert.equal(noSys[0].role, 'system');
  assert.match(noSys[0].content, /^--- ANSWER LANGUAGE: Czech ---/);
});

test('agent runs: by hand → the runner; schedule or API → the owner', () => {
  assert.equal(runLocaleSubject('manual', 'runner', 'owner'), 'runner');
  assert.equal(runLocaleSubject(undefined, 'runner', 'owner'), 'runner');
  assert.equal(runLocaleSubject('schedule', 'runner', 'owner'), 'owner');
  assert.equal(runLocaleSubject('api', 'runner', 'owner'), 'owner');
  assert.equal(runLocaleSubject('api', 'runner', undefined), 'runner');
});

// ---------------------------------------------------------------- format --

const NOW = Date.parse('2026-11-26T12:00:00Z');

test('format: English output of the three pre-i18n helpers is unchanged', () => {
  assert.equal(fmtCompact(1_234_567), '1.2M');
  assert.equal(fmtCompact(34_500), '34.5k');
  assert.equal(fmtCompact(812), '812');
  assert.equal(fmtCompact(0.256), '0.26');
  assert.equal(fmtCompact(2.5e9), '2.5B');
  assert.equal(fmtCompact(NaN), '—');
  assert.equal(relativeTime(new Date(NOW - 10_000).toISOString(), NOW), 'just now');
  assert.equal(relativeTime(new Date(NOW - 4 * 60_000).toISOString(), NOW), '4 min ago');
  assert.equal(relativeTime(new Date(NOW - 3 * 3600_000).toISOString(), NOW), '3 h ago');
  assert.equal(relativeTime(new Date(NOW - 2 * 86400_000).toISOString(), NOW), '2 d ago');
  assert.equal(relativeTime('2026-01-02T00:00:00Z', NOW), '2026-01-02');
  assert.equal(relativeTime('nope', NOW), '');
  assert.equal(formatSize(1_572_864), '1.5 MB');
  assert.equal(formatSize(12_288), '12 KB');
  assert.equal(formatSize(300), '300 B');
});

test('format: other locales use their own separators and phrases', () => {
  assert.equal(formatNumber(1234.5, 'de'), '1.234,5');
  assert.equal(formatNumber(1234.5, 'en'), '1,234.5');
  assert.equal(formatNumber(Infinity, 'de'), '—');
  assert.match(formatCompactNumber(1_234_567, 'de'), /^1,2\s?Mio\.$/);
  assert.equal(formatCompactNumber(812, 'de'), '812');
  assert.equal(formatCompactNumber(0.256, 'fr'), '0,26');
  assert.match(formatCurrency(1234.5, 'EUR', 'de'), /^1\.234,50\s€$/);
  assert.equal(formatCurrency(1234.5, 'EUR', 'en'), '€1,234.50');
  assert.equal(formatBytes(1_572_864, 'de'), '1,5 MB');
  assert.equal(formatDate('2026-11-26T12:00:00Z', 'de', { dateStyle: 'medium', timeZone: 'UTC' }), '26.11.2026');
  assert.equal(formatDate('nope', 'de'), '');
  assert.equal(formatRelativeTime(NOW - 4 * 60_000, 'de', NOW), 'vor 4 Minuten');
  assert.equal(formatRelativeTime(NOW - 4 * 60_000, 'en', NOW), '4 minutes ago');
  assert.equal(formatRelativeTime(NOW - 86400_000, 'fr', NOW), 'hier');
  assert.equal(formatRelativeTime(NOW, 'en', NOW), 'now');
  assert.equal(formatShortRelativeTime(new Date(NOW - 4 * 60_000).toISOString(), NOW, 'de'), 'vor 4 Min.');
  assert.equal(fmtCompact(34_500, 'it').replace(/\s/g, ' '), formatCompactNumber(34_500, 'it').replace(/\s/g, ' '));
});

test('format: formattersFor binds one locale (unknown → English)', () => {
  const f = formattersFor('pl');
  assert.equal(f.locale, 'pl');
  assert.equal(f.number(1234.5), formatNumber(1234.5, 'pl'));
  assert.equal(formattersFor('xx').locale, 'en');
});

test('user_pref_write decision: the caller\'s OWN record, the named preference only', () => {
  const d = userPrefWriteDecision({ id: 'u-ada', role: 'creator', domains: ['sales'] }, 'locale');
  assert.equal(d.rule, 'user_pref_write');
  assert.deepEqual(d.input, { action: 'user.pref.write', pref: 'locale', actor: { id: 'u-ada', role: 'creator', domains: ['sales'] }, target: { user: 'u-ada' } });
});
