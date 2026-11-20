/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    The admin collision check and the data tab agree on a domain's identifier
 * USER STORY: As an admin I want the domain-collision refusal to use exactly the schema name the
 *             data tab writes to, so "no collision" really means "no shared schema".
 * ARCHITECTURE:
 *   - Pins `core/kernel/domain-ident.domainIdent` to `store-fqn.domainSchema` over a corpus.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainIdent } from '@core/kernel/domain-ident';
import { domainSchema } from '@tabs/data/lib/store-fqn';

test('domainIdent equals store-fqn.domainSchema for every domain id shape', () => {
  for (const id of ['sales', 'a-b', 'a--b', 'a_b', 'agentic-leader-q3-2026', 'x---y', 'Sales-EU', '9lives', 'a-b-', 'q3_2026']) {
    assert.equal(domainIdent(id), domainSchema(id), id);
  }
});
