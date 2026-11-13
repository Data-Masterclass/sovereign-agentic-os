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
      'READ the state of one agent run by its runId: the agents visited so far, whether it finished, is PARKED on held writes awaiting approval (with their approvalIds and who can decide), or was interrupted; the budget used; compile warnings; AND the tail of the run\'s event log (node-started / tool-step / node-completed / approval-required / resumed / done / error) — pass `afterSeq` (the `nextSeq` from your last call) to get only what happened since, so following a long run is a cheap poll rather than a re-read. Purpose: follow a run started by run_agent_system (or the UI) through hold → approve → completion over MCP alone. Before: run_agent_system (take its runId). After: decide_approval if parked, resume_agent_run after a restart, get_run_trace(runId) for the Langfuse trace. Governance: only the RUNNER of the run (the user who started it) can read it, and only on their own system; any other runId is a typed not_found — a run id is a capability, not an index.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'The run id returned by run_agent_system (run_<uuid>).' },
        afterSeq: { type: 'number', description: 'Return only events with seq > this (the `nextSeq` of your last call). Omit for the whole log.' },
        limit: { type: 'number', description: 'Max events to return (default 50, capped 200).' },
      },
      required: ['runId'],
      examples: [{ runId: 'run_1b4e28ba-2fa1-11d2-883f-0016d3cca427' }, { runId: 'run_1b4e28ba-2fa1-11d2-883f-0016d3cca427', afterSeq: 12 }],
    },
    call: async (user, args) => {
      const runId = str(args.runId).trim();
      if (!runId) fail('get_agent_run needs a `runId`', 400);
      const { assertRunVisible } = await import('@tabs/agents/lib/engine/run-visibility');
      const { peekRunOwner, inspectOsRun } = await import('@tabs/agents/lib/build/agentic-graph-server');
      // OWNER GATE FIRST, from the checkpoint's own owner stamp — the cheapest read there is, and
      // nothing else happens until it passes. Unknown and foreign are the same answer (404), so a
      // run id cannot be probed for existence.
      const owner = await peekRunOwner(runId);
      const seen = assertRunVisible(owner ? { requestedBy: owner.userId, systemId: owner.systemId } : null, runId, user.id);
      const view = getSystemForRun(seen.systemId, P(user));
      const run = await inspectOsRun({ user, yaml: view.yaml, systemId: seen.systemId, runId });
      if (!run.exists) fail('Run not found', 404);
      const heldApprovals = run.heldApprovals.map((h) => {
        const a = getApproval(h.approvalId);
        return { ...h, status: a?.status ?? 'unknown', whoCanApprove: a ? whoCanApprove(a) : undefined, approverRole: a?.approverRole };
      });
      // A5: the EVENT TAIL — the same `run_events` log the UI's SSE stream replays, from the same
      // store, so an MCP client follows a run exactly as the panel does instead of re-reading the
      // whole state. `afterSeq` makes that a cheap poll. The job row is re-checked against the
      // owner here too (defence in depth, as `resume_agent_run` does).
      const afterSeq = typeof args.afterSeq === 'number' && args.afterSeq > 0 ? Math.floor(args.afterSeq) : 0;
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 200) : 50;
      let events: { seq: number; event: string; at: number; data: unknown }[] = [];
      let jobStatus: string | undefined;
      let eventsAvailable = true;
      try {
        const { runJobStore } = await import('@tabs/agents/lib/build/run-jobs-server');
        const store = await runJobStore();
        const job = await store.get(runId);
        if (job) {
          assertRunVisible(job, runId, user.id, seen.systemId);
          jobStatus = job.status;
        }
        events = (await store.eventsAfter(runId, afterSeq, limit)).map((e) => ({ seq: e.seq, event: e.event, at: e.at, data: e.data }));
      } catch (e) {
        // A foreign/unknown ROW is still a 404 — never degraded into a successful read.
        if ((e as { status?: number })?.status === 404) throw e;
        // The event log is an ENRICHMENT of this read (the state above comes from the
        // checkpointer). An unreachable store says so rather than pretending the run was silent.
        eventsAvailable = false;
      }
            const { traceUrlFor, langfuseEnabled } = await import('@core/infra/langfuse');
      return {
        runId,
        systemId: seen.systemId,
        engine: 'langgraph',
        // A3: the run's Langfuse trace (id = run id) — a deep link, never a list.
        traceUrl: langfuseEnabled() ? traceUrlFor(runId) : undefined,
        status: jobStatus,
        finished: run.finished,
        parked: run.parked,
        heldApprovals,
        next: run.next,
        path: run.path,
        finalText: run.finalText,
        budget: run.budget,
        decidedHolds: run.held,
        warnings: run.warnings,
        events,
        /** False when the run-event store was unreachable — the state above is still the run's. */
        eventsAvailable,
        /** Pass this back as `afterSeq` to get only what happens next. */
        nextSeq: events.at(-1)?.seq ?? afterSeq,
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
