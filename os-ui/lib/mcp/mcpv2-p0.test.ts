/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import type { CurrentUser } from '@/lib/core/auth';
import { handleRpc, type JsonRpcResponse, type ToolError } from './server.ts';

import { __resetStore as resetData } from '@/lib/data/store';
import { __resetStore as resetKnowledge } from '@/lib/knowledge/store';
import { __resetStore as resetFiles } from '@/lib/files/store';
import { __resetDashboards } from '@/lib/dashboards/store';
import { __resetBets } from '@/lib/bigbets/store';
import { __resetForTests as resetPillars, createPillar } from '@/lib/strategy/pillars';
import { __resetStore as resetAgents } from '@/lib/agents/store';
import { __resetApprovals } from '@/lib/governance/approvals';

/**
 * MCP v2 — P0 (the cross-cutting primitives). The SECURITY-CRITICAL foundation:
 *   1. the canonical pending-handle shape on every enqueue-write;
 *   2. the governance queue tools (get_request / list_approvals / decide_approval)
 *      scoped + rank-gated;
 *   3. the ONE promotion/certification ladder — two-step per kind, owner-only
 *      trigger, and the back door PROVABLY closed (no direct promote outside the seam);
 *   4. get_lineage scoping + per-node redaction;
 *   5. import_product wiring.
 * We drive everything over `handleRpc` / `tools/call`, exactly as an AI client would.
 */

const cara: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' }; // owner
const ben: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'builder' }; // domain builder (can see, cannot approve rung-1)
const dana: CurrentUser = { id: 'dana', name: 'Dana', domains: ['sales'], role: 'domain_admin' }; // rung-1 promotion approver
const ada: CurrentUser = { id: 'ada', name: 'Ada', domains: ['sales'], role: 'admin' }; // platform admin
const dan: CurrentUser = { id: 'dan', name: 'Dan', domains: ['ops'], role: 'creator' }; // foreign domain
const bob: CurrentUser = { id: 'bob', name: 'Bob', domains: ['ops'], role: 'builder' }; // foreign builder

function resetAll(): void {
  resetData();
  resetKnowledge();
  resetFiles();
  __resetDashboards();
  __resetBets();
  resetAgents();
  __resetApprovals();
  resetPillars();
}

async function raw(user: CurrentUser, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res && 'result' in res, `expected a result for ${name}`);
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}
function ok<T = Record<string, unknown>>(r: Record<string, unknown>): T {
  assert.notEqual(r.isError, true, `expected success, got: ${(r.content as { text: string }[])?.[0]?.text}`);
  return JSON.parse((r.content as { text: string }[])[0].text) as T;
}
function err(r: Record<string, unknown>): ToolError {
  assert.equal(r.isError, true, 'expected a typed tool error');
  return (r.structuredContent as { error: ToolError }).error;
}
async function call<T = Record<string, unknown>>(u: CurrentUser, n: string, a: Record<string, unknown> = {}): Promise<T> {
  return ok<T>(await raw(u, n, a));
}

type Pending = { status: string; requestId: string; approvalId: string; kind: string; whoCanApprove: string; hint: string };

/** Build a documented dataset ready to promote (creator cara owns it). */
async function makeDataset(): Promise<string> {
  const ds = await call<{ id: string }>(cara, 'create_dataset', { name: 'Orders', columns: [{ name: 'a', description: 'A' }] });
  await call(cara, 'add_dataset_version', { datasetId: ds.id, layer: 'bronze' });
  await call(cara, 'add_dataset_version', { datasetId: ds.id, layer: 'silver', body: 'select 1 as a from bronze' });
  await call(cara, 'document_dataset', { datasetId: ds.id, description: 'One row.', columns: [{ name: 'a', description: 'A' }] });
  return ds.id;
}

