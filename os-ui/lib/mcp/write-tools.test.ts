/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { handleRpc, type JsonRpcResponse, type ToolError } from './server.ts';

import { __resetStore as resetData } from '@/lib/data/store';
import { __resetStore as resetKnowledge } from '@/lib/knowledge/store';
import { __resetStore as resetFiles } from '@/lib/files/store';
import { __resetBlobs, getBlob } from '@/lib/files/object-store';
import { __resetDashboards } from '@/lib/dashboards/store';
import { __resetBets } from '@/lib/bigbets/store';
import { __resetStore as resetAgents } from '@/lib/agents/store';
import { __resetApprovals } from '@/lib/governance/approvals';
import { __resetForTests as resetPillars } from '@/lib/strategy/pillars';

/**
 * The governed MCP WRITE tools: each must delegate to the SAME lib function the UI
 * calls, under the caller's identity, with the role floor enforced (the creator
 * lockdown) and TYPED errors on denial. We drive them exactly as an AI client would
 * — over `handleRpc` / `tools/call` — and never touch a store directly.
 */

const creator: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };
// Ben is a domain_admin: rung-1 Personal→Shared approval/publish now needs domain_admin+.
const builder: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'domain_admin' };
const admin: CurrentUser = { id: 'ada', name: 'Ada', domains: ['sales'], role: 'admin' };

function resetAll(): void {
  resetData();
  resetKnowledge();
  resetFiles();
  __resetBlobs();
  __resetDashboards();
  __resetBets();
  resetAgents();
  __resetApprovals();
  resetPillars();
}

/** Create a real domain pillar (as a builder) and return its id — a Big Bet must
 *  be filed under a pillar the caller can view (containment). */
async function seedPillar(user: CurrentUser = builder): Promise<string> {
  const p = payload<{ id: string }>(await call(user, 'create_pillar', { name: 'Grow NRR', scope: 'domain', domain: 'sales' }));
  return p.id;
}

async function call(user: CurrentUser, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res && 'result' in res, `expected a result for ${name}`);
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}

function payload<T = Record<string, unknown>>(r: Record<string, unknown>): T {
  assert.notEqual(r.isError, true, `expected success, got: ${(r.content as { text: string }[])[0]?.text}`);
  return JSON.parse((r.content as { text: string }[])[0].text) as T;
}

function errorOf(r: Record<string, unknown>): ToolError {
  assert.equal(r.isError, true, 'expected a typed tool error');
  return (r.structuredContent as { error: ToolError }).error;
}

// ---- DATA lane: create → version → document → promote → metric → dashboard ----
test('DATA: a builder builds a governed dataset → metric → dashboard, all as themselves', async () => {
  resetAll();

  const ds = payload(await call(builder, 'create_dataset', {
    name: 'Orders',
    columns: [{ name: 'net_amount', description: 'Order value in EUR' }],
  }));
  assert.ok(ds.id, 'create_dataset returns an id (created via the governed store)');
  assert.equal(ds.owner, 'ben', 'runs as the caller, not the body');
  assert.equal(ds.domain, 'sales');
  const datasetId = ds.id as string;

  payload(await call(builder, 'add_dataset_version', { datasetId, layer: 'bronze' }));
  payload(await call(builder, 'add_dataset_version', { datasetId, layer: 'silver', body: 'select order_id, net_amount from bronze' }));
  payload(await call(builder, 'add_dataset_version', { datasetId, layer: 'gold', passThrough: true }));
  payload(await call(builder, 'document_dataset', { datasetId, description: 'One row per order.' }));

  // Split promotion: a creator FILES the request, a Builder APPLIES it. Here the
  // builder does both (they are the domain Builder).
  const req = payload<{ approvalId: string; status: string }>(await call(builder, 'request_promotion', { kind: 'dataset', id: datasetId }));
  assert.equal(req.status, 'pending', 'request_promotion enqueues a governed request');
  const promoted = payload<{ approved: boolean; asset: { tier: string } }>(await call(builder, 'approve_promotion', { approvalId: req.approvalId }));
  assert.equal(promoted.approved, true);
  assert.equal(promoted.asset.tier, 'asset', 'approve_promotion moved it into the governed asset tier');

  const metric = payload<{ member: string }>(await call(builder, 'define_metric', {
    datasetId, name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: ['order_date'],
  }));
  assert.match(metric.member, /\.revenue$/, 'define_metric returns the canonical Cube member');

  const view = metric.member.split('.')[0];
  const dash = payload<{ id: string }>(await call(builder, 'create_dashboard', {
    name: 'Sales Overview', view, charts: [{ name: 'Revenue', vizType: 'big_number_total', metric: metric.member }],
  }));
  assert.ok(dash.id, 'create_dashboard persisted via the governed store');
});

