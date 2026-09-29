/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import type { McpTool } from './server';
import { P, fail, str } from './write-common';
import { getSystem } from '@/lib/agents/store';
import { loadGuide, isGuidePath, GUIDE_PATHS, type GuidePath } from '@/lib/tabs/guides';

/**
 * The 2 discovery tools whose own tab is base (agents / meta) — everything
 * else in the old discovery-*.ts family is non-base and stays where it is
 * for now. Self-contained (not importing discovery-common.ts), since that
 * file's resolveQueryable pulls in @/lib/experimental/data for the OTHER,
 * non-base discovery tools — importing it here would drag that into base.
 */
export const discoveryBaseTools: McpTool[] = [
  {
    name: 'get_agent_system',
    tab: 'agents',
    minRole: 'creator',
    description:
      'Read one agent system (also called: AI team, assistant team) you can see — system.yaml, agents, grants, status. Path: DISCOVERY for the Agents golden path (guide: sovereign-os://guide/path/agents). Before: list_agent_systems. After: commit_agent_files / build_agent_system. Governance: read-only; unseeable id → not_found.',
    inputSchema: {
      type: 'object',
      properties: { systemId: { type: 'string', description: 'System id from list_agent_systems.' } },
      required: ['systemId'],
      examples: [{ systemId: 'sys_ab12cd34' }],
    },
    call: async (user, args) => {
      const id = str(args.systemId).trim();
      if (!id) fail('get_agent_system needs a `systemId`', 400);
      return getSystem(id, P(user));
    },
  },
  {
    name: 'get_guide',
    tab: 'meta',
    minRole: 'creator',
    description:
      `Read a golden-path GUIDE (the same markdown as the sovereign-os://guide/* resources) so tools-only clients get the full pathway. Call with NO argument (or path="how-to-use") for a "How to use this MCP" orientation: what the OS is, your first 3 moves, the role summary, all pathway names, and the build-on-what-exists rule. Valid paths: ${GUIDE_PATHS.join(', ')}. Governance: read-only, identical for every role.`,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', enum: [...GUIDE_PATHS], description: 'Which guide to read. Omit (or pass "how-to-use") for the "How to use this MCP" orientation.' } },
      required: [],
      examples: [{}, { path: 'how-to-use' }, { path: 'overview' }, { path: 'data' }],
    },
    call: async (_user, args) => {
      const raw = str(args.path).trim();
      const path: GuidePath = isGuidePath(raw) ? raw : 'how-to-use';
      const text = loadGuide(path);
      if (!text) fail(`Guide not found: ${path}`, 404);
      return text;
    },
  },
];
