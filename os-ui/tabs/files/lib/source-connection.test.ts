/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A Files-tab drive source is always linked to the caller's own drive connection
 * USER STORY: As a user adding my OneDrive in Files → Sources I want the source to use my
 *             connected OneDrive's sign-in, so its sync reads my real drive instead of failing
 *             with "no Read token".
 * ARCHITECTURE:
 *   - `chooseSourceConnection` (tabs/files/lib/connectors.ts), which the POST
 *     /api/files/connectors route calls with the caller's own drive connections. The twins
 *     refuse another user's connection, the wrong provider, and an unlinked source in production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseSourceConnection, type SourceConnectionCandidate } from '@tabs/files/lib/connectors';

const me = 'aborek';
const od1: SourceConnectionCandidate = { id: 'conn_od1', name: 'My OneDrive', owner: me, provider: 'onedrive' };
const od2: SourceConnectionCandidate = { id: 'conn_od2', name: 'Work OneDrive', owner: me, provider: 'onedrive' };
const gd: SourceConnectionCandidate = { id: 'conn_gd', name: 'My Drive', owner: me, provider: 'google-drive' };
const theirs: SourceConnectionCandidate = { id: 'conn_x', name: 'Their OneDrive', owner: 'someone-else', provider: 'onedrive' };
const status = (code: number) => (e: Error & { status?: number }) => e.status === code;

test('the one connected OneDrive is linked when the form names none', () => {
  assert.equal(chooseSourceConnection({ provider: 'onedrive', userId: me, candidates: [od1, gd, theirs], allowUnlinked: false }), 'conn_od1');
});

test('a requested own connection is linked', () => {
  assert.equal(chooseSourceConnection({ provider: 'onedrive', userId: me, requested: 'conn_od2', candidates: [od1, od2], allowUnlinked: false }), 'conn_od2');
});

test('twin: several OneDrive connections and none chosen → 400 (the form asks which)', () => {
  assert.throws(() => chooseSourceConnection({ provider: 'onedrive', userId: me, candidates: [od1, od2], allowUnlinked: false }), status(400));
});

test("twin: someone else's connection is refused (403), even by id", () => {
  assert.throws(() => chooseSourceConnection({ provider: 'onedrive', userId: me, requested: 'conn_x', candidates: [theirs], allowUnlinked: false }), status(403));
});

test('twin: a Google Drive connection cannot back a OneDrive source (403)', () => {
  assert.throws(() => chooseSourceConnection({ provider: 'onedrive', userId: me, requested: 'conn_gd', candidates: [gd], allowUnlinked: false }), status(403));
});

test('twin: production refuses an unlinked source — 409 says to connect first', () => {
  assert.throws(() => chooseSourceConnection({ provider: 'onedrive', userId: me, candidates: [gd, theirs], allowUnlinked: false }),
    (e: Error & { status?: number }) => e.status === 409 && /Connect your OneDrive in Connections first/.test(e.message));
});

test('the local teaching flow may add an unlinked source (fake drive)', () => {
  assert.equal(chooseSourceConnection({ provider: 'onedrive', userId: me, candidates: [], allowUnlinked: true }), null);
});