// ============================ 1. PENDING-HANDLE SHAPE ==========================
test('P0.1 every enqueue-write returns the uniform PendingHandle shape (dataset + ladder kind)', async () => {
  resetAll();
  // dataset path (existing rails)
  const dsId = await makeDataset();
  const p1 = await call<Pending>(cara, 'request_promotion', { kind: 'dataset', id: dsId });
  // ladder path (knowledge — formerly one-step direct)
  const wf = await call<{ id: string }>(cara, 'author_knowledge', { title: 'Refunds' });
  const p2 = await call<Pending>(cara, 'request_promotion', { kind: 'knowledge', id: wf.id });

  for (const p of [p1, p2]) {
    assert.equal(p.status, 'pending');
    assert.ok(p.requestId, 'requestId present (canonical key)');
    assert.equal(p.approvalId, p.requestId, 'approvalId is a retained alias of requestId');
    assert.ok(typeof p.kind === 'string' && p.kind.length > 0, 'ApprovalKind present');
    assert.match(p.whoCanApprove, /builder|admin/i, 'whoCanApprove is human-readable');
    assert.match(p.hint, /decide_approval|get_request/, 'hint names the next action');
  }
  assert.equal(p1.kind, 'dataset_promote');
  assert.equal(p2.kind, 'artifact_promote');
  assert.match(p1.whoCanApprove, /sales/, 'domain promotion → a builder in the domain');
});

// ============================ 2. QUEUE TOOLS ==================================
test('P0.2 get_request / list_approvals are canSee-scoped; no existence leak', async () => {
  resetAll();
  const wf = await call<{ id: string }>(cara, 'author_knowledge', { title: 'Flow' });
  const filed = await call<Pending>(cara, 'request_promotion', { kind: 'knowledge', id: wf.id });

  // Owner sees their own request.
  const gotOwner = await call<{ requestId: string; mayApprove: boolean }>(cara, 'get_request', { requestId: filed.requestId });
  assert.equal(gotOwner.requestId, filed.requestId);
  assert.equal(gotOwner.mayApprove, false, 'a creator can never approve');

  // A domain builder SEES it but (rung-1 promotion) may NOT approve — that now needs a domain_admin.
  const gotBuilder = await call<{ mayApprove: boolean }>(ben, 'get_request', { requestId: filed.requestId });
  assert.equal(gotBuilder.mayApprove, false, 'a plain builder cannot approve a rung-1 promotion');
  // A domain_admin sees it AND may approve.
  const gotDomainAdmin = await call<{ mayApprove: boolean }>(dana, 'get_request', { requestId: filed.requestId });
  assert.equal(gotDomainAdmin.mayApprove, true, 'a domain_admin may approve a domain promotion');

  // A foreign-domain user cannot see it → not_found (indistinguishable from denied).
  const eDan = err(await raw(dan, 'get_request', { requestId: filed.requestId }));
  assert.equal(eDan.code, 'not_found', 'a request outside your scope is not_found (no existence leak)');

  // list_approvals is scoped: cara sees her own; dan sees nothing of sales.
  const caraList = await call<{ count: number }>(cara, 'list_approvals', { mine: true });
  assert.ok(caraList.count >= 1, 'owner sees her own filed request');
  const danList = await call<{ count: number }>(dan, 'list_approvals', {});
  assert.equal(danList.count, 0, 'a foreign-domain creator sees none of sales’ queue');
});

// ============================ 3. LADDER — TWO-STEP PER KIND ====================
test('P0.3 knowledge ladder: creator files → domain_admin approves → LIVE Shared (effect ran)', async () => {
  resetAll();
  const wf = await call<{ id: string }>(cara, 'author_knowledge', { title: 'Refund handling' });
  const filed = await call<Pending>(cara, 'request_promotion', { kind: 'knowledge', id: wf.id });
  assert.equal(filed.status, 'pending');

  // The approval IS the action: a domain_admin approves → the workflow is physically published.
  const decided = await call<{ decided: string; effect: { live: boolean; ok: boolean } }>(dana, 'decide_approval', { requestId: filed.requestId, decision: 'approve' });
  assert.equal(decided.decided, 'approved');
  assert.equal(decided.effect.ok, true);
  assert.equal(decided.effect.live, true, 'the ladder effect is LIVE (not a stub)');

  // Read back through the governed store: it is now Shared/live.
  const seen = await call<{ workflow: { visibility: string; status: string } }>(ben, 'get_knowledge', { workflowId: wf.id });
  assert.equal(seen.workflow.visibility, 'Shared');
  assert.equal(seen.workflow.status, 'live');
});