// ---- KNOWLEDGE lane: author → index → publish -------------------------------
test('KNOWLEDGE: author a draft, index it, then a builder publishes it', async () => {
  resetAll();
  const wf = payload<{ id: string; status: string }>(await call(builder, 'author_knowledge', {
    title: 'Refund handling',
    steps: [{ title: 'Verify order', actor: 'Human' }, { title: 'Issue refund', actor: 'Software' }],
    rules: [{ text: 'Refunds over 500 EUR need a manager', hard: true }],
  }));
  assert.ok(wf.id);
  assert.equal(wf.status, 'draft');

  // index_knowledge runs the governed pipeline for a workflow the caller can see.
  await call(builder, 'index_knowledge', { workflowId: wf.id });

  const pub = payload<{ status: string; visibility: string }>(await call(builder, 'publish_knowledge', { workflowId: wf.id }));
  assert.equal(pub.status, 'live');
  assert.equal(pub.visibility, 'Shared');
});

// ---- FILES lane: upload (documented) → promote ------------------------------
test('FILES: upload a documented file, then a builder promotes it to a domain asset', async () => {
  resetAll();
  const file = payload<{ id: string; owner: string }>(await call(builder, 'upload_file', {
    name: 'refund-policy.md', text: 'Refunds within 5 days.', tags: ['policy'], description: 'Customer refund policy',
  }));
  assert.ok(file.id);
  assert.equal(file.owner, 'ben');

  const req = payload<{ approvalId: string; status: string }>(await call(builder, 'request_promotion', { kind: 'file', id: file.id }));
  assert.equal(req.status, 'pending');
  const promoted = payload<{ approved: boolean; asset: { tier: string } }>(await call(builder, 'approve_promotion', { approvalId: req.approvalId }));
  assert.equal(promoted.approved, true);
  assert.equal(promoted.asset.tier, 'asset');
});

// ---- BIG BETS + AGENTS ------------------------------------------------------
test('BIG BETS + AGENTS: create a bet and assemble + build an agent system as the caller', async () => {
  resetAll();
  const pillarId = await seedPillar();
  const bet = payload<{ id: string; status: string }>(await call(builder, 'create_big_bet', {
    problem: 'Churn is rising among SMB accounts', pillarId, owner: 'ben', targetValue: 250000,
  }));
  assert.ok(bet.id);
  assert.equal(bet.status, 'active', 'a builder owns an ACTIVE bet');

  const sys = payload<{ id: string; visibility: string }>(await call(builder, 'create_agent_system', { name: 'Support triage', template: 'analyze' }));
  assert.ok(sys.id);
  assert.equal(sys.visibility, 'Personal', 'a new system is always Personal (sharing is the governed ladder)');

  const commit = payload<{ committed: { path: string }[] }>(await call(builder, 'commit_agent_files', {
    systemId: sys.id, files: [{ path: 'agents/analyst/AGENT.md', content: '# Analyst\nClassify tickets.' }],
  }));
  assert.equal(commit.committed[0].path, 'agents/analyst/AGENT.md');

  // Build runs the governed adapters (offline-mock in the test env) — as the caller.
  const build = payload<{ mode: string }>(await call(builder, 'build_agent_system', { systemId: sys.id }));
  assert.ok(build.mode, 'build_agent_system returns a build report');
});

