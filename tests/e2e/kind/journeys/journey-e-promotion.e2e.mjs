/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    AT-e journey-e-promotion.e2e — a dataset promoted My → Domain → Company
 * USER STORY: As the owner I want proof that each rung of the scope ladder is an OPA decision with
 *             a tamper-evident audit row, that Trino's access changes exactly when the approved
 *             policy revision reaches Trino's OPA sidecar, and that promotion keeps the dataset's
 *             Iceberg history.
 * ARCHITECTURE:
 *   - Authoritative: 09 §5 AT-e; MASTER-PLAN Part 2 §C row AT-e; 10 F3/F12/F16; 11 A12–A15.
 *   - Records: os_governance.audit_events (OS row; hash chain recomputed here) joined to OPA's
 *     decision log by decision_id, OPA status reports (active_revision), Trino query outcomes as
 *     each principal, Iceberg FOR VERSION AS OF, `opa test` on the policy sources.
 *   - The ladder is ONE memoised step that records Trino outcomes at each phase, because "denied
 *     before, allowed after" needs observations taken in order.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { journey, check } from '../lib/journey.mjs';
import { PRINCIPALS, DOMAIN, OTHER_DOMAIN, waitFor } from '../lib/common.mjs';
import { callTool } from '../lib/os-driver.mjs';
import * as trino from '../lib/records/trino.mjs';
import * as opa from '../lib/records/opa.mjs';
import * as pg from '../lib/records/postgres.mjs';
import { baseUrl } from '../lib/endpoints.mjs';
import { chartImage } from '../lib/chart.mjs';
import { request } from '../lib/http.mjs';
import { HopError } from '../lib/hop.mjs';

const { U, A, B, C, S2, OTHER, V } = PRINCIPALS;
const J = journey('AT-e', 'journey-e-promotion');
const exec = promisify(execFile);
const REPO_ROOT = new URL('../../../../', import.meta.url);

async function canRead(user, table) {
  try { await trino.query(`select count(*) from ${table}`, { user, hop: `read as ${user}` }); return true; } catch (err) {
    if (/ACCESS_DENIED|PERMISSION_DENIED|Access Denied/i.test(err.reason ?? '')) return false;
    throw err;
  }
}

async function createDataset(name) {
  const ds = await callTool(U, 'create_dataset', { name, domain: DOMAIN, scope: 'my', sql: "select 'PO-1' as po_number, 'DE' as region union all select 'PO-2', 'FR'" });
  await callTool(U, 'document_dataset', { datasetId: ds.id, description: `AT-e fixture ${name}`, columns: { po_number: 'purchase order', region: 'sales region' } });
  return ds;
}

/** Run the whole ladder once, observing Trino access at each phase. */
const ladder = () => J.step('ladder', async () => {
  const ds = await createDataset('e2e_promo_1');
  const before = await trino.snapshots('iceberg', ds.schema, ds.table);
  check(before.length > 0, 'trino', 'the My-scope table has a snapshot before promotion', 0);
  const preSnapshot = before.at(-1).snapshot_id;
  const fq = () => `iceberg.${ds.promotedSchema ?? DOMAIN}.${ds.table}`;
  const obs = { preSnapshot, phases: {} };
  obs.phases.my = { s2: await canRead(S2, `iceberg.${ds.schema}.${ds.table}`), other: await canRead(OTHER, `iceberg.${ds.schema}.${ds.table}`) };

  const req = await callTool(U, 'request_promotion', { kind: 'dataset', id: ds.id });
  const approved = await callTool(A, 'approve_promotion', { approvalId: req.approvalId ?? req.id });
  obs.approved = approved;
  obs.phases.domain = await waitFor(async () => {
    const r = { s2: await canRead(S2, fq()), other: await canRead(OTHER, fq()) };
    return r.s2 ? r : null;
  }, { component: 'trino', hop: 'read after approval', what: `${S2} allowed on the promoted table`, timeoutMs: 120000 });

  const cert = await callTool(A, 'request_certification', { kind: 'dataset', id: ds.id });
  await callTool(C, 'decide_approval', { requestId: cert.requestId ?? cert.id, decision: 'approve' });
  obs.phases.company = await waitFor(async () => {
    const r = { s2: await canRead(S2, fq()), other: await canRead(OTHER, fq()) };
    return r.other ? r : null;
  }, { component: 'trino', hop: 'read after certification', what: `${OTHER} allowed after certification`, timeoutMs: 120000 });
  return { ds, req, cert, obs, table: fq() };
});

