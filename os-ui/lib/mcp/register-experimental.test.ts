/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpTool } from './server.ts';
import { getRegisteredTools, isBundleRegistered } from './registry.ts';
import { registerExperimentalBundles } from './register-experimental.ts';

const tool = (name: string): McpTool => ({
  name,
  description: name,
  minRole: 'creator',
  tab: 'meta',
  inputSchema: { type: 'object', properties: {} },
  call: async () => null,
});
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('registerExperimentalBundles: only flagged-on bundles register; no-flag bundles always do', async () => {
  await registerExperimentalBundles((f) => f === 'rx-on', [
    { feature: 'rx-on', name: 'rx-on-bundle', load: async () => [tool('rx_on_tool')] },
    { feature: 'rx-off', name: 'rx-off-bundle', load: async () => [tool('rx_off_tool')] },
    { name: 'rx-always-bundle', load: async () => [tool('rx_always_tool')] },
  ]);
  assert.ok(isBundleRegistered('rx-on-bundle'));
  assert.ok(isBundleRegistered('rx-always-bundle'));
  assert.ok(!isBundleRegistered('rx-off-bundle'));
  assert.ok(!getRegisteredTools().some((t) => t.name === 'rx_off_tool'));
});

test('registerExperimentalBundles: a disabled bundle is never even loaded', async () => {
  let loaded = false;
  await registerExperimentalBundles(() => false, [
    { feature: 'rx-never', name: 'rx-never-bundle', load: async () => { loaded = true; return []; } },
  ]);
  assert.equal(loaded, false);
});

test('registerExperimentalBundles: registration order follows the spec order, not load-resolution order', async () => {
  await registerExperimentalBundles(() => true, [
    { name: 'rx-slow', load: async () => { await delay(30); return [tool('rx_order_1')]; } },
    { name: 'rx-fast', load: async () => [tool('rx_order_2')] },
  ]);
  const names = getRegisteredTools().map((t) => t.name).filter((n) => n.startsWith('rx_order_'));
  assert.deepEqual(names, ['rx_order_1', 'rx_order_2']);
});
