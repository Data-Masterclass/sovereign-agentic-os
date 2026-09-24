/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import { registerToolBundle } from './registry';
import { MONITORING_TOOLS } from './monitoring-tools';
import { agentWriteTools } from './agent-write-tools';

/**
 * BASE bundle registration — always-on tools that ship in every build, no
 * feature flag, no dynamic import. server.ts imports this module for its
 * side effect (registration happens at module-eval time, before
 * `ALL_MCP_TOOLS` is assembled).
 *
 * `monitoring` and `agent-write`  are registered here.
 * Still pending: manual tools/governance/discovery/model-gateway passthrough
 * resources, which have genuine (non-dead) non-base dependencies and need a
 * per-tool/per-call-site split, not a file-level move.
 */
registerToolBundle({ name: 'monitoring', tools: MONITORING_TOOLS });
registerToolBundle({ name: 'agent-write', tools: agentWriteTools });