// ---------------------------------------------------------------- 1. audit chain + decision logs
J.assertion('e1.1', { hop: 'three audit_events rows whose prev_hash chain recomputes', record: 'os_governance.audit_events (recomputed sha256 chain)', expectedFail: 'WP-07' }, async () => {
  const { ds } = await ladder();
  const rows = await pg.rows('os_governance', `select seq, prev_hash, hash, decision_id, payload::text as payload from audit_events where resource_id = '${ds.id}' and action in ('promotion.request','promotion.approve','certification.approve') order by seq`);
  check(rows.length === 3, 'postgres', 'request, approve and certify rows', rows.length);
  const all = await pg.rows('os_governance', `select seq, prev_hash, hash, payload::text as payload from audit_events where seq <= ${rows.at(-1).seq} order by seq`);
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    const want = createHash('sha256').update(`${r.prev_hash ?? ''}${r.payload}`).digest('hex');
    check(r.hash === want, 'postgres', `row ${r.seq} hash = sha256(prev_hash || payload)`, { stored: r.hash, recomputed: want });
    if (i > 0) check(r.prev_hash === all[i - 1].hash, 'postgres', `row ${r.seq} prev_hash links to row ${all[i - 1].seq}`, r.prev_hash);
  }
});

J.assertion('e1.2', { hop: "each audit row's decision_id is in OPA's decision log", record: 'OPA decision log (VictoriaLogs)', expectedFail: 'WP-06' }, async () => {
  const { ds } = await ladder();
  const rows = await pg.rows('os_governance', `select decision_id from audit_events where resource_id = '${ds.id}' order by seq`);
  check(rows.length >= 3, 'postgres', 'three audit rows with decision ids', rows.length);
  for (const { decision_id: id } of rows) {
    const d = await opa.decisionById(id);
    check(d, 'opa', `decision ${id} present in the decision log`, null);
  }
});

// ---------------------------------------------------------------- 2. the approved revision reaches Trino's sidecar
J.assertion('e2.1', { hop: "Trino sidecar /health?bundles 200 and active_revision = the revision published after approval", record: 'OPA health API + status reports', expectedFail: 'WP-12' }, async () => {
  const { ds } = await ladder();
  const { status } = await request('opa', 'health?bundles (trino sidecar)', `${await baseUrl('trinoOpaSidecar')}/health?bundles`, { okStatus: [500] });
  check(status === 200, 'opa', '/health?bundles is 200', status);
  const [row] = await pg.rows('os_governance', `select policy_rev from audit_events where resource_id = '${ds.id}' and action = 'promotion.approve'`);
  check(row?.policy_rev, 'postgres', 'the approval row names the published policy revision', row);
  const st = await opa.latestStatus({ instanceLabel: process.env.E2E_TRINO_SIDECAR_ID ?? 'trino-opa-sidecar' });
  const active = Object.values(st.bundles ?? {}).map((b) => b.active_revision);
  check(active.includes(row.policy_rev), 'opa', `sidecar active_revision includes ${row.policy_rev}`, active);
});

// ---------------------------------------------------------------- 3. access follows the ladder
J.assertion('e3.1', { hop: 'another sales member: denied before approval, allowed after', record: 'Trino query outcome as u124', expectedFail: 'WP-37' }, async () => {
  const { obs } = await ladder();
  check(obs.phases.my.s2 === false, 'trino', `${S2} denied in My scope`, obs.phases.my);
  check(obs.phases.domain.s2 === true, 'trino', `${S2} allowed after approval`, obs.phases.domain);
});

