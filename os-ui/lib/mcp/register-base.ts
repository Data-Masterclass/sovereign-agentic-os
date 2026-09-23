/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import { registerToolBundle } from './registry';
import { MONITORING_TOOLS } from './monitoring-tools';

/**
 * BASE bundle registration — always-on tools that ship in every build, no
 * feature flag, no dynamic import. server.ts imports this module for its
 * side effect (registration happens at module-eval time, before
 * `ALL_MCP_TOOLS` is assembled).
 *
 * Only `monitoring` is registered here so far (Phase 3.3 step 1 — proving the
 * registry mechanics before extracting the entangled base-candidate files:
 * manual/governance/discovery/resources/agent-write, each of which still has
 * live `@/lib/experimental/*` imports and needs a per-tool/per-call-site
 * split, not a file-level move).
 */
registerToolBundle({ name: 'monitoring', tools: MONITORING_TOOLS });
