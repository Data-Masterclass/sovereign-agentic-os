/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Resume after a decision — the approver authorises, the RUNNER executes
 * USER STORY: As a domain admin I approve a held write in Governance and the parked run continues on
 *             its own; the write executes as the person who started the run, never as me — and if
 *             that person was deactivated or lost the role since, the run does NOT resume and the
 *             approval says why.
 * ARCHITECTURE:
 *   - `resumeAfterDecision(approval, decision, deps)` is the pure orchestration: (1) the approval
 *     must carry a thread (`runId`, `systemId`, `runner`); (2) the runner is RE-READ LIVE
 *     (`deps.loadPrincipal`) — missing/disabled → `runner_unavailable`; (3) the live role must
 *     still permit the tool (`deps.toolPermitted`) — else `runner_role_insufficient`; (4) the run
 *     continues through `deps.resumeRun` — A4: that FILES a `resume` job (`run_jobs`) which the
 *     worker, or this process under `AGENTS_WORKER=inline`, executes with
 *     `Command({ resume: { [approvalId]: decision } })` under the live principal. Every outcome is stamped on the approval (`deps.markResume`) and
 *     returned typed. Nothing here throws into `decide()`.
 *   - Registered as a `core/policy/approvals.ts` `onDecided` handler by `resume-boot.ts` (server
 *     wiring) — `core` never imports this tab. Tests inject fakes for all four deps.
 */
import type { Approval, ApprovalResume } from '@core/policy/approvals';
import type { Role } from '@core/kernel/session';
import type { ApprovalDecision } from '@tabs/agents/lib/engine/approval-port';

/** A live principal as the auth facade returns it. */
export type LivePrincipal = { id: string; name: string; role: Role; domains: string[] };

export type ResumeOutcome =
  | { status: 'done'; approvalId: string; runId: string; parked: boolean; reachedEnd: boolean; queued?: boolean }
  | { status: 'refused'; approvalId: string; runId?: string; code: 'not_a_run_approval' | 'runner_unavailable' | 'runner_role_insufficient' | 'runner_domain_lost'; reason: string }
  | { status: 'failed'; approvalId: string; runId: string; code: string; reason: string };

export type ResumeDeps = {
  /** Live user lookup — `null` when missing or disabled. */
  loadPrincipal: (userId: string) => Promise<LivePrincipal | null>;
  /** Does this role still clear the tool's role floor? */
  toolPermitted: (role: Role, tool: string) => boolean;
  /** Continue the thread as the live runner with the decision; returns what the run did. */
  resumeRun: (input: { runner: LivePrincipal; approval: Approval; decision: ApprovalDecision }) => Promise<{ parked: boolean; reachedEnd: boolean; queued?: boolean }>;
  /** Stamp the outcome on the approval record. */
  markResume: (approvalId: string, resume: ApprovalResume) => void;
  now?: () => string;
};

function refuse(deps: ResumeDeps, a: Approval, code: Exclude<ResumeOutcome, { status: 'done' | 'failed' }>['code'], reason: string): ResumeOutcome {
  deps.markResume(a.id, { status: 'refused', at: (deps.now ?? (() => new Date().toISOString()))(), error: { code, reason } });
  return { status: 'refused', approvalId: a.id, runId: a.runId, code, reason };
}

/** The post-decision hook body. Never throws. */
export async function resumeAfterDecision(a: Approval, decision: ApprovalDecision, deps: ResumeDeps): Promise<ResumeOutcome> {
  const now = deps.now ?? (() => new Date().toISOString());
  if (!a.runId || !a.systemId || !a.runner) {
    return refuse(deps, a, 'not_a_run_approval', 'this approval does not carry a parked run');
  }
  // The runner's role is re-read LIVE — the snapshot on the record is what WAS true, not authority.
  const live = await deps.loadPrincipal(a.runner.id);
  if (!live) {
    return refuse(deps, a, 'runner_unavailable', `the runner '${a.runner.id}' no longer exists or is disabled — the run cannot execute as them`);
  }
  if (!deps.toolPermitted(live.role, a.tool)) {
    return refuse(deps, a, 'runner_role_insufficient', `the runner '${live.id}' (now ${live.role}) no longer clears the role floor of ${a.tool}`);
  }
  if (a.domain && !live.domains.includes(a.domain)) {
    return refuse(deps, a, 'runner_domain_lost', `the runner '${live.id}' is no longer a member of domain '${a.domain}'`);
  }
  deps.markResume(a.id, { status: 'started', at: now() });
  try {
    const out = await deps.resumeRun({ runner: live, approval: a, decision });
    // L-F: a run that parked again on another held call is not "done" — say so on the card.
    // A4: in worker mode the resume is only FILED here; the card says `queued`, not `done`.
    deps.markResume(a.id, { status: out.queued ? 'queued' : out.parked ? 'parked' : 'done', at: now() });
    return { status: 'done', approvalId: a.id, runId: a.runId, parked: out.parked, reachedEnd: out.reachedEnd, queued: out.queued };
  } catch (e) {
    const err = e as Error & { name?: string };
    const code = err?.name && err.name !== 'Error' ? err.name : 'resume_failed';
    deps.markResume(a.id, { status: 'failed', at: now(), error: { code, reason: err?.message ?? String(e) } });
    return { status: 'failed', approvalId: a.id, runId: a.runId, code, reason: err?.message ?? String(e) };
  }
}
