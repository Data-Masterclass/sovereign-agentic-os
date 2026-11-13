/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Inventory gate — no shipped system grants an unmapped legacy tool
 * USER STORY: As the engine-rebuild engineer I want CI to refuse a shipped template or seeded
 *             demo system whose tool grants do not resolve to the MCP registry, because Phase A1
 *             makes "unmapped legacy tool" a compile error and a shipped system must never be the
 *             thing that fails.
 * ARCHITECTURE:
 *   - Runs `resolveGrantedTools` (alias map + live registry) over every fixture spec's yaml and
 *     each agent's narrowed `tools`; asserts `unmapped` is empty.
 *   - The seeded demo systems (`seed/<demo>/narrative.mjs`) are plain data files outside os-ui, so
 *     their `grantTools: [...]` literals are read as text and resolved the same way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALL_MCP_TOOLS } from '@core/mcp/server';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { resolveAlias, resolveGrantedTools } from '@tabs/agents/lib/build/os-tools';
import { fixtureSpecs } from '@tabs/agents/lib/engine/parity-harness';

const REGISTRY = new Set(ALL_MCP_TOOLS.map((t) => t.name));

test('every shipped system.yaml template resolves entirely to MCP-registered tools (A1 compile rule)', () => {
  for (const spec of fixtureSpecs()) {
    const sys = parseSystem(spec.yaml);
    const { unmapped } = resolveGrantedTools(sys);
    assert.deepEqual(unmapped, [], `${spec.name}: grants.tools has unmapped legacy tools`);
    for (const a of sys.agents) {
      const bad = (a.tools ?? []).filter((t) => !REGISTRY.has(resolveAlias(t)));
      assert.deepEqual(bad, [], `${spec.name}/${a.id}: agent tools not in the MCP registry`);
    }
  }
});

test('seeded demo systems (seed/) grant only MCP-registered tools', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const files = ['seed/campaign/narrative.mjs', 'seed/ecommerce/lib/narrative.mjs'];
  let seen = 0;
  for (const rel of files) {
    const text = readFileSync(`${root}${rel}`, 'utf8');
    for (const m of text.matchAll(/grantTools:\s*\[([^\]]*)\]/g)) {
      const names = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
      seen += names.length;
      const bad = names.filter((n) => !REGISTRY.has(resolveAlias(n)));
      assert.deepEqual(bad, [], `${rel}: grantTools [${names.join(', ')}] has unmapped legacy tools`);
    }
  }
  assert.ok(seen > 0, 'the seed narratives still declare grantTools (regex found none)');
});
