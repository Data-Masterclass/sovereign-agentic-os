/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    `platform` is a reserved name, never a domain id
 * USER STORY: As a platform admin I must not be able to create a domain called "platform": the
 *             platform-wide git repository is named `platform` and Trino's access rules use the same
 *             name, so a domain with that id would share an identity with the platform layer.
 * ARCHITECTURE: `createDomain` refuses any name whose id slugs to the reserved `PLATFORM_REPO`
 *             (`core/infra/repo-layout.ts`) with a 400 before anything is stored. Negative twin: a
 *             name that merely contains the word (`platform-team`) is still a valid domain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _reset, createDomain, listDomains } from '@tabs/admin/lib/domains';

for (const name of ['platform', 'Platform', ' PLATFORM ']) {
  test(`createDomain refuses the reserved id for "${name}"`, () => {
    _reset();
    assert.throws(() => createDomain({ name, owner: 'admin@example.com' }), (e: Error & { status?: number }) => e.status === 400 && /reserved/i.test(e.message));
    assert.ok(!listDomains().some((d) => d.id === 'platform'), 'nothing was stored');
  });
}

test('TWIN: a name that only contains the word is a valid domain', () => {
  _reset();
  const d = createDomain({ name: 'platform-team', owner: 'admin@example.com' });
  assert.equal(d.id, 'platform-team');
});