test('P0.3 owner-only trigger: a domain peer (edit rights, NOT owner) cannot file the promotion', async () => {
  resetAll();
  const wf = await call<{ id: string }>(cara, 'author_knowledge', { title: 'Owned by cara' });
  // ben is a builder in sales (can edit cara's draft) — but he is NOT the owner.
  const e = err(await raw(ben, 'request_promotion', { kind: 'knowledge', id: wf.id }));
  assert.equal(e.code, 'forbidden');
  assert.match(e.reason, /owner/i, 'only the owner can request promotion');
});

test('P0.3 decide gating: creator forbidden (floor); cross-domain builder cannot approve', async () => {
  resetAll();
  const wf = await call<{ id: string }>(cara, 'author_knowledge', { title: 'X' });
  const filed = await call<Pending>(cara, 'request_promotion', { kind: 'knowledge', id: wf.id });

  // A creator hits the builder floor.
  const eCara = err(await raw(cara, 'decide_approval', { requestId: filed.requestId, decision: 'approve' }));
  assert.equal(eCara.code, 'forbidden');
  assert.match(eCara.reason, /requires builder/i);

  // A foreign-domain builder cannot even SEE it → not_found (no escalation via a stolen id).
  const eBob = err(await raw(bob, 'decide_approval', { requestId: filed.requestId, decision: 'approve' }));
  assert.equal(eBob.code, 'not_found');
});

test('P0.3 certification rung: builder-in-domain files → ADMIN approves; builder cannot certify', async () => {
  resetAll();
  // Promote to Shared first (rung 1).
  const wf = await call<{ id: string }>(cara, 'author_knowledge', { title: 'Certify me' });
  const p = await call<Pending>(cara, 'request_promotion', { kind: 'knowledge', id: wf.id });
  await call(dana, 'decide_approval', { requestId: p.requestId, decision: 'approve' });

  // Rung 2: a domain BUILDER files certification (the domain vouches) — owner not required.
  const cert = await call<Pending>(ben, 'request_certification', { kind: 'knowledge', id: wf.id });
  assert.equal(cert.status, 'pending');
  assert.match(cert.whoCanApprove, /admin/i, 'certification is admin-approved (tenant scope)');

  // A foreign-domain builder cannot FILE certification for a sales artifact.
  const eBob = err(await raw(bob, 'request_certification', { kind: 'knowledge', id: wf.id }));
  assert.ok(eBob.code === 'not_found' || eBob.code === 'forbidden', 'a non-domain builder cannot certify-file');

  // A domain BUILDER cannot APPROVE a tenant-scope certification (needs Admin).
  const eBen = err(await raw(ben, 'decide_approval', { requestId: cert.requestId, decision: 'approve' }));
  assert.equal(eBen.code, 'forbidden');
  assert.match(eBen.reason, /admin/i);

  // The platform ADMIN approves → the workflow certifies to the Marketplace (LIVE).
  const decided = await call<{ decided: string; effect: { live: boolean } }>(ada, 'decide_approval', { requestId: cert.requestId, decision: 'approve' });
  assert.equal(decided.decided, 'approved');
  assert.equal(decided.effect.live, true);
  const seen = await call<{ workflow: { visibility: string } }>(ada, 'get_knowledge', { workflowId: wf.id });
  assert.equal(seen.workflow.visibility, 'Marketplace');
});

