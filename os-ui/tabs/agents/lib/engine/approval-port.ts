/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    ApprovalPort — what the pure graph needs from the Governance queue, and a memory fake
 * USER STORY: As the engine's `tools_<id>` node I need to park a held write as ONE approval (however
 *             often LangGraph re-runs me) and to read its decision back — through a port, so the
 *             graph builder stays free of `server-only` and the P3 tests run with a fake queue.
 * ARCHITECTURE:
 *   - `ApprovalPort.enqueueOnce` is idempotent on `interruptKey` (`<threadId>:<callId>`); `status`
 *     reads the decision. The server implementation (`approvals-bridge.ts`) wraps
 *     `core/policy/approvals.ts`; `memoryApprovalPort()` is the in-process fake tests decide
 *     against (`decide(id, …)`), which also records every call for assertions.
 */
import type { Role } from '@core/kernel/session';

export type ApprovalDecision = 'approve' | 'reject';
export type ApprovalState = 'pending' | ApprovalDecision | 'unknown';

/** The runner's principal snapshot stored on the approval (the approver authorises, the runner executes). */
export type RunnerSnapshot = { id: string; role: Role; domains: string[] };

/** Who/what a run belongs to — stamped into the thread's state on its first superstep (A2, review H1). */
export type RunOwner = { systemId: string; userId: string; domain: string };

export type HeldApprovalInput = {
  interruptKey: string;
  runId: string;
  threadId: string;
  systemId: string;
  node: string;
  tool: string;
  args: Record<string, unknown>;
  approverRole: 'domain_admin' | 'admin';
  domain: string;
  runner: RunnerSnapshot;
  /** The system principal (`os-<systemId>`) for attribution. */
  agent: string;
};

export type ApprovalPort = {
  /** Enqueue once per `interruptKey`; returns the (possibly pre-existing) approval id and its state. */
  enqueueOnce(input: HeldApprovalInput): Promise<{ approvalId: string; status: ApprovalState }>;
  /** The current decision state of an approval. */
  status(approvalId: string): Promise<ApprovalState>;
};

export type MemoryApproval = HeldApprovalInput & { approvalId: string; status: ApprovalState; decidedBy?: string };

export type MemoryApprovalPort = ApprovalPort & {
  /** Every approval, by id. */
  all(): MemoryApproval[];
  /** Decide one — returns the record once, `null` on a repeat (mirrors `core/policy/approvals.ts` `decide`). */
  decide(approvalId: string, decision: ApprovalDecision, by: string): MemoryApproval | null;
  /** How many times `enqueueOnce` was called (idempotency is asserted against this). */
  enqueueCalls: number;
};

/** An in-memory port for tests: the same idempotency + decision semantics as the real queue. */
export function memoryApprovalPort(): MemoryApprovalPort {
  const byKey = new Map<string, MemoryApproval>();
  const byId = new Map<string, MemoryApproval>();
  let n = 0;
  const port: MemoryApprovalPort = {
    enqueueCalls: 0,
    async enqueueOnce(input) {
      port.enqueueCalls += 1;
      const existing = byKey.get(input.interruptKey);
      if (existing) return { approvalId: existing.approvalId, status: existing.status };
      n += 1;
      const rec: MemoryApproval = { ...input, approvalId: `apr_test_${n}`, status: 'pending' };
      byKey.set(input.interruptKey, rec);
      byId.set(rec.approvalId, rec);
      return { approvalId: rec.approvalId, status: 'pending' };
    },
    async status(approvalId) {
      return byId.get(approvalId)?.status ?? 'unknown';
    },
    all: () => [...byId.values()],
    decide(approvalId, decision, by) {
      const rec = byId.get(approvalId);
      if (!rec || rec.status !== 'pending') return null;
      rec.status = decision;
      rec.decidedBy = by;
      return rec;
    },
  };
  return port;
}
