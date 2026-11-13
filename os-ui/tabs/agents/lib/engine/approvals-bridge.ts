/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The server ApprovalPort — the engine's hold port over the real Governance queue
 * USER STORY: As the running graph I want my held writes to land in the SAME inbox every other held
 *             action lands in, carrying the thread they parked, so a decider sees one queue and the
 *             decision can find its run.
 * ARCHITECTURE:
 *   - Thin adapter from `ApprovalPort` (pure, `approval-port.ts`) to `core/policy/approvals.ts`
 *     (`enqueueOnce`, `getApproval`). Kind `connection_write` (the agent write-back kind); `source`
 *     'Agents'; a bounded `args` copy; the runner snapshot; `runId`/`threadId`/`interruptKey`/
 *     `systemId`/`node`. `server-only` — never imported by the builder.
 *   - HYDRATION FIRST (A2 review M-A): both methods `await ensureHydrated()` before touching the queue.
 *     After a pod restart the in-process Map is empty until something hydrates it from the durable
 *     mirror; without this, a resume before anyone opened the Inbox would read `status → 'unknown'`
 *     and file a SECOND approval under the same interruptKey, orphaning the decided one.
 */
import 'server-only';
import { ensureHydrated, enqueueOnce, getApproval, type ApprovalStatus } from '@core/policy/approvals';
import type { ApprovalPort, ApprovalState, HeldApprovalInput } from '@tabs/agents/lib/engine/approval-port';
import { writeTargetScope } from '@tabs/agents/lib/build/hold';

/** Upper bound (chars) on the serialised tool arguments stored on an approval card. */
const ARGS_MAX = 4_000;

function boundedArgs(args: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(args ?? {});
  if (text.length <= ARGS_MAX) return args;
  return { _truncated: true, preview: `${text.slice(0, ARGS_MAX)}…` };
}

function toState(status: ApprovalStatus): ApprovalState {
  return status === 'approved' ? 'approve' : status === 'rejected' ? 'reject' : 'pending';
}

/** The production port: every held call is one record in the Governance inbox. */
export function serverApprovalPort(): ApprovalPort {
  return {
    async enqueueOnce(input: HeldApprovalInput) {
      await ensureHydrated();
      const { approval } = enqueueOnce({
        kind: 'connection_write',
        title: `Approval needed: ${input.tool}`,
        detail: `Agent '${input.node}' of system '${input.systemId}' asked to run the ${writeTargetScope(input.tool)}-scope write '${input.tool}'. The run is parked until you decide; approving resumes it and the write executes as the runner (${input.runner.id}).`,
        agent: input.agent,
        domain: input.domain,
        requestedBy: input.runner.id,
        tool: input.tool,
        approverRole: input.approverRole,
        source: 'Agents',
        preview: {
          what: `${input.tool} ${JSON.stringify(boundedArgs(input.args)).slice(0, 240)}`,
          who: `agent ${input.node} · run ${input.runId} · as ${input.runner.id}`,
          why: `${writeTargetScope(input.tool)}-scope write held by the system's safety preset`,
          impact: 'Approve → the parked run resumes and executes this call as its runner. Deny → the agent receives a typed rejection and continues.',
        },
        runId: input.runId,
        threadId: input.threadId,
        interruptKey: input.interruptKey,
        systemId: input.systemId,
        node: input.node,
        runner: input.runner,
        args: boundedArgs(input.args),
      });
      return { approvalId: approval.id, status: toState(approval.status) };
    },
    async status(approvalId: string) {
      await ensureHydrated();
      const a = getApproval(approvalId);
      return a ? toState(a.status) : 'unknown';
    },
  };
}