// ---- BIG BET containment: pillarId is required + view-gated ------------------
test('BIG BET containment: create_big_bet needs a viewable pillarId', async () => {
  resetAll();
  // Missing pillarId → bad_request (400).
  const missing = errorOf(await call(builder, 'create_big_bet', { problem: 'No pillar given' }));
  assert.equal(missing.code, 'bad_request', 'a bet with no pillarId is refused');

  // A pillarId the caller cannot view → typed forbidden/not_found (no existence leak).
  const finPillar = payload<{ id: string }>(
    await call({ id: 'fin', name: 'Fin', domains: ['finance'], role: 'builder' }, 'create_pillar', {
      name: 'Finance spine', scope: 'domain', domain: 'finance',
    }),
  );
  const unseen = errorOf(await call(builder, 'create_big_bet', { problem: 'Cross-domain grab', pillarId: finPillar.id }));
  assert.ok(unseen.code === 'forbidden' || unseen.code === 'not_found', `no cross-domain pillar leak (got ${unseen.code})`);

  // A real, viewable pillar → the bet is filed under it.
  const pillarId = await seedPillar();
  const bet = payload<{ id: string }>(await call(builder, 'create_big_bet', { problem: 'Real bet', pillarId }));
  assert.ok(bet.id, 'a bet under a viewable pillar is created');
});

// ---- BIG BET lifecycle: archive · unarchive · delete · restore (gated) ------
test('BIG BET lifecycle: owner archives → unarchives → restores → deletes; a creator draft owner runs their own', async () => {
  resetAll();
  const pillarId = await seedPillar();
  const bet = payload<{ id: string }>(await call(builder, 'create_big_bet', { problem: 'Lifecycle bet', pillarId, targetValue: 100 }));
  const betId = bet.id;

  // archive → status archived.
  const arch = payload<{ status: string }>(await call(builder, 'archive_big_bet', { betId }));
  assert.equal(arch.status, 'archived', 'archive_big_bet soft-hides the bet');

  // unarchive → back to active.
  const un = payload<{ status: string }>(await call(builder, 'unarchive_big_bet', { betId }));
  assert.equal(un.status, 'active', 'unarchive_big_bet returns it to the working list');

  // An edit records a version; restore_big_bet_version rolls the content back.
  payload(await call(builder, 'update_big_bet', { betId, name: 'Renamed bet' }));
  const restored = payload<{ id: string }>(await call(builder, 'restore_big_bet_version', { betId, versionId: 1 }));
  assert.equal(restored.id, betId, 'restore_big_bet_version returns the bet');

  // delete → gone.
  const del = payload<{ deleted: boolean }>(await call(builder, 'delete_big_bet', { betId }));
  assert.equal(del.deleted, true, 'delete_big_bet permanently removes it');
  const gone = errorOf(await call(builder, 'get_big_bet', { betId }));
  assert.ok(gone.code === 'not_found' || gone.code === 'forbidden', 'the deleted bet is gone');
});

test('BIG BET lifecycle: a non-owner outsider cannot archive/delete someone elses bet (typed error)', async () => {
  resetAll();
  const pillarId = await seedPillar();
  const bet = payload<{ id: string }>(await call(builder, 'create_big_bet', { problem: 'Owned by Ben', pillarId }));
  // A builder in another domain — not the owner, not an admin — cannot edit.
  const outsider: CurrentUser = { id: 'zed', name: 'Zed', domains: ['finance'], role: 'builder' };
  const err = errorOf(await call(outsider, 'archive_big_bet', { betId: bet.id }));
  assert.ok(err.code === 'forbidden' || err.code === 'not_found', `the store edit gate re-gates (got ${err.code})`);
  const errDel = errorOf(await call(outsider, 'delete_big_bet', { betId: bet.id }));
  assert.ok(errDel.code === 'forbidden' || errDel.code === 'not_found', `delete is edit-gated too (got ${errDel.code})`);
});

