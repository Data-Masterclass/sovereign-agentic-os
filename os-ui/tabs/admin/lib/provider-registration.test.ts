/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests for the LiteLLM `/model/new` body of an admin-registered provider model.
 * USER STORY: As a platform admin, a provider I register is callable by the shared agent key,
 *             can use LiteLLM's native provider, and is priced so budgets bind.
 * ARCHITECTURE: Pure builder (tabs/admin/lib/provider-registration.ts); no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_REGISTERED_ACCESS_GROUP, perTokenCost } from '@tabs/admin/lib/provider-registration';


test('the access group is the name the chart lists on the shared agent key', async () => {
  const { readFileSync } = await import('node:fs');
  const values = readFileSync(new URL('../../../../charts/sovereign-agentic-os/values.yaml', import.meta.url), 'utf8');
  const block = values.slice(values.indexOf('\nlitellmAgentKey:'), values.indexOf('modelMaxBudget', values.indexOf('\nlitellmAgentKey:')));
  assert.match(block, new RegExp(`^\\s*- ${ADMIN_REGISTERED_ACCESS_GROUP}\\b`, 'm'));
});

test('prices per 1M tokens become LiteLLM per-token costs; a bad price is a 400', () => {
  assert.ok(Math.abs((perTokenCost(0.1, 'Input price') ?? 0) - 1e-7) < 1e-15);
  assert.equal(perTokenCost(null, 'Input price'), undefined);
  assert.throws(() => perTokenCost(-1, 'Input price'), (e: { status?: number }) => e.status === 400);
});
