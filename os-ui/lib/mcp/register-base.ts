/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import { registerToolBundle } from './registry';
import { MONITORING_TOOLS } from './monitoring-tools';
import { agentWriteTools } from './agent-write-tools';
import { MANUAL_TOOLS } from './manual-tools';
import { governanceBaseTools } from './governance-tools';

/**
 * Base bundles — always on, no flag. server.ts imports this for its side
 * effect (runs before ALL_MCP_TOOLS is built).
 *
 * manual-tools.ts and governance's get_lineage had a static experimental
 * import for a base tool — now a dynamic import at the call site instead
 * (still always on, just not bundled statically).
 *
 * Still pending: discovery's base-tab tools (e.g. get_agent_system).
 */
registerToolBundle({ name: 'monitoring', tools: MONITORING_TOOLS });
registerToolBundle({ name: 'agent-write', tools: agentWriteTools });
registerToolBundle({ name: 'manual', tools: MANUAL_TOOLS });
registerToolBundle({ name: 'governance', tools: governanceBaseTools });