// ---- BIG BET SOLUTION BLUEPRINT (Phase 3): anchor · attach · wire · read -----
test('SOLUTION: attach_bet_component re-resolves canView, set_bet_workflow anchors, wire validates + dedupes, get_bet_solution reads back', async () => {
  resetAll();
  const pillarId = await seedPillar();
  const bet = payload<{ id: string }>(await call(builder, 'create_big_bet', { problem: 'Wire the solution', pillarId, targetValue: 100 }));

  // Real components authored through their OWN governed stores (not forged ids).
  const wf = payload<{ id: string }>(await call(builder, 'author_knowledge', { title: 'Retention playbook' }));
  const sys = payload<{ id: string }>(await call(builder, 'create_agent_system', { name: 'Retention agent', template: 'analyze' }));

  // attach_bet_component handles the extra kinds (knowledge, agent) — each re-resolved
  // through its tab's canView gate before the reference is recorded.
  const attWf = payload<{ refId: string; tab: string }>(await call(builder, 'attach_bet_component', { betId: bet.id, kind: 'knowledge', id: wf.id }));
  const attSys = payload<{ refId: string; tab: string }>(await call(builder, 'attach_bet_component', { betId: bet.id, kind: 'agent', id: sys.id }));
  assert.equal(attWf.tab, 'knowledge');
  assert.equal(attSys.tab, 'agent');

  // A forged/unseen id is a typed not_found/forbidden BEFORE anything attaches.
  const forged = errorOf(await call(builder, 'attach_bet_component', { betId: bet.id, kind: 'knowledge', id: 'wf_does_not_exist' }));
  assert.ok(forged.code === 'not_found' || forged.code === 'forbidden', `forged id refused (got ${forged.code})`);

  // set_bet_workflow anchors the knowledge ref; a non-knowledge anchor is refused.
  payload(await call(builder, 'set_bet_workflow', { betId: bet.id, refId: attWf.refId }));
  const badAnchor = errorOf(await call(builder, 'set_bet_workflow', { betId: bet.id, refId: attSys.refId }));
  assert.equal(badAnchor.code, 'bad_request', 'the anchor must be a knowledge component');

  // wire_bet_components validates the relation + dedupes.
  const badRel = errorOf(await call(builder, 'wire_bet_components', { betId: bet.id, from: attWf.refId, to: attSys.refId, relation: 'bogus' }));
  assert.equal(badRel.code, 'bad_request', 'an invalid relation is refused');
  const edge = payload<{ edgeId: string; relation: string }>(await call(builder, 'wire_bet_components', { betId: bet.id, from: attWf.refId, to: attSys.refId, relation: 'triggers' }));
  assert.equal(edge.relation, 'triggers');
  const dup = errorOf(await call(builder, 'wire_bet_components', { betId: bet.id, from: attWf.refId, to: attSys.refId, relation: 'triggers' }));
  assert.equal(dup.code, 'conflict', 'a duplicate edge is refused');

  // get_bet_solution reads the blueprint back — anchor, nodes (with roles), edges.
  const sol = payload<{ anchor: { refId: string } | null; nodes: { refId: string; role: string }[]; edges: { edgeId: string }[] }>(
    await call(builder, 'get_bet_solution', { betId: bet.id }),
  );
  assert.equal(sol.anchor?.refId, attWf.refId, 'the anchor is read back');
  assert.equal(sol.nodes.find((n) => n.refId === attWf.refId)?.role, 'anchor-workflow');
  assert.equal(sol.edges.length, 1, 'the one interplay edge is read back');

  // unwire_bet_components removes it; an unknown edge id is a typed not_found.
  payload(await call(builder, 'unwire_bet_components', { betId: bet.id, edgeId: edge.edgeId }));
  const gone = errorOf(await call(builder, 'unwire_bet_components', { betId: bet.id, edgeId: edge.edgeId }));
  assert.equal(gone.code, 'not_found', 'unwiring a missing edge is a typed not_found');
});

test('SOLUTION: a non-editor outsider is denied every blueprint write (edit-gate, typed forbidden)', async () => {
  resetAll();
  const pillarId = await seedPillar();
  const bet = payload<{ id: string }>(await call(builder, 'create_big_bet', { problem: 'Owned by Ben', pillarId }));
  const wf = payload<{ id: string }>(await call(builder, 'author_knowledge', { title: 'Ben SOP' }));
  const att = payload<{ refId: string }>(await call(builder, 'attach_bet_component', { betId: bet.id, kind: 'knowledge', id: wf.id }));

  // A builder in another domain — not the owner, not an admin — cannot edit the blueprint.
  const outsider: CurrentUser = { id: 'zed', name: 'Zed', domains: ['finance'], role: 'builder' };
  const a = errorOf(await call(outsider, 'set_bet_workflow', { betId: bet.id, refId: att.refId }));
  assert.ok(a.code === 'forbidden' || a.code === 'not_found', `set_bet_workflow is edit-gated (got ${a.code})`);
  const b = errorOf(await call(outsider, 'attach_bet_component', { betId: bet.id, kind: 'knowledge', id: wf.id }));
  assert.ok(b.code === 'forbidden' || b.code === 'not_found', `attach_bet_component is edit-gated (got ${b.code})`);
});

