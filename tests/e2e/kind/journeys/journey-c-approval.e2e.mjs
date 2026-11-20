/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    AT-c journey-c-approval.e2e — held domain write → interrupt → worker deleted →
 *             domain admin approves → resume → the write runs as the user → one trace
 * USER STORY: As the owner I want proof that an agent's domain-scope write waits for a domain
 *             admin, survives the worker pod being deleted, and, once approved, is executed in
 *             Trino AS the requesting user (and denied to that user before approval), with one
 *             Langfuse trace showing both run segments and the approval.
 * ARCHITECTURE:
 *   - Authoritative: 09 §5 AT-c; MASTER-PLAN Part 2 §C row AT-c; 10 F2/F3.
 *   - Records: Postgres (approvals, run_jobs, LangGraph checkpoints, os_grants.run_grants — OS rows,
 *     always paired with a component record), Kubernetes (pod replaced), Trino
 *     system.runtime.queries + "$snapshots", OPA decision log, Langfuse observations.
 */
import { journey, check } from '../lib/journey.mjs';
import { PRINCIPALS, DOMAIN, createTraceId, waitFor, isoNow } from '../lib/common.mjs';
import { callTool } from '../lib/os-driver.mjs';
import * as stub from '../lib/records/stub.mjs';
import * as trino from '../lib/records/trino.mjs';
import * as opa from '../lib/records/opa.mjs';
import * as pg from '../lib/records/postgres.mjs';
import * as langfuse from '../lib/records/langfuse.mjs';
import * as keycloak from '../lib/records/keycloak.mjs';
import { kubectl, getJson, NS } from '../lib/kube.mjs';
import { HopError } from '../lib/hop.mjs';

const { U, A } = PRINCIPALS;
const J = journey('AT-c', 'journey-c-approval');
const TABLE = { catalog: 'iceberg', schema: DOMAIN, table: 'suppliers' };
const WORKER_SELECTOR = process.env.E2E_WORKER_SELECTOR ?? 'app.kubernetes.io/component=os-ui-worker';
const trinoTs = (iso) => iso.replace('T', ' ').slice(0, 19);
const allowed = (e) => e.result === true || e.result?.allow === true;

const SCRIPT = (supplier) => [
  { reply: { tool_calls: [{ name: 'write_dataset_row', arguments: { table: `${TABLE.schema}.${TABLE.table}`, scope: 'domain', row: { supplier_id: supplier, name: `Supplier ${supplier}`, country: 'DE' } } }] } },
  { reply: { content: `Supplier ${supplier} onboarded.` } },
];

// ---------------------------------------------------------------- the flow (each call is a fresh run)
const system = () => J.step('system', () => callTool(U, 'create_agent_system', { name: 'Supplier onboarding', domain: DOMAIN, template: 'recommend' }));

async function park(supplier) {
  await stub.reset();
  await stub.loadScript(SCRIPT(supplier));
  const { id: systemId } = await system();
  const startedAt = isoNow();
  const run = await callTool(U, 'run_agent_system', { systemId, message: `Onboard supplier ${supplier}` });
  check(run?.runId, 'os-ui', 'run_agent_system returns a runId', run);
  const job = await waitFor(async () => (await pg.rows('agent_runs', `select id, status from run_jobs where id = '${run.runId}'`)).find((r) => r.status === 'parked'),
    { component: 'postgres', hop: 'run_jobs', what: `run ${run.runId} parked`, timeoutMs: 180000 });
  return { run, job, startedAt, supplier };
}

async function deleteWorker() {
  const before = (await getJson('pods', null, NS)).items.filter((p) => p.metadata.labels?.['app.kubernetes.io/component'] === 'os-ui-worker').map((p) => p.metadata.uid);
  check(before.length > 0, 'kubernetes', 'an os-ui-worker pod is running', 0);
  await kubectl(['-n', NS, 'delete', 'pod', '-l', WORKER_SELECTOR, '--wait=true']);
  await kubectl(['-n', NS, 'wait', '--for=condition=Ready', 'pod', '-l', WORKER_SELECTOR, '--timeout=300s'], { timeoutMs: 320000 });
  const after = (await getJson('pods', null, NS)).items.filter((p) => p.metadata.labels?.['app.kubernetes.io/component'] === 'os-ui-worker' && p.status.phase === 'Running').map((p) => p.metadata.uid);
  return { before, after };
}

async function approvalFor(runId) {
  const rows = await pg.rows('os_governance', `select id, interrupt_id, status, approver from approvals where run_id = '${runId}'`);
  check(rows.length === 1, 'postgres', `exactly one approval card for run ${runId}`, rows.length);
  return rows[0];
}

async function waitDone(runId) {
  return waitFor(async () => (await pg.rows('agent_runs', `select status from run_jobs where id = '${runId}'`)).find((r) => ['done', 'failed'].includes(r.status)),
    { component: 'postgres', hop: 'run_jobs', what: `run ${runId} settled`, timeoutMs: 300000 });
}

