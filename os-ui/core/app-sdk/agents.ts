/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `os.agents.*` — a governed app calls an OS agent through the SAME door as the user
 * USER STORY: As a vibe-engineered app I want to start an OS agent system, watch its run and (only
 *             where my viewer's own role permits) decide the approval that is holding it — acting
 *             AS THE SIGNED-IN USER over the ambient session, never under a service principal and
 *             never with a key of my own (night-2 S7, decision D21).
 * ARCHITECTURE:
 *   - THE SAME DOORS THE OS UI USES, by construction. There is no app-specific run endpoint and no
 *     token exchange: `run` POSTs the agents tab's own run route (which mints the run id, gates the
 *     caller with `getSystemForRun` and files the job through `enqueueRun`), `get` tails that run's
 *     durable `run_events` through the same stream route the Run panel attaches to, and `decide`
 *     POSTs the one unified Governance inbox route. The app therefore cannot reach anything the
 *     signed-in user could not reach in the UI, and every gate is the UI's gate.
 *   - PURE + TESTABLE: the route builders, the response normaliser and the event reducer are plain
 *     functions with no I/O, so "the app's view of a run" is unit-tested without a cluster. The
 *     client only adds `fetch`.
 *   - HONEST STATES: a run that parks on a held write is `parked` WITH its approval id — the app
 *     renders that state instead of pretending the run finished. A 202 "still executing" is
 *     `running` + `pending`, never a fabricated answer.
 *   - Vendored into every governed app as SOURCE (`app-sdk-vendor.ts`), so it must stay
 *     dependency-free and relative-import only.
 */
import type { AgentRun, AgentRunEvent, AgentDecisionResult } from './types';

/** The run door: mints the run id, gates the caller, files the job through `enqueueRun`. */
export function agentRunPath(systemId: string): string {
  return `/api/agents/systems/${encodeURIComponent(systemId)}/run`;
}

/** The run read door: the durable `run_events` tail the OS Run panel itself attaches to. */
export function agentRunStreamPath(systemId: string, runId: string, afterSeq = 0): string {
  return `${agentRunPath(systemId)}/stream?runId=${encodeURIComponent(runId)}&afterSeq=${Math.max(0, afterSeq)}`;
}

/** The ONE governance inbox door. A role that may not decide gets the UI's own 403. */
export const AGENT_DECIDE_PATH = '/api/governance/approvals';

/** Parse an `text/event-stream` body into `{event, data}` frames. Tolerant of partial input. */
export function parseRunEvents(text: string): AgentRunEvent[] {
  const out: AgentRunEvent[] = [];
  for (const block of String(text ?? '').split('\n\n')) {
    let event = '';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!event) continue;
    let data: unknown = undefined;
    if (dataLines.length > 0) {
      try {
        data = JSON.parse(dataLines.join('\n'));
      } catch {
        data = dataLines.join('\n');
      }
    }
    out.push({ event, data });
  }
  return out;
}

function approvalIdOf(data: unknown): string | undefined {
  const d = (data ?? {}) as Record<string, unknown>;
  for (const k of ['approvalId', 'approval_id', 'id']) {
    const v = d[k];
    if (typeof v === 'string' && v) return v;
  }
  const nested = d.approval as Record<string, unknown> | undefined;
  if (nested && typeof nested.id === 'string' && nested.id) return nested.id;
  return undefined;
}

/**
 * The state of a run from its event log. Pure. `approval-required` (or a terminal `done` that
 * says it parked) is `parked` WITH the approval id, so the app can show "waiting for <approver>"
 * instead of a half-finished answer.
 */
export function reduceRunEvents(systemId: string, runId: string, events: AgentRunEvent[]): AgentRun {
  let run: AgentRun = { systemId, runId, state: 'running', events: events.length };
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.event === 'approval-required') {
      run = { ...run, state: 'parked', approvalId: approvalIdOf(e.data) };
    } else if (e.event === 'resumed') {
      run = { ...run, state: 'running', approvalId: undefined };
    } else if (e.event === 'error') {
      run = { ...run, state: 'error', error: typeof d.error === 'string' ? d.error : 'the run failed' };
    } else if (e.event === 'done') {
      run = d.parked
        ? { ...run, state: 'parked', approvalId: approvalIdOf(e.data) ?? run.approvalId, output: e.data }
        : { ...run, state: 'done', output: e.data };
    }
  }
  return { ...run, events: events.length };
}

/**
 * The state of a run from the run route's own JSON answer. A 202 `{queued:true}` is `running`
 * + `pending` (the run outlived the request — re-read it with `os.agents.get`), a payload that
 * names an approval is `parked`, anything else is the finished report.
 */
export function normalizeAgentRun(systemId: string, raw: unknown, fallbackRunId = ''): AgentRun {
  const d = (raw ?? {}) as Record<string, unknown>;
  const runId = typeof d.runId === 'string' && d.runId ? d.runId : fallbackRunId;
  if (typeof d.error === 'string' && d.error) return { systemId, runId, state: 'error', error: d.error };
  if (d.queued === true) return { systemId, runId, state: 'running', pending: true, output: raw };
  const approvalId = d.parked || d.held || d.approvalRequired ? approvalIdOf(raw) : undefined;
  if (d.parked || d.held || d.approvalRequired) return { systemId, runId, state: 'parked', approvalId, output: raw };
  return { systemId, runId, state: 'done', output: raw };
}

/** The governance inbox's answer, named honestly. */
export function normalizeDecision(approvalId: string, raw: unknown): AgentDecisionResult {
  const d = (raw ?? {}) as Record<string, unknown>;
  const approval = (d.approval ?? {}) as Record<string, unknown>;
  const status = typeof approval.status === 'string' ? approval.status : typeof d.status === 'string' ? d.status : 'unknown';
  const decidedBy = typeof approval.decidedBy === 'string' ? approval.decidedBy : undefined;
  return { approvalId, status, decidedBy };
}