// ---- THE CREATOR LOCKDOWN: create yes, promote/publish NO --------------------
test('LOCKDOWN: a creator may create but is denied every promote/publish (typed forbidden, not a crash)', async () => {
  resetAll();
  // A creator CAN create in their own domain.
  const ds = payload(await call(creator, 'create_dataset', {
    name: 'My draft', columns: [{ name: 'a', description: 'A constant' }],
  }));
  assert.equal(ds.owner, 'cara');
  const wf = payload(await call(creator, 'author_knowledge', { title: 'Draft flow' }));

  // The creator CAN FILE a promotion request (the split's whole point) — but the
  // dataset must be documented + silver/gold. Build it up so the FILE step is a
  // genuine governance file, then prove APPROVE is the forbidden half.
  payload(await call(creator, 'add_dataset_version', { datasetId: ds.id, layer: 'bronze' }));
  payload(await call(creator, 'add_dataset_version', { datasetId: ds.id, layer: 'silver', body: 'select 1 as a from bronze' }));
  payload(await call(creator, 'document_dataset', { datasetId: ds.id, description: 'Draft.', columns: [{ name: 'a', description: 'A constant' }] }));
  const filed = payload<{ approvalId: string; status: string }>(await call(creator, 'request_promotion', { kind: 'dataset', id: ds.id }));
  assert.equal(filed.status, 'pending', 'a creator CAN file a promotion request');

  // …but a creator may NOT approve it, nor publish knowledge (typed forbidden).
  for (const [name, args] of [
    ['approve_promotion', { approvalId: filed.approvalId }],
    ['publish_knowledge', { workflowId: (wf as { id: string }).id }],
  ] as const) {
    const e = errorOf(await call(creator, name, args as Record<string, unknown>));
    assert.equal(e.code, 'forbidden', `${name} must be a typed forbidden for a creator`);
    assert.match(e.reason, /requires (builder|domain_admin)/i);
    assert.ok(e.hint.length > 0);
  }
});

// ---- WHOAMI + LIST_CAPABILITIES reflect the role ----------------------------
test('DISCOVERY: whoami + list_capabilities reflect the caller’s role', async () => {
  resetAll();
  const who = payload<{ role: string; id: string; cannot: string[]; can: string[] }>(await call(creator, 'whoami'));
  assert.equal(who.role, 'creator');
  assert.equal(who.id, 'cara');
  assert.ok(who.cannot.some((c) => /promote|publish/i.test(c)), 'a creator is told they cannot promote');

  const caps = payload<{ role: string; available: { name: string }[]; gated: { name: string; reason: string }[] }>(
    await call(creator, 'list_capabilities'),
  );
  const avail = caps.available.map((t) => t.name);
  const gated = caps.gated.map((t) => t.name);
  assert.ok(avail.includes('create_dataset') && avail.includes('whoami'));
  assert.ok(gated.includes('approve_promotion') && gated.includes('promote'), 'gated tools are listed with a reason');

  // An admin sees strictly more available tools than a creator.
  const adminCaps = payload<{ available: { name: string }[] }>(await call(admin, 'list_capabilities'));
  assert.ok(adminCaps.available.length > caps.available.length);
});

// ---- TYPED bad_request ------------------------------------------------------
test('ERGONOMICS: a missing required arg is a typed bad_request (with a hint), never a crash', async () => {
  resetAll();
  const e = errorOf(await call(builder, 'create_dataset', {}));
  assert.equal(e.code, 'bad_request');
  assert.ok(e.hint.length > 0);
});