// ============ 4. BACK DOOR CLOSED — no direct promote outside the seam =========
test('P0.4 the ladder is the ONLY promotion path: no direct promote/certify/tier-flip call outside the allowlisted seam', () => {
  // Every per-kind promote/certify/tier-flip fn may ONLY be called from an
  // ALLOWLISTED file: its own store definition, the effect seam (effects.ts), the
  // shared filing seam (ladder.ts), or a documented cascade (apps.ts). A call
  // ANYWHERE ELSE in app/** or lib/** = an open governance back door. This scans
  // the WHOLE tree (not just app/api + lib/mcp) so a bypass can't hide in another
  // module (the agent_system hole did — promoteSystem was omitted before). (P0(g))
  const cwd = process.cwd();
  const grep = (fn: string): string[] => {
    try {
      const out = execSync(`grep -rln --include='*.ts' '${fn}(' app lib 2>/dev/null || true`, { cwd, encoding: 'utf8' });
      return out.trim().split('\n').filter(Boolean).filter((f) => !f.endsWith('.test.ts'));
    } catch {
      return [];
    }
  };
  // fn → the ONLY files allowed to call it (definition + seam + documented cascade).
  const ALLOW: Record<string, string[]> = {
    promoteConnection: ['lib/connections/store.ts', 'lib/governance/ladder.ts'],
    publishWorkflow: ['lib/knowledge/store.ts', 'lib/governance/effects.ts'],
    certifyWorkflow: ['lib/knowledge/store.ts', 'lib/governance/effects.ts'],
    promoteApp: ['lib/software/apps.ts', 'lib/governance/ladder.ts'],
    promoteArtifact: ['lib/core/artifacts.ts', 'lib/software/apps.ts', 'lib/governance/ladder.ts'], // apps.ts = documented cascade
    transitionDashboard: ['lib/dashboards/store.ts', 'lib/governance/effects.ts'],
    promoteModel: ['lib/science/model-service.ts', 'lib/governance/effects.ts'],
    certifyModel: ['lib/science/model-service.ts', 'lib/governance/effects.ts'],
    promoteSystem: ['lib/agents/store.ts', 'lib/governance/effects.ts'], // the fix: agent_system now on the ladder
    // dataset tier relabel (the `transition` alias): only the guarded metrics-govern
    // routes may call it, and ONLY for a NON-materialising asset→product move (they
    // refuse a dataset→asset flip and send it to the physical-publish path). The
    // shared <PromoteButton>'s `[id]/promote` front door replicates the SAME guard
    // (identical consistency gate + dataset-tier refusal) — same seam, second entry.
    transitionDataset: ['app/api/metrics/govern/route.ts', 'app/api/metrics/[id]/promote/route.ts'],
  };
  for (const [fn, allow] of Object.entries(ALLOW)) {
    const callers = grep(fn);
    const rogue = callers.filter((f) => !allow.includes(f));
    assert.deepEqual(rogue, [], `${fn} is called OUTSIDE the allowlisted seam (open back door): ${rogue.join(', ')}`);
  }
});

// ============================ 5. GET_LINEAGE ==================================
test('P0.5 get_lineage returns a normalized graph, scoped at the root (not_found off-scope)', async () => {
  resetAll();
  const ds = await call<{ id: string }>(cara, 'create_dataset', { name: 'Orders', columns: [{ name: 'a', description: 'A' }] });
  await call(cara, 'add_dataset_version', { datasetId: ds.id, layer: 'bronze' });

  const g = await call<{ ref: string; kind: string; nodes: unknown[]; edges: unknown[] }>(cara, 'get_lineage', { ref: `dataset:${ds.id}` });
  assert.equal(g.kind, 'dataset');
  assert.ok(Array.isArray(g.nodes) && g.nodes.length > 0, 'dataset lineage has nodes');

  // A foreign-domain caller cannot see the root → a governance denial, no content
  // leak (getDataset's own gate: forbidden for out-of-scope, not_found for unknown).
  const e = err(await raw(dan, 'get_lineage', { ref: `dataset:${ds.id}` }));
  assert.ok(e.code === 'forbidden' || e.code === 'not_found', `off-scope root is a governance denial (got ${e.code})`);
  const eUnknown = err(await raw(cara, 'get_lineage', { ref: 'dataset:ds_nope' }));
  assert.equal(eUnknown.code, 'not_found', 'a truly unknown id is not_found');

  // A malformed ref is a typed bad_request, never a crash.
  const eBad = err(await raw(cara, 'get_lineage', { ref: 'not-a-ref' }));
  assert.equal(eBad.code, 'bad_request');
});

