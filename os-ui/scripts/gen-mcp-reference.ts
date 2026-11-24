/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Regenerate docs/mcp/tool-reference.md from the MCP tool registry.
 * USER STORY: As a maintainer who changed a tool, I want one command that rewrites the tool
 *             reference, so the doc and the registry never disagree.
 * ARCHITECTURE:
 *   - Renders with `core/mcp/reference.ts` over `ALL_MCP_TOOLS` (full install: test-setup enables
 *     every tab). Writes the file; `--check` exits 1 when the committed file is stale instead.
 *
 *   cd os-ui && node --import ./scripts/test-setup.mjs scripts/gen-mcp-reference.ts [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_MCP_TOOLS } from '@core/mcp/server';
import { toolsetOf } from '@core/mcp/fast-surface';
import { renderToolReference } from '@core/mcp/reference';

const OUT = join(process.cwd(), '..', 'docs', 'mcp', 'tool-reference.md');
const text = renderToolReference(ALL_MCP_TOOLS, toolsetOf as never);
if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(OUT, 'utf8'); } catch { /* missing = stale */ }
  if (current !== text) {
    console.error(`${OUT} is stale — run without --check to regenerate.`);
    process.exit(1);
  }
  console.log('tool reference is up to date');
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT} (${ALL_MCP_TOOLS.length} tools)`);
}
process.exit(0);