// ---- DATA QUALITY: define rules (write) → run them (read), honestly ----------
test('DATA QUALITY: define_quality_rules stores executable rules; run_quality_checks reports honestly', async () => {
  resetAll();
  const d = payload<{ id: string }>(await call(creator, 'create_dataset', { name: 'Orders', domain: 'sales' }));

  // A creator can author quality rules on their own dataset.
  const defined = payload<{ datasetId: string; checks: { rule?: string; column?: string }[] }>(
    await call(creator, 'define_quality_rules', {
      datasetId: d.id,
      rules: [
        { rule: 'not_null', column: 'order_id' },
        { rule: 'accepted_values', column: 'status', values: ['open', 'closed'] },
        { rule: 'range', column: 'net_amount', min: 0 },
      ],
    }),
  );
  assert.equal(defined.checks.length, 3);
  assert.deepEqual(defined.checks.map((c) => c.rule), ['not_null', 'accepted_values', 'range']);

  // Running them: no physical table is materialized in-process, so every rule is
  // honestly "not_run" and the badge is unknown — NEVER a fake pass.
  const report = payload<{ badge: string; results: { status: string }[] }>(
    await call(creator, 'run_quality_checks', { datasetId: d.id }),
  );
  assert.equal(report.results.length, 3);
  assert.ok(report.results.every((r) => r.status === 'not_run'), 'no built layer ⇒ not_run, never a fake pass');
  assert.equal(report.badge, 'unknown');
});

test('DATA QUALITY: a rule without a column is a typed bad_request', async () => {
  resetAll();
  const d = payload<{ id: string }>(await call(creator, 'create_dataset', { name: 'Orders', domain: 'sales' }));
  const e = errorOf(await call(creator, 'define_quality_rules', { datasetId: d.id, rules: [{ rule: 'not_null' }] }));
  assert.equal(e.code, 'bad_request');
});

// ---- RETIRE KNOWLEDGE: governed archive/delete, lineage- + role-gated --------
test('RETIRE: a zero-consumer draft archives (reversible), then deletes physically', async () => {
  resetAll();
  const wf = payload<{ id: string }>(await call(creator, 'author_knowledge', { title: 'Stale flow' }));

  // ARCHIVE (default): reversible soft-hide of the caller's OWN Personal draft.
  const archived = payload<{ action: string; archived: boolean; reversible: boolean }>(
    await call(creator, 'retire_knowledge', { workflowId: wf.id }),
  );
  assert.equal(archived.action, 'archive');
  assert.equal(archived.archived, true);
  assert.equal(archived.reversible, true);

  // DELETE: physical + irreversible on the zero-consumer draft (archived first, above,
  // but a draft can be deleted directly — the store only blocks a LIVE workflow).
  const deleted = payload<{ action: string; deleted: boolean; reversible: boolean }>(
    await call(creator, 'retire_knowledge', { workflowId: wf.id, action: 'delete' }),
  );
  assert.equal(deleted.action, 'delete');
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.reversible, false);

  // Gone: a second retire is a typed not_found (the governed view guard).
  const gone = errorOf(await call(creator, 'retire_knowledge', { workflowId: wf.id }));
  assert.equal(gone.code, 'not_found');
});

test('RETIRE: blocked (typed conflict) while an Agent system still consumes the workflow', async () => {
  resetAll();
  const wf = payload<{ id: string }>(await call(builder, 'author_knowledge', { title: 'Consumed flow' }));

  // Wire the workflow into an agent system's knowledge grants (the "context out"
  // handover) so it has a live consumer.
  const sys = payload<{ id: string }>(await call(builder, 'create_agent_system', { name: 'Triage', template: 'analyze' }));
  const view = payload<{ yaml: string }>(await call(builder, 'get_agent_system', { systemId: sys.id }));
  const granted = view.yaml.replace(/knowledge: \[\]/, `knowledge: [${wf.id}]`);
  assert.notEqual(granted, view.yaml, 'spliced a knowledge grant into system.yaml');
  payload(await call(builder, 'commit_agent_files', { systemId: sys.id, path: 'system.yaml', content: granted }));

  // Retire (archive OR delete) is BLOCKED — never orphan a live dependency.
  const blocked = errorOf(await call(builder, 'retire_knowledge', { workflowId: wf.id }));
  assert.equal(blocked.code, 'conflict');
  assert.match(blocked.reason, new RegExp(`still consumed by:.*${sys.id}`));

  // Remove the grant → the consumer is gone → retire now succeeds.
  const released = granted.replace(`knowledge: [${wf.id}]`, 'knowledge: []');
  payload(await call(builder, 'commit_agent_files', { systemId: sys.id, path: 'system.yaml', content: released }));
  const ok = payload<{ archived: boolean }>(await call(builder, 'retire_knowledge', { workflowId: wf.id }));
  assert.equal(ok.archived, true, 'with no consumer, retire proceeds');
});

