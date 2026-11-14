/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_WRITE_TOOLS } from '@core/mcp/write-tools';
import { WRITE_TOOL_TABS, WRITE_TOOL_NAMES } from '@core/mcp/write-tool-meta';

/**
 * The write tools that do NOT live in `ALL_WRITE_TOOLS`: the PLATFORM-MCP surface
 * (`tabs/software/lib/platform-mcp.ts`, registered as the `platform` experimental bundle) declares
 * its own `write: true` tools. The hold gate reads WRITE_TOOL_TABS, so a platform write missing
 * from it is NEVER held — which is exactly the gap the night-2 app-builder stream found for
 * `commit` (review H-1). They are listed LITERALLY here because a core test must not import a tab
 * (CORE-INDEPENDENCE); `tabs/agents/lib/builtin/appsmith.test.ts` asserts this literal still
 * matches the real `PLATFORM_MCP_TOOLS` write flags, so the two halves cannot drift silently.
 *
 * NIGHT-2 MERGE: `push_app_files` joined `commit` here. Stream S shipped it as a platform write
 * (it commits an app's source tree), and H's tripwire caught that it was unclassified — the same
 * unheld-write gap H-1 closed for `commit`. The shipped Software Delivery Team grants `commit` and
 * not `push_app_files`, so classifying it moved no golden.
 *
 * HONEST LIMIT, recorded rather than quietly fixed: the REST of the platform write surface
 * (`create_software`, `request_deploy`, `start_preview`, `promote`, `archive`, `delete`, …) is
 * still absent from WRITE_TOOL_TABS and therefore still unheld. Adding them changes the governance
 * posture of the shipped Software Delivery Team and the frozen engine goldens, so it belongs to the
 * software stream, not to a one-line fix here.
 */
const PLATFORM_WRITE_TOOLS: Readonly<Record<string, string>> = { commit: 'software', push_app_files: 'software' };

test('WRITE_TOOL_TABS matches ALL_WRITE_TOOLS plus the platform-MCP writes (names and tabs)', () => {
  const actual = { ...Object.fromEntries(ALL_WRITE_TOOLS.map((t) => [t.name, t.tab])), ...PLATFORM_WRITE_TOOLS };
  assert.deepEqual(WRITE_TOOL_TABS, actual);
  assert.equal(
    WRITE_TOOL_NAMES.size,
    ALL_WRITE_TOOLS.length + Object.keys(PLATFORM_WRITE_TOOLS).length,
    'duplicate write tool names',
  );
});

test('every platform-MCP write listed here is actually held-eligible', () => {
  for (const [name, tab] of Object.entries(PLATFORM_WRITE_TOOLS)) {
    assert.equal(WRITE_TOOL_TABS[name], tab, `${name} must be in the hold-gate table`);
    assert.ok(WRITE_TOOL_NAMES.has(name));
  }
});
