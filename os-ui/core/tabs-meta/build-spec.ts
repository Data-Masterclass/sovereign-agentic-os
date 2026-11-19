/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Software build spec loader — read the canonical Software build spec from disk
 * USER STORY: As an agent building software in the OS I want the same build spec in the team
 *             executor's preamble and in the MCP guide so that every builder follows one set of rules.
 * ARCHITECTURE:
 *   - Server-only. Reads `tabs/software/build-spec/software.md` once and caches it; a missing file
 *     returns '' and the callers still work.
 *   - Consumers: `tabs/agents/lib/build/agentic-graph-server.ts` (preamble) and
 *     `tabs/admin/mcp/resources.ts` (`sovereign-os://guide/build-spec/software`).
 *   - `software.build-spec.test.ts` checks that the file, this loader, the resource and the
 *     preamble carry identical content.
 */
import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = join(process.cwd(), 'tabs', 'software', 'build-spec', 'software.md');
let cached: string | null = null;

export function loadBuildSpec(): string {
  if (cached !== null) return cached;
  try {
    cached = readFileSync(FILE, 'utf8').trim();
  } catch {
    cached = '';
  }
  return cached;
}
