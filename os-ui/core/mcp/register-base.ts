/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import { registerToolBundle } from '@core/mcp/registry';
import { MONITORING_TOOLS } from '@core/mcp/monitoring-tools';
import { agentWriteTools } from '@core/mcp/agent-write-tools';
import { MANUAL_TOOLS } from '@core/mcp/manual-tools';
import { governanceBaseTools } from '@core/mcp/governance-tools';
import { discoveryBaseTools } from '@core/mcp/discovery-base-tools';
import { GIT_TOOLS } from '@core/mcp/git-tools';
import { lifecycleTools } from '@core/mcp/lifecycle-tools';

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
registerToolBundle({ name: 'discovery', tools: discoveryBaseTools });
// Night 2 (stream G): the generic git reads — get_history / get_version / diff_versions over
// `{kind, id}`, reaching the same `core/infra/git-objects.ts` the UI's history drawer calls.
registerToolBundle({ name: 'git', tools: GIT_TOOLS });
// Lifecycle (night 2, stream V): go_live + retire. Always on — "which version runs" is not a
// feature flag, and the migration marks every existing object Live so day one is unchanged.
registerToolBundle({ name: 'lifecycle', tools: lifecycleTools });
