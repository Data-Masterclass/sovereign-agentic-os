/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The worker never puts back a stale copy of an approval decided in the web app
 * USER STORY: As a domain admin I reject (or approve) a request in Governance while an agent run
 *             in the worker pod still holds its boot-time copy of that request. The worker's
 *             bookkeeping (resume and effect stamps) never turns my decision back into "pending",
 *             and an agent calling `approve_promotion` on it is told it is already decided —
 *             it never applies a request I rejected.
 * ARCHITECTURE:
 *   - Two simulated processes over one fake OpenSearch, through the REAL approvals queue and the
 *     REAL `approve_promotion` tool (`core/infra/two-process-fixture.ts`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCluster, proc, as, type Proc } from '@core/infra/two-process-fixture';
import * as approvals from '@core/policy/approvals';

const KEYS = [Symbol.for('soa.approvals.queue')];
const INDEX = 'os-approvals';
const dora = { id: 'dora', name: 'Dora', domains: ['sales'], role: 'domain_admin' as const };

async function scenario() {
  const os = fakeCluster();
  approvals.__resetApprovals();
  const web = proc();
  const id = await as(web, KEYS, async () => {
    await approvals.ensureHydrated();
    return approvals.enqueue({
      kind: 'dataset_promote',
      title: 'Promote Orders',
      detail: 'bea asks to share Orders with sales',
      agent: 'bea',
      domain: 'sales',
      requestedBy: 'bea',
      tool: 'dataset_promote',
      payload: { datasetId: 'ds_1' },
      approverRole: 'domain_admin',
    }).id;
  });
  const worker = proc(true);
  await as(worker, KEYS, () => approvals.ensureHydrated()); // the worker boots: the request is pending
  return { os, web, worker, id };
}

async function restart(): Promise<Proc> {
  const fresh = proc();
  await as(fresh, KEYS, () => approvals.ensureHydrated());
  return fresh;
}

test("the worker's effect stamp never turns a decision made in os-ui back into pending", async () => {
  const { os, web, worker, id } = await scenario();
  try {
    await as(web, KEYS, () => approvals.decide(id, 'approve', 'dora'));
    await as(worker, KEYS, () => approvals.recordEffect(id, { applied: 'promoted', live: true }));

    assert.equal((os.doc(INDEX, id) as { status?: string } | undefined)?.status, 'approved');
    const rebooted = await restart();
    const back = await as(rebooted, KEYS, () => approvals.getApproval(id));
    assert.equal(back?.status, 'approved', 'the decision made in os-ui survives the worker stamp and a restart');
    assert.equal(back?.effect?.applied, 'promoted', "the worker's effect stamp is kept too");
  } finally {
    os.restore();
    approvals.__resetApprovals();
  }
});

test('approve_promotion in the worker reads the newest request: one rejected in os-ui is not applied', async () => {
  const { os, web, worker, id } = await scenario();
  try {
    await as(web, KEYS, () => approvals.decide(id, 'reject', 'dora'));
    const { promotionTools } = await import('@core/mcp/experimental/promotion-write-tools');
    const tool = promotionTools.find((t) => t.name === 'approve_promotion');
    assert.ok(tool);
    await as(worker, KEYS, async () => {
      await assert.rejects(
        () => tool!.call(dora as never, { approvalId: id }),
        (e: Error & { status?: number }) => e.status === 409 && /rejected/i.test(e.message),
        'a request rejected in os-ui answers "Already rejected" in the worker',
      );
    });
    assert.equal((os.doc(INDEX, id) as { status?: string } | undefined)?.status, 'rejected');
  } finally {
    os.restore();
    approvals.__resetApprovals();
  }
});
