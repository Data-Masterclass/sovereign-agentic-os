/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Two domains never share one schema / repo identifier
 * USER STORY: As an admin I want a new domain refused when its id sanitizes to the identifier an
 *             existing domain already uses (`a-b`, `a--b`, `a_b` all become `a_b`): its schema
 *             (`iceberg.a_b`), its landing schemas and its dbt project would silently be shared.
 *             As an operator I want a read-only list of any such collisions that already exist.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _reset, createDomain, hydrateDomains, listDomains, domainCollisions } from '@tabs/admin/lib/domains';
import { domainIdent } from '@core/kernel/domain-ident';

beforeEach(() => _reset());

test('a new domain whose sanitized id collides with an existing domain is refused (409), naming both', () => {
  createDomain({ name: 'a-b', owner: 'admin' });
  assert.equal(domainIdent('a--b'), domainIdent('a-b'), 'the precondition: both ids map to one schema');
  assert.throws(
    () => createDomain({ name: 'a--b', owner: 'admin' }),
    (e: Error & { status?: number }) => e.status === 409 && /a-b/.test(e.message) && /a_b/.test(e.message),
  );
  assert.deepEqual(listDomains().map((d) => d.id), ['a-b'], 'nothing was created');
});

test('an archived domain still holds its identifier', async () => {
  const { setArchived } = await import('@tabs/admin/lib/domains');
  createDomain({ name: 'sales-eu', owner: 'admin' });
  setArchived('sales-eu', true);
  assert.throws(() => createDomain({ name: 'sales--eu', owner: 'admin' }), (e: Error & { status?: number }) => e.status === 409);
});

test('negative twin: a domain with a distinct identifier is created', () => {
  createDomain({ name: 'a-b', owner: 'admin' });
  const d = createDomain({ name: 'a-bc', owner: 'admin' });
  assert.equal(d.id, 'a-bc');
  assert.equal(listDomains().length, 2);
});

test('domainCollisions lists every group of domains sharing one identifier (read-only), and nothing else', () => {
  // hydrateDomains (derived from existing memberships) bypasses createDomain: the live store may hold these.
  hydrateDomains(['a-b', 'a--b', 'sales', 'x-y', 'x--y', 'x---y']);
  const before = JSON.stringify(listDomains());
  assert.deepEqual(domainCollisions(listDomains()), [
    { schema: 'a_b', domains: ['a--b', 'a-b'] },
    { schema: 'x_y', domains: ['x---y', 'x--y', 'x-y'] },
  ]);
  assert.equal(JSON.stringify(listDomains()), before, 'the check changes nothing');
  assert.deepEqual(domainCollisions([{ id: 'sales' }, { id: 'hr' }]), [], 'negative twin: no collision, empty list');
});

test('the operator check reads an export read-only: the admin API body, a plain array, or an index search response', async () => {
  const { domainIdsFromJson } = await import('@tabs/admin/lib/domains');
  assert.deepEqual(domainIdsFromJson(JSON.stringify({ domains: [{ id: 'a-b' }, { id: 'a--b' }] })), [{ id: 'a-b' }, { id: 'a--b' }]);
  assert.deepEqual(domainIdsFromJson(JSON.stringify([{ id: 'hr' }])), [{ id: 'hr' }]);
  assert.deepEqual(domainIdsFromJson(JSON.stringify({ hits: { hits: [{ _source: { id: 'x-y' } }, { _id: 'x--y', _source: {} }] } })), [{ id: 'x-y' }, { id: 'x--y' }]);
  assert.throws(() => domainIdsFromJson('{"nothing": 1}'), /no domains/);
});

test('scripts/list-domain-collisions.ts: exit 1 and one JSON line per collision; exit 0 when none', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'domcol-'));
  const run = (body: unknown) => {
    const f = join(dir, `${Math.random()}.json`);
    writeFileSync(f, JSON.stringify(body));
    return spawnSync(process.execPath, ['--import', './scripts/test-setup.mjs', 'scripts/list-domain-collisions.ts', f], { encoding: 'utf8' });
  };
  const bad = run({ domains: [{ id: 'a-b' }, { id: 'a--b' }, { id: 'hr' }] });
  assert.equal(bad.status, 1, bad.stderr);
  assert.deepEqual(bad.stdout.trim().split('\n').map((l) => JSON.parse(l)), [{ kind: 'collision', schema: 'a_b', domains: ['a--b', 'a-b'] }]);
  const ok = run({ domains: [{ id: 'sales' }, { id: 'hr' }] });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), '');
});
