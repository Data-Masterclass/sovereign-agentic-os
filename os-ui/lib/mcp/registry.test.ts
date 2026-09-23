/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import type { McpTool } from './server.ts';
import {
  registerToolBundle,
  getRegisteredTools,
  isBundleRegistered,
  hydrateAllBundles,
  type ToolBundle,
} from './registry.ts';

/**
 * REGISTRY MECHANICS (Phase 3.3 step 1) — proves registration/dedup/dispatch
 * round-trip BEFORE any entangled base-candidate file (manual/governance/
 * discovery/resources/agent-write) is extracted onto this mechanism. Flag-
 * gating + unknown-tool-path tests land once a real non-base bundle moves to
 * `lib/experimental/mcp/` and self-registers behind a feature check.
 *
 * Each test uses a UNIQUE bundle name — `registerToolBundle` is process-wide
 * + register-once, so reusing a name across tests would silently no-op.
 */

const user: CurrentUser = { id: 'u1', name: 'Test', domains: [], role: 'creator' };

function fakeTool(name: string, result: unknown): McpTool {
  return {
    name,
    description: `test tool ${name}`,
    minRole: 'creator',
    tab: 'meta',
    inputSchema: { type: 'object', properties: {} },
    call: async () => result,
  };
}

test('registerToolBundle: a registered bundle\'s tools appear in getRegisteredTools', () => {
  const before = getRegisteredTools().length;
  registerToolBundle({ name: 'rt-basic', tools: [fakeTool('rt_basic_tool', 'ok')] });
  const after = getRegisteredTools();
  assert.equal(after.length, before + 1);
  assert.ok(after.some((t) => t.name === 'rt_basic_tool'));
});

test('registerToolBundle: registering the same bundle name twice is a no-op (dedup)', () => {
  const bundle: ToolBundle = { name: 'rt-dedup', tools: [fakeTool('rt_dedup_tool', 'ok')] };
  registerToolBundle(bundle);
  const countAfterFirst = getRegisteredTools().filter((t) => t.name === 'rt_dedup_tool').length;
  // Same name, even with a DIFFERENT tools array, must be ignored — first registration wins.
  registerToolBundle({ name: 'rt-dedup', tools: [fakeTool('rt_dedup_tool', 'ok'), fakeTool('rt_dedup_extra', 'ok')] });
  const countAfterSecond = getRegisteredTools().filter((t) => t.name === 'rt_dedup_tool').length;
  assert.equal(countAfterFirst, 1);
  assert.equal(countAfterSecond, 1);
  assert.ok(!getRegisteredTools().some((t) => t.name === 'rt_dedup_extra'));
});

test('isBundleRegistered: true once registered, false for an unknown name', () => {
  registerToolBundle({ name: 'rt-flagcheck', tools: [fakeTool('rt_flagcheck_tool', 'ok')] });
  assert.equal(isBundleRegistered('rt-flagcheck'), true);
  assert.equal(isBundleRegistered('rt-never-registered'), false);
});

test('dispatch round-trip: a registered tool can be found by name and invoked, result matches', async () => {
  registerToolBundle({ name: 'rt-dispatch', tools: [fakeTool('rt_dispatch_tool', { hello: 'world' })] });
  const tool = getRegisteredTools().find((t) => t.name === 'rt_dispatch_tool');
  assert.ok(tool, 'registered tool must be retrievable by name');
  const result = await tool!.call(user, {});
  assert.deepEqual(result, { hello: 'world' });
});

test('hydrateAllBundles: calls every registered bundle\'s hydrate hook exactly once, skips bundles with none', async () => {
  let calls = 0;
  registerToolBundle({
    name: 'rt-hydrate-a',
    tools: [fakeTool('rt_hydrate_a_tool', 'ok')],
    hydrate: async () => {
      calls += 1;
    },
  });
  registerToolBundle({ name: 'rt-hydrate-b', tools: [fakeTool('rt_hydrate_b_tool', 'ok')] }); // no hydrate
  await hydrateAllBundles();
  assert.equal(calls, 1);
  // Re-running hydrateAllBundles calls every bundle's hydrate again (it is a
  // per-request warm-up, not a one-shot init) — registration itself is what's
  // idempotent, not hydration.
  await hydrateAllBundles();
  assert.equal(calls, 2);
});