J.assertion('e3.2', { hop: 'another domain: denied until certification, allowed after', record: 'Trino query outcome as u999', expectedFail: 'WP-37' }, async () => {
  const { obs } = await ladder();
  check(obs.phases.my.other === false && obs.phases.domain.other === false, 'trino', `${OTHER} (${OTHER_DOMAIN}) denied before certification`, obs.phases);
  check(obs.phases.company.other === true, 'trino', `${OTHER} allowed after certification`, obs.phases.company);
});

// ---------------------------------------------------------------- 4. history survives promotion
J.assertion('e4.1', { hop: 'a pre-promotion snapshot resolves FOR VERSION AS OF on the promoted table', record: 'Trino Iceberg time travel', expectedFail: 'WP-37' }, async () => {
  const { obs, table } = await ladder();
  const r = await trino.query(`select count(*) as n from ${table} for version as of ${obs.preSnapshot}`, { user: A, hop: 'for version as of' });
  check(Number(r.rows[0]?.n) === 2, 'trino', `snapshot ${obs.preSnapshot} readable on ${table} with the 2 original rows`, r.rows);
});

// ---------------------------------------------------------------- 5. Rego unit: promoting dataset 2 keeps dataset 1's row filter
J.assertion('e5.1', { hop: "Rego unit test: promoting dataset 2 leaves dataset 1's row filter unchanged", record: 'opa test (policy sources, chart-pinned OPA image)', expectedFail: 'WP-11' }, async () => {
  const image = await chartImage('opa.image');
  const policies = new URL('charts/sovereign-agentic-os/policies', REPO_ROOT).pathname;
  const tests = new URL('tests/policies', REPO_ROOT).pathname;
  let out;
  try {
    ({ stdout: out } = await exec('docker', ['run', '--rm', '-v', `${policies}:/p:ro`, '-v', `${tests}:/t:ro`, image, 'test', '/p', '/t', '-v', '--run', 'test_promote_second_dataset_keeps_first_row_filter']));
  } catch (err) {
    throw new HopError({ component: 'opa', hop: 'opa test', reason: (err.stdout || err.stderr || err.message).trim().slice(0, 300) });
  }
  check(/PASS/.test(out) && !/no tests found|FAIL/i.test(out), 'opa', 'the named Rego test exists and passes', out.slice(0, 300));
});

// ---------------------------------------------------------------- negative twins
async function rowFilterFor(viewer, table) {
  const r = await trino.query(`select region from ${table} order by region`, { user: viewer, hop: `row-filtered read as ${viewer}` });
  return r.rows.map((x) => x.region).join(',');
}
let baseline = null;
J.twin('e-twin-1', { disables: 'dataset 2 promoted in the same domain', record: "Trino result for dataset 1 as V + OPA row-filter decision", expect: 'green', expectedFail: 'WP-11' }, {
  check: async () => {
    const { table } = await ladder();
    const now = await rowFilterFor(V, table);
    baseline ??= now;
    check(now === baseline, 'trino', "dataset 1's row filter result for V unchanged", { baseline, now });
    const ds = await opa.decisions({ sinceMinutes: 5, match: (e) => e.input?.action?.operation === 'GetRowFilters' && JSON.stringify(e.input).includes(table.split('.').at(-1)) });
    check(ds.length > 0, 'opa', 'a GetRowFilters decision for dataset 1', 0);
  },
  disable: async () => {
    const ds2 = await createDataset('e2e_promo_2');
    const req = await callTool(U, 'request_promotion', { kind: 'dataset', id: ds2.id });
    await callTool(A, 'approve_promotion', { approvalId: req.approvalId ?? req.id });
  },
});

let approver = A;
J.twin('e-twin-2', { disables: 'a builder (not the domain admin) approves', record: 'OS refusal carrying the OPA reason', expectedFail: 'WP-29', redReasonMust: /approver_role_required/ }, {
  check: async () => {
    const ds = await createDataset(`e2e_promo_t${Date.now().toString(36)}`);
    const req = await callTool(U, 'request_promotion', { kind: 'dataset', id: ds.id });
    await callTool(approver, 'approve_promotion', { approvalId: req.approvalId ?? req.id });
  },
  disable: async () => { approver = B; },
  restore: async () => { approver = A; },
});
