/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/auth';
import { handleRpc, type JsonRpcResponse, type ToolError } from './server.ts';

import { __resetStore as resetData } from '@/lib/data/store';
import { __resetStore as resetKnowledge } from '@/lib/knowledge/store';
import { __resetStore as resetFiles } from '@/lib/files/store';
import { __resetDashboards } from '@/lib/dashboards/store';
import { __resetBets } from '@/lib/bigbets/store';
import { __resetStore as resetAgents } from '@/lib/agents/store';
import { __resetApprovals } from '@/lib/approvals';

/**
 * The governed MCP WRITE tools: each must delegate to the SAME lib function the UI
 * calls, under the caller's identity, with the role floor enforced (the creator
 * lockdown) and TYPED errors on denial. We drive them exactly as an AI client would
 * — over `handleRpc` / `tools/call` — and never touch a store directly.
 */

const creator: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };
const builder: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'builder' };
const admin: CurrentUser = { id: 'ada', name: 'Ada', domains: ['sales'], role: 'admin' };

function resetAll(): void {
  resetData();
  resetKnowledge();
  resetFiles();
  __resetDashboards();
  __resetBets();
  resetAgents();
  __resetApprovals();
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
  const bet = payload<{ id: string; status: string }>(await call(builder, 'create_big_bet', {
    problem: 'Churn is rising among SMB accounts', owner: 'ben', targetValue: 250000,
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
    assert.match(e.reason, /requires builder/i);
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