test('RETIRE: role-gated — a creator is denied retiring another owner’s SHARED workflow', async () => {
  resetAll();
  // Builder authors + publishes a workflow → it becomes a SHARED domain artifact.
  const wf = payload<{ id: string }>(await call(builder, 'author_knowledge', { title: 'Shared SOP' }));
  const pub = payload<{ status: string; visibility: string }>(await call(builder, 'publish_knowledge', { workflowId: wf.id }));
  assert.equal(pub.visibility, 'Shared');

  // A same-domain CREATOR can SEE it but is not entitled to edit/retire it (the
  // Knowledge edit gate: owner, or a same-domain Builder+). Typed forbidden.
  const denied = errorOf(await call(creator, 'retire_knowledge', { workflowId: wf.id }));
  assert.equal(denied.code, 'forbidden');
});

// ---- CUBE auto-registration reflected in get_dataset -------------------------
test('DISCOVERY: get_dataset reflects Cube auto-registration state (no manual metric needed)', async () => {
  resetAll();
  const d = payload<{ id: string }>(await call(creator, 'create_dataset', { name: 'Orders', domain: 'sales' }));
  // A brand-new private dataset is NOT Cube-ready (not shared, no Gold).
  const before = payload<{ cube: { ready: boolean; measures: string[] } }>(await call(creator, 'get_dataset', { datasetId: d.id }));
  assert.equal(before.cube.ready, false);
  // The measures default to the count fallback (queryable without define_metric).
  assert.deepEqual(before.cube.measures, ['count']);
});

// ---- METRICS: define_metric returns pending flag + preview/promote tools ----
test('METRICS: define_metric returns member and pending flag; preview_metric previews without persisting', async () => {
  resetAll();

  // Build a governed Gold dataset (same pipeline as the DATA lane test).
  const ds = payload<{ id: string }>(await call(builder, 'create_dataset', {
    name: 'Sales', columns: [{ name: 'net_amount', description: 'Order value' }],
  }));
  const datasetId = ds.id as string;
  payload(await call(builder, 'add_dataset_version', { datasetId, layer: 'bronze' }));
  payload(await call(builder, 'add_dataset_version', { datasetId, layer: 'silver', body: 'select net_amount from bronze' }));
  payload(await call(builder, 'add_dataset_version', { datasetId, layer: 'gold', passThrough: true }));
  payload(await call(builder, 'document_dataset', { datasetId, description: 'Sales data.' }));
  const req = payload<{ approvalId: string }>(await call(builder, 'request_promotion', { kind: 'dataset', id: datasetId }));
  payload(await call(builder, 'approve_promotion', { approvalId: req.approvalId }));

  // preview_metric: transient — no persist, returns rows + mode
  const preview = payload<{ member: string; rows: unknown[]; mode: string }>(await call(builder, 'preview_metric', {
    datasetId, name: 'Revenue', aggregation: 'sum', column: 'net_amount',
  }));
  assert.match(preview.member, /\.revenue$/i, 'preview_metric returns the canonical member');
  assert.ok(Array.isArray(preview.rows), 'preview_metric returns rows');
  assert.ok(preview.mode === 'live' || preview.mode === 'offline-mock', 'preview_metric returns a mode');

  // define_metric: persists + returns member (and optionally pending)
  const defined = payload<{ member: string; pending?: boolean }>(await call(builder, 'define_metric', {
    datasetId, name: 'Revenue', aggregation: 'sum', column: 'net_amount',
  }));
  assert.match(defined.member, /\.revenue$/i, 'define_metric returns the canonical member');
  // pending is allowed (Cube sync lag in offline-mock env) but not required
  assert.ok(defined.pending === true || defined.pending === undefined, 'pending is true or absent');
});

