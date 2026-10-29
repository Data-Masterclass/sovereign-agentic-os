/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE CANONICAL BUILD SPEC (Software). One source of truth with two byte-synced
 * consumers: it is injected into the internal team executor's system preamble
 * (`agentic-graph-server.ts`) AND exposed over the MCP as the guide resource
 * `sovereign-os://guide/build-spec/software` (referenced from the
 * `build_and_ship_software` prompt). The repo-root canonical copy lives at
 * `docs/build-spec/software.md`; `software.build-spec.test.ts` asserts the disk
 * mirror, this loader, the resource and the preamble carry identical content.
 *
 * Read once + cached; a missing file degrades to '' (the surface still works).
 */
const FILE = join(process.cwd(), 'lib', 'tabs', 'build-spec', 'software.md');
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
