/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tests for the read-only user DIRECTORY filter (directoryVisibleTo) that backs
 * GET /api/users/domain — the list a Sovereign standard app's admin area shows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directoryVisibleTo, type PublicUser } from './users.ts';

const USERS: PublicUser[] = [
  { id: 'ana', name: 'Ana', domains: ['sales'], role: 'creator', email: 'ana@x.example' },
  { id: 'ben', name: 'Ben', domains: ['sales', 'ops'], role: 'builder' },
  { id: 'cyn', name: 'Cyn', domains: ['ops'], role: 'domain_admin' },
  { id: 'dot', name: 'Dot', domains: ['hr'], role: 'admin' },
  { id: 'eve', name: 'Eve', domains: ['sales'], role: 'creator', disabled: true },
];

test('directory: creators and builders see nobody (people-admin surface)', () => {
  assert.deepEqual(directoryVisibleTo({ role: 'creator', domains: ['sales'] }, USERS), []);
  assert.deepEqual(directoryVisibleTo({ role: 'builder', domains: ['sales'] }, USERS), []);
});

test('directory: a domain_admin sees only users sharing their domain(s)', () => {
  const seen = directoryVisibleTo({ role: 'domain_admin', domains: ['sales'] }, USERS);
  assert.deepEqual(seen.map((u) => u.id), ['ana', 'ben'], 'sales users only; hr/ops-only users hidden');
});

test('directory: an admin sees everyone (active)', () => {
  const seen = directoryVisibleTo({ role: 'admin', domains: ['hr'] }, USERS);
  assert.deepEqual(seen.map((u) => u.id), ['ana', 'ben', 'cyn', 'dot']);
});

test('directory: disabled users are excluded', () => {
  const seen = directoryVisibleTo({ role: 'domain_admin', domains: ['sales'] }, USERS);
  assert.ok(!seen.some((u) => u.id === 'eve'), 'disabled accounts never listed');
});

test('directory: rows carry only id, name, role and domains — never email/flags', () => {
  const [row] = directoryVisibleTo({ role: 'domain_admin', domains: ['sales'] }, USERS);
  assert.deepEqual(Object.keys(row).sort(), ['domains', 'id', 'name', 'role']);
});