async function writeQueries(user, since, supplier) {
  return (await trino.runtimeQueries({ user, textLike: supplier, sinceMinutes: 60 })).filter((q) => q.created >= trinoTs(since) && /insert|merge/i.test(q.query));
}

/** Full path: park → delete worker → (deny check) → approve → resume → settled. */
async function approvedFlow({ deactivateBeforeApproval = false } = {}) {
  const supplier = `S-${Date.now().toString(36)}`;
  const parked = await park(supplier);
  const snapsBefore = (await trino.snapshots(TABLE.catalog, TABLE.schema, TABLE.table)).length;
  const workers = await deleteWorker();
  const card = await approvalFor(parked.run.runId);
  if (deactivateBeforeApproval) await keycloak.setEnabled(U, false);
  try {
    await callTool(A, 'decide_approval', { requestId: card.id, decision: 'approve' });
    const settled = await waitDone(parked.run.runId);
    return { ...parked, workers, card, settled, snapsBefore };
  } finally {
    if (deactivateBeforeApproval) await keycloak.setEnabled(U, true);
  }
}
const main = () => J.step('approved flow', () => approvedFlow());

// ---------------------------------------------------------------- 1. interrupt and park
J.assertion('c1.1', { hop: 'one __interrupt__, one card keyed by interrupt id, run parked, checkpoint row', record: 'LangGraph checkpoint (agent_runs) + approvals + run_jobs', expectedFail: 'WP-27' }, async () => {
  const { run, card } = await main();
  const writes = await pg.rows('agent_runs', `select channel, count(*)::int as n from checkpoint_writes where thread_id = '${run.runId}' and channel = '__interrupt__' group by channel`);
  check(writes[0]?.n === 1, 'langgraph', 'exactly one __interrupt__ write in the checkpoint', writes);
  check(card.interrupt_id, 'postgres', 'the approval card is keyed by the interrupt id', card);
  const cps = await pg.rows('agent_runs', `select checkpoint_id from checkpoints where thread_id = '${run.runId}'`);
  check(cps.length > 0, 'langgraph', 'PostgresSaver holds checkpoint rows for the run', 0);
});

// ---------------------------------------------------------------- 2. worker deleted
J.assertion('c2.1', { hop: 'the worker pod is deleted and a new one takes over', record: 'Kubernetes pods', expectedFail: 'WP-28' }, async () => {
  const { workers, settled } = await main();
  check(workers.after.length > 0 && workers.after.every((u) => !workers.before.includes(u)), 'kubernetes', 'running worker pods are new (different uids)', workers);
  check(settled.status === 'done', 'postgres', 'the run settled done after the restart', settled);
});

// ---------------------------------------------------------------- 3. denied before approval
J.assertion('c3.1', { hop: 'before approval a direct Trino write as u123 is denied', record: 'Trino error + OPA decision log', expectedFail: 'WP-36' }, async () => {
  const { supplier } = await park(`S-pre-${Date.now().toString(36)}`);
  let denied = null;
  try {
    await trino.query(`insert into ${TABLE.catalog}.${TABLE.schema}.${TABLE.table} (supplier_id, name, country) values ('${supplier}', 'direct', 'DE')`, { user: U, hop: 'direct write as u123' });
  } catch (err) {
    denied = err;
  }
  check(denied && /ACCESS_DENIED|PERMISSION_DENIED|Access Denied/i.test(denied.reason ?? ''), 'trino', 'direct write as u123 rejected with an access error', denied?.reason ?? 'write succeeded');
  const ds = await opa.decisions({ sinceMinutes: 10, match: (e) => e.input?.context?.identity?.user === U && /Insert/i.test(e.input?.action?.operation ?? '') && !allowed(e) });
  check(ds.length > 0, 'opa', 'a deny decision for the insert as u123', 0);
});

// ---------------------------------------------------------------- 4. approved write as the user
J.assertion('c4.1', { hop: 'after approval the write runs in Trino as u123', record: 'Trino system.runtime.queries', expectedFail: 'WP-36' }, async () => {
  const { startedAt, supplier } = await main();
  const qs = await writeQueries(U, startedAt, supplier);
  check(qs.some((q) => q.state === 'FINISHED'), 'trino', `a FINISHED write with user=${U} naming ${supplier}`, qs.map((q) => q.state));
});

J.assertion('c4.2', { hop: '$snapshots gained one row', record: 'Trino Iceberg $snapshots', expectedFail: 'WP-36' }, async () => {
  const { snapsBefore } = await main();
  const after = (await trino.snapshots(TABLE.catalog, TABLE.schema, TABLE.table)).length;
  check(after === snapsBefore + 1, 'trino', 'exactly one new snapshot', { before: snapsBefore, after });
});