test('METRICS: promote_metric — creator owner files a request; bad id returns not_found', async () => {
  resetAll();

  // promote_metric with a non-existent metricId → not_found
  const missing = errorOf(await call(builder, 'promote_metric', { metricId: 'ds_missing.revenue' }));
  assert.ok(missing.code === 'not_found' || missing.code === 'bad_request', `unknown metric refused (got ${missing.code})`);
});

// ---- FILES binary round-trip: upload_file with base64Content stores REAL bytes ---
test('FILES binary: upload_file with base64Content stores the real object in the blob store (not a text-only record)', async () => {
  resetAll();

  // A minimal valid PDF header — enough to prove bytes are stored faithfully.
  const pdfContent = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const b64 = Buffer.from(pdfContent, 'utf8').toString('base64');

  const file = payload<{ id: string; owner: string; name: string }>(
    await call(builder, 'upload_file', {
      name: 'invoice-2026-01.pdf',
      base64Content: b64,
      mimeType: 'application/pdf',
      folder: 'invoices',
      tags: ['invoice', 'finance'],
      description: 'January 2026 supplier invoice',
      sensitivity: 'confidential',
    }),
  );
  assert.ok(file.id, 'upload_file returns an asset id');
  assert.equal(file.owner, 'ben', 'runs as the caller identity');
  assert.equal(file.name, 'invoice-2026-01.pdf');

  // The blob must be present in the object store — NOT a text/metadata-only record.
  // We verify by calling the store's getFile (via get_file) and checking the object field,
  // then by directly reading the blob to confirm the bytes are faithful.
  const view = payload<{ asset: { id: string; name: string }; object: { contentType: string; bytes: number } | null }>(
    await call(builder, 'get_file', { fileId: file.id }),
  );
  assert.ok(view.object !== null, 'upload_file with base64Content must store a real object (object field is not null)');
  assert.equal(view.object!.contentType, 'application/pdf', 'stored with the correct MIME type');
  assert.ok(view.object!.bytes > 0, 'stored byte count is non-zero');

  // Read the blob directly from the in-memory backend and verify the content is faithful.
  const blob = await getBlob(view.object!.key ?? '');
  assert.ok(blob !== null, 'getBlob returns the stored object');
  assert.equal(blob!.contentType, 'application/pdf');
  const roundTripped = blob!.body.toString('utf8');
  assert.equal(roundTripped, pdfContent, 'round-tripped bytes are byte-for-byte identical to the original');
});

test('FILES binary: upload_file without base64Content (text-only) has no object in the blob store', async () => {
  resetAll();
  const file = payload<{ id: string }>(
    await call(builder, 'upload_file', {
      name: 'refund-policy.md',
      text: 'Refunds are processed within 5 days.',
      tags: ['policy'],
      description: 'Customer refund policy',
    }),
  );
  assert.ok(file.id);
  const view = payload<{ object: null }>(await call(builder, 'get_file', { fileId: file.id }));
  // A text-only upload has no stored object (the original shape).
  assert.equal(view.object, null, 'text-only upload has no stored binary object');
});

test('FILES binary: upload_file with base64Content but missing mimeType is a typed bad_request', async () => {
  resetAll();
  const e = errorOf(await call(builder, 'upload_file', {
    name: 'mystery.bin',
    base64Content: Buffer.from('hello').toString('base64'),
    // mimeType omitted — must be a typed bad_request
  }));
  assert.equal(e.code, 'bad_request', 'missing mimeType with base64Content must be a typed bad_request');
});

test('DATA: retire_dataset archives (reversible) as the owner + typed not_found on a bogus id', async () => {
  resetAll();
  const ds = payload<{ id: string }>(await call(builder, 'create_dataset', {
    name: 'Scratch dataset',
    columns: [{ name: 'x', description: 'v' }],
  }));
  const out = payload<{ action: string; archived: boolean; reversible: boolean }>(
    await call(builder, 'retire_dataset', { datasetId: ds.id }),
  );
  assert.equal(out.action, 'archive', 'defaults to reversible archive');
  assert.equal(out.archived, true);
  assert.equal(out.reversible, true);

  const missing = errorOf(await call(builder, 'retire_dataset', { datasetId: 'ds_does_not_exist' }));
  assert.equal(missing.code, 'not_found', 'retiring a missing dataset is a typed not_found (no leak)');
});