test('P0.5 get_lineage redacts per-node: a bet component the caller cannot see renders {redacted:true}', async () => {
  resetAll();
  // ben (builder, sales) owns an ACTIVE bet + a PERSONAL dashboard component.
  const pillar = await createPillar(ben, { name: 'Retention', scope: 'domain', domain: 'sales' });
  const bet = await call<{ id: string }>(ben, 'create_big_bet', { problem: 'Churn is rising', pillarId: pillar.id, owner: 'ben', targetValue: 100000 });
  const dash = await call<{ id: string }>(ben, 'create_dashboard', { name: 'Ops', view: 'Orders', charts: [{ name: 'n', vizType: 'big_number_total', metric: 'Orders.revenue' }] });
  await call(ben, 'attach_component', { betId: bet.id, kind: 'dashboard', id: dash.id });

  // cara (creator, sales) can see the bet summary but NOT ben's personal dashboard detail.
  const g = await call<{ nodes: { id: string; redacted?: boolean }[] }>(cara, 'get_lineage', { ref: `bet:${bet.id}` });
  const compNode = g.nodes.find((n) => n.id === dash.id);
  assert.ok(compNode, 'the component node exists (existence is not hidden)');
  assert.equal(compNode!.redacted, true, 'a component the caller cannot see is redacted (existence without content)');

  // The OWNER sees it un-redacted.
  const gOwner = await call<{ nodes: { id: string; redacted?: boolean }[] }>(ben, 'get_lineage', { ref: `bet:${bet.id}` });
  assert.notEqual(gOwner.nodes.find((n) => n.id === dash.id)?.redacted, true);
});

// ============================ 6. IMPORT_PRODUCT ==============================
test('P0.6 import_product is wired on the marketplace surface; an unknown listing → not_found', async () => {
  resetAll();
  // The tenant catalog seeds EMPTY (listings appear only via governed certification);
  // the full grant/pending loop is the P8 live smoke. Here we prove the tool is
  // registered + governed: an unknown listing is a typed not_found, never a crash.
  const e = err(await raw(ben, 'import_product', { listingId: 'lst_does_not_exist' }));
  assert.equal(e.code, 'not_found');

  // A creator hits the Builder+ gate for a non-read-grant (fork) import.
  const eFork = err(await raw(cara, 'import_product', { listingId: 'lst_x', mode: 'fork' }));
  assert.equal(eFork.code, 'forbidden');
});

// ===================== REVIEW FIXES (adversarial review round) =================

// BLOCKER 1: agent systems no longer promote directly — they ride the ladder.
test('FIX1 agent_system rides the ladder: creator files → the admin (edit rights) approves → Shared', async () => {
  resetAll();
  const sys = await call<{ id: string; visibility: string }>(cara, 'create_agent_system', { name: 'Triage', template: 'analyze' });
  assert.equal(sys.visibility, 'Personal');

  const filed = await call<Pending>(cara, 'request_promotion', { kind: 'agent_system', id: sys.id });
  assert.equal(filed.status, 'pending');
  assert.equal(filed.kind, 'artifact_promote');

  // A domain builder passes the queue gate but the agent store's OWN edit gate is
  // owner-or-admin — so the effect fails and the request is LEFT PENDING (FIX 3).
  const eBen = err(await raw(ben, 'decide_approval', { requestId: filed.requestId, decision: 'approve' }));
  assert.ok(eBen.code === 'forbidden' || eBen.code === 'error', 'a non-owner builder cannot apply an agent_system promotion');
  const stillPending = await call<{ status: string }>(cara, 'get_request', { requestId: filed.requestId });
  assert.equal(stillPending.status, 'pending', 'a failed effect leaves the request PENDING (retriable), never silently approved');

  // The admin (edit rights in-domain) approves → the system is Shared.
  const decided = await call<{ decided: string }>(ada, 'decide_approval', { requestId: filed.requestId, decision: 'approve' });
  assert.equal(decided.decided, 'approved');
  const seen = await call<{ visibility: string }>(ada, 'get_agent_system', { systemId: sys.id });
  assert.equal(seen.visibility, 'Shared');
});