J.assertion('c4.3', { hop: 'approved-write grant recorded and published to OPA', record: 'os_grants.run_grants + OPA decision log', expectedFail: 'WP-11' }, async () => {
  const { run, card } = await main();
  const grants = await pg.rows('os_governance', `select id, kind, approval_id from os_grants.run_grants where run_id = '${run.runId}'`);
  const g = grants.find((x) => x.kind === 'approved_write' && x.approval_id === card.id);
  check(g, 'postgres', 'run_grants has the approved-write entry for this approval', grants);
  const ds = await opa.decisions({ match: (e) => JSON.stringify(e.input ?? {}).includes(g.id) && allowed(e) });
  check(ds.length > 0, 'opa', `an allow decision that used grant ${g.id}`, 0);
});

// ---------------------------------------------------------------- 5. one trace
J.assertion('c5.1', { hop: 'one root, run segment 1 and 2, approval event with the approver uid', record: 'Langfuse Observations v2', expectedFail: 'WP-31' }, async () => {
  const { run } = await main();
  const obs = await langfuse.observations({ traceId: createTraceId(run.runId) });
  check(langfuse.roots(obs).length === 1, 'langfuse', 'exactly one root observation', langfuse.roots(obs).length);
  const root = langfuse.roots(obs)[0];
  const segs = obs.filter((o) => /^run segment [12]$/.test(o.name) && o.parentObservationId === root.id).map((o) => o.name).sort();
  check(JSON.stringify(segs) === '["run segment 1","run segment 2"]', 'langfuse', 'run segment 1 and 2 under the root', segs);
  const approval = obs.find((o) => o.type === 'EVENT' && o.name === 'approval');
  check(approval && JSON.stringify(approval.metadata ?? {}).includes(A), 'langfuse', `approval event carrying approver ${A}`, approval?.metadata);
});

// ---------------------------------------------------------------- negative twins
let deactivate = false;
J.twin('c-twin-1', { disables: 'U deactivated in Keycloak before approval', record: 'run_jobs + Trino $snapshots', expectedFail: 'WP-38', redReasonMust: /principal_inactive/ }, {
  check: async () => {
    const r = await approvedFlow({ deactivateBeforeApproval: deactivate });
    const errs = await pg.rows('agent_runs', `select error from run_jobs where id = '${r.run.runId}'`);
    if (r.settled.status !== 'done') throw new HopError({ component: 'os-ui-worker', hop: 'resume', reason: errs[0]?.error ?? r.settled.status });
    const after = (await trino.snapshots(TABLE.catalog, TABLE.schema, TABLE.table)).length;
    check(after === r.snapsBefore + 1, 'trino', 'the approved write changed the table', { before: r.snapsBefore, after });
  },
  disable: async () => { deactivate = true; },
  restore: async () => { deactivate = false; },
});

// While parked, the policy bundle flips to "not held"; A then REJECTS: the tool must still never run.
const HOLDS_CM = process.env.E2E_HOLDS_CONFIGMAP ?? 'opa-os-data-holds';
let flipBundle = false;
let savedHolds;
J.twin('c-twin-2', { disables: 'bundle flipped to "not held" while the run is parked, then A rejects', record: 'Trino system.runtime.queries + $snapshots', expect: 'green', expectedFail: 'WP-27' }, {
  check: async () => {
    const parked = await park(`S-rej-${Date.now().toString(36)}`);
    const snapsBefore = (await trino.snapshots(TABLE.catalog, TABLE.schema, TABLE.table)).length;
    if (flipBundle) {
      const cm = JSON.parse(await kubectl(['-n', NS, 'get', 'configmap', HOLDS_CM, '-o', 'json']));
      savedHolds = cm.data;
      const data = Object.fromEntries(Object.entries(cm.data).map(([k, v]) => [k, v.replace(/"held"\s*:\s*true/g, '"held": false')]));
      await kubectl(['-n', NS, 'apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: HOLDS_CM, namespace: NS }, data }) });
    }
    const card = await approvalFor(parked.run.runId);
    await callTool(A, 'decide_approval', { requestId: card.id, decision: 'deny' });
    await waitDone(parked.run.runId);
    const qs = await writeQueries(U, parked.startedAt, parked.supplier);
    check(qs.length === 0, 'trino', 'no write query for the rejected call', qs.length);
    const after = (await trino.snapshots(TABLE.catalog, TABLE.schema, TABLE.table)).length;
    check(after === snapsBefore, 'trino', 'table unchanged after rejection', { before: snapsBefore, after });
  },
  disable: async () => { flipBundle = true; },
  restore: async () => {
    flipBundle = false;
    if (savedHolds) await kubectl(['-n', NS, 'apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: HOLDS_CM, namespace: NS }, data: savedHolds }) });
  },
});
