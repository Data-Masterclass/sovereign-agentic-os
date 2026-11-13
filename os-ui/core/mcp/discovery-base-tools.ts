/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import type { McpTool } from '@core/mcp/server';
import { P, fail, str } from '@core/mcp/write-common';
import { getSystem, getSystemForRun } from '@tabs/agents/lib/store';
import { getApproval } from '@core/policy/approvals';
import { whoCanApprove } from '@core/mcp/pending';
import { loadGuide, isGuidePath, GUIDE_PATHS, type GuidePath } from '@core/tabs-meta/guides';

/**
 * The 2 discovery tools whose own tab is base (agents / meta) — everything
 * else in the old discovery-*.ts family is non-base and stays where it is
 * for now. Self-contained (not importing discovery-common.ts), since that
 * file's resolveQueryable pulls in @/lib/experimental/data for the OTHER,
 * non-base discovery tools — importing it here would drag that into base.
 */
export const discoveryBaseTools: McpTool[] = [
  {
    name: 'get_agent_run',
    tab: 'agents',
    minRole: 'creator',
    description:
      'READ the state of one agent run (LangGraph engine) by its runId: the agents visited so far, whether it finished, is PARKED on held writes awaiting approval (with their approvalIds and who can decide), or was interrupted; the budget used; compile warnings. Purpose: follow a run started by run_agent_system (or the UI) through hold → approve → completion over MCP alone. Governance: only the RUNNER of the run (the user who started it) can read it; any other runId is a typed not_found — a run id is a capability, not an index.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'The run id returned by run_agent_system (run_<uuid>).' } },
      required: ['runId'],
      examples: [{ runId: 'run_1b4e28ba-2fa1-11d2-883f-0016d3cca427' }],
    },
    call: async (user, args) => {
      const runId = str(args.runId).trim();
      if (!runId) fail('get_agent_run needs a `runId`', 400);
      const { peekRunOwner, inspectOsRun } = await import('@tabs/agents/lib/build/agentic-graph-server');
      const owner = await peekRunOwner(runId);
      if (!owner || owner.userId !== user.id) fail('Run not found', 404); // no existence leak
      const view = getSystemForRun(owner.systemId, P(user));
      const run = await inspectOsRun({ user, yaml: view.yaml, systemId: owner.systemId, runId });
      if (!run.exists) fail('Run not found', 404);
      const heldApprovals = run.heldApprovals.map((h) => {
        const a = getApproval(h.approvalId);
        return { ...h, status: a?.status ?? 'unknown', whoCanApprove: a ? whoCanApprove(a) : undefined, approverRole: a?.approverRole };
      });
      return {
        runId,
        systemId: owner.systemId,
        engine: 'langgraph',
        finished: run.finished,
        parked: run.parked,
        heldApprovals,
        next: run.next,
        path: run.path,
        finalText: run.finalText,
        budget: run.budget,
        decidedHolds: run.held,
        warnings: run.warnings,
        lastRun: view.lastRun?.runId === runId ? { at: view.lastRun.at, ok: view.lastRun.ok, reachedEnd: view.lastRun.reachedEnd, interrupted: view.lastRun.interrupted } : undefined,
      };
    },
  },
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