// HIGH 2: a builder cannot publish a creator's PRIVATE knowledge draft (owner-only
// trigger) — knowledge canEdit would otherwise let them, so the seam must guard it.
test('FIX2 owner-only one-shot: a domain_admin cannot publish a creator’s PRIVATE draft without a filing', async () => {
  resetAll();
  const wf = await call<{ id: string }>(cara, 'author_knowledge', { title: 'Cara private' });

  // dana is a domain_admin in sales (canEdit cara's draft, passes the publish role floor)
  // — but not the owner and no request has been filed → publish_knowledge is a typed forbidden.
  const e = err(await raw(dana, 'publish_knowledge', { workflowId: wf.id }));
  assert.equal(e.code, 'forbidden');
  assert.match(e.reason, /owner/i);
  // The draft is untouched — still Personal.
  const seen = await call<{ workflow: { visibility: string } }>(cara, 'get_knowledge', { workflowId: wf.id });
  assert.equal(seen.workflow.visibility, 'Personal');

  // Once the OWNER files, the domain_admin’s publish_knowledge becomes the legit approve-half.
  const filed = await call<Pending>(cara, 'request_promotion', { kind: 'knowledge', id: wf.id });
  const pub = await call<{ visibility: string }>(dana, 'publish_knowledge', { workflowId: wf.id });
  assert.equal(pub.visibility, 'Shared');
  // The filed request is closed out (no lingering pending duplicate).
  const after = await call<{ status: string }>(cara, 'get_request', { requestId: filed.requestId });
  assert.equal(after.status, 'approved');
});

// HIGH 5: the tier-derived rung can never diverge from the caller's stated intent.
test('FIX5 rung intent: publish_knowledge on an already-Shared workflow is a CONFLICT, never a silent certify', async () => {
  resetAll();
  // dana (domain_admin) owns + publishes her own draft → Shared.
  const wf = await call<{ id: string }>(dana, 'author_knowledge', { title: 'Dana flow' });
  await call(dana, 'publish_knowledge', { workflowId: wf.id });

  // A second publish_knowledge (intent=promote) on a Shared workflow must NOT silently
  // certify it to the marketplace — it is a typed conflict.
  const e = err(await raw(dana, 'publish_knowledge', { workflowId: wf.id }));
  assert.equal(e.code, 'conflict');
  const seen = await call<{ workflow: { visibility: string } }>(dana, 'get_knowledge', { workflowId: wf.id });
  assert.notEqual(seen.workflow.visibility, 'Marketplace', 'a promote-intent call never jumps to the marketplace');
});

// ===================== TACIT KNOWLEDGE — MCP surface =========================

import { __resetStore as resetKnowledgeForTacit } from '@/lib/knowledge/store';
import { getTacit } from '@/lib/knowledge/store';
import { chunkWorkflow } from '@/lib/knowledge/chunk';

