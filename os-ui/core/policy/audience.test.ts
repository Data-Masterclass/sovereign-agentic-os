/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The audience-change summary and audit event (core/policy/audience.ts)
 * USER STORY: As an auditor I want the summary to name exactly what changed and the event to be
 *             findable by the artifact id.
 * ARCHITECTURE:
 *   - Pure unit tests over describe/record; the per-store wiring is tested next to each store.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { audienceOf, describeAudienceChange, recordAudienceChange } from '@core/policy/audience';
import { search, __resetAudit } from '@core/policy/audit';

beforeEach(() => __resetAudit());

const g = (kind: string, id: string) => ({ grantee: { kind, id } });

test('describe names tier, visibility and grant adds/removes; unchanged is null', () => {
  const a = audienceOf({ tier: 'dataset', visibility: 'private', grants: [] });
  const b = audienceOf({ tier: 'asset', visibility: 'domain', grants: [g('domain', 'sales'), g('domain', 'sales')] });
  assert.equal(describeAudienceChange(a, b), 'tier dataset → asset, visibility private → domain, grants +domain:sales');
  assert.equal(describeAudienceChange(b, a), 'tier asset → dataset, visibility domain → private, grants -domain:sales');
  assert.equal(describeAudienceChange(b, audienceOf({ tier: 'asset', visibility: 'domain', grants: [g('domain', 'sales')] })), null);
  // grant order is not a change
  const c1 = audienceOf({ tier: 'asset', visibility: 'domain', grants: [g('user', 'x'), g('domain', 'sales')] });
  const c2 = audienceOf({ tier: 'asset', visibility: 'domain', grants: [g('domain', 'sales'), g('user', 'x')] });
  assert.equal(describeAudienceChange(c1, c2), null);
});

test('record writes an audience.change audit entry with the id in the (indexed) target', () => {
  const before = audienceOf({ tier: 'dataset', visibility: 'private', grants: [] });
  const after = audienceOf({ tier: 'asset', visibility: 'domain', grants: [g('domain', 'sales')] });
  const s = recordAudienceChange({ kind: 'dataset', id: 'ds_x1', name: 'X', domain: 'sales', actor: 'dana', via: 'promote', before, after });
  assert.equal(s, 'tier dataset → asset, visibility private → domain, grants +domain:sales');
  const [e] = search({ action: 'audience.change' });
  assert.equal(e.subject, 'dataset:ds_x1 (X)');
  assert.equal(e.actor, 'dana');
  assert.equal(e.domain, 'sales');
  assert.equal(e.reason, 'promote: tier dataset → asset, visibility private → domain, grants +domain:sales');
  // (The write-through to the durable os-audit store as `governance.audience.change` is record()'s
  // own contract — core/policy/audit-consolidation.test.ts.)
});

test('an unchanged audience records nothing', () => {
  const same = audienceOf({ tier: 'asset', visibility: 'domain', grants: [] });
  assert.equal(recordAudienceChange({ kind: 'file', id: 'f', name: 'f', domain: 's', actor: 'a', via: 'edit', before: same, after: same }), null);
  assert.equal(search({ action: 'audience.change' }).length, 0);
});