test('TACIT.1 author_knowledge with per-step tacit persists inline and is parseable', async () => {
  resetAll();
  const wf = await call<{ id: string }>(cara, 'author_knowledge', {
    title: 'Invoice reconciliation',
    domain: 'sales',
    steps: [
      {
        title: 'Pull flagged invoices',
        actor: 'Software',
        outputs: ['Flagged invoice list'],
        tacit: 'Run after 10 AM — the ERP export misses invoices created before 9 AM on the same day.',
      },
      {
        title: 'Review and resolve',
        actor: 'Human',
        inputs: ['Flagged invoice list'],
        actor_name: 'Finance Analyst',
      },
    ],
  });

  // The workflow parses and the per-step tacit is round-tripped through workflow.md.
  const view = await call<{ workflow: { steps: { title: string; tacit: string }[] } }>(cara, 'get_knowledge', { workflowId: wf.id });
  const step0 = view.workflow.steps[0];
  assert.ok(step0.tacit.includes('ERP export'), 'per-step tacit is persisted and round-trips through workflow.md');
  assert.equal(view.workflow.steps[1].tacit, '', 'step without tacit has empty string');
});

test('TACIT.2 author_knowledge with workflow-level tacit persists in the sibling tacit.md', async () => {
  resetAll();
  const wfTacit = '## Seasonal note\nVolume spikes 3× in December.\n\n## System quirk\nAuto-closes after 90 days.';
  const wf = await call<{ id: string }>(cara, 'author_knowledge', {
    title: 'Refund escalation',
    domain: 'sales',
    tacit: wfTacit,
  });

  // Access the store directly to verify the tacit.md was written.
  const { tacit } = getTacit(wf.id, { id: 'cara', domains: ['sales'], role: 'creator' });
  assert.ok(tacit.includes('Volume spikes'), 'workflow-level tacit is stored in the sibling tacit.md');
  assert.ok(tacit.includes('Auto-closes'), 'second heading section is present');
});

test('TACIT.3 per-step tacit and workflow-level tacit both produce indexable tacit units', async () => {
  resetAll();
  const wfTacit = '## Cultural note\nThe support team calls this the "Friday problem" — volume drops 40% on Fridays.';
  const wf = await call<{ id: string }>(cara, 'author_knowledge', {
    title: 'Support triage',
    domain: 'sales',
    steps: [
      {
        title: 'Classify ticket',
        actor: 'Human',
        tacit: 'Check the priority field — it defaults to "medium" even for critical issues.',
      },
    ],
    tacit: wfTacit,
  });

  // Retrieve the workflow view to get the parsed Workflow object for chunking.
  const view = await call<{ workflow: { id: string; title: string; steps: { id: string; title: string; actor: string; actor_name: string; inputs: string[]; outputs: string[]; links: unknown[]; rules: unknown[]; tacit: string }[]; rules: unknown[]; visibility: string; status: string; domain: string; version: string; body: string } }>(cara, 'get_knowledge', { workflowId: wf.id });
  const { tacit } = getTacit(wf.id, { id: 'cara', domains: ['sales'], role: 'creator' });

  const units = chunkWorkflow({ workflow: view.workflow as Parameters<typeof chunkWorkflow>[0]['workflow'], owner: 'cara', tacit, updatedAt: new Date().toISOString() });
  const tacitUnits = units.filter((u) => u.provenance.type === 'tacit');

  // Expect at least 2 tacit units: 1 per-step + 1 workflow-level (the "Cultural note" section).
  assert.ok(tacitUnits.length >= 2, `expected at least 2 tacit units, got ${tacitUnits.length}: ${tacitUnits.map((u) => u.id).join(', ')}`);

  const stepTacit = tacitUnits.find((u) => u.provenance.stepId !== null);
  assert.ok(stepTacit, 'per-step tacit unit carries a stepId in provenance');
  assert.ok(stepTacit!.text.includes('priority field'), 'per-step tacit text is preserved');

  const wfTacitUnit = tacitUnits.find((u) => u.provenance.stepId === null);
  assert.ok(wfTacitUnit, 'workflow-level tacit unit has null stepId');
  assert.ok(wfTacitUnit!.text.includes('Friday problem'), 'workflow-level tacit text is preserved');
});
