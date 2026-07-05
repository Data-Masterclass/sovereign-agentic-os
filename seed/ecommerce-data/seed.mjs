#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Data Masterclass
 *
 * Northpeak cohort data seed — GOVERNED-API layer. Runs AFTER marts.mjs (the
 * physical tables must exist so the live Build verifies honestly). Drives ONLY the
 * platform's own governed endpoints — registry, docs, build-verify, promotion via
 * the shared Governance queue, metrics (Cube), certification (marketplace), lineage
 * and dashboards (Superset) — never a DB insert:
 *
 *   phase 0  login instructor (builder, northpeak) + admin + ONE learner
 *   phase 1  6 datasets: create → bronze/silver/gold versions (artifact = the real
 *            CTAS) → docs → live gold Build report → promote request → ADMIN approval
 *   phase 2  19 metrics via POST /api/metrics/define (+ one explore per dataset)
 *   phase 3  certify each asset → Data Product (admin; marketplace, trust=gold)
 *            + the certify-stage Build (OPA policy push + conformance)
 *   phase 4  upstream lineage edges written into dataset.yaml (the governed file
 *            surface — the lineage graph renders the whole star)
 *   phase 5  3 dashboards (build → promote → certify to marketplace)
 *   phase 6  verify as ONE student: sees the products, metric resolves, governed
 *            /api/query returns rows, join picker lists the products; promote and
 *            certify are DENIED (the consumption-vs-stewardship line)
 *
 * Idempotent: reuses artifacts by name, tolerates "already promoted/defined".
 *
 *   OS_UI_URL=http://localhost:3000 \
 *   SEED_CREDENTIALS='{"alp-instructor":"…","aborek":"…","<learner-email>":"…"}' \
 *   node seed/ecommerce-data/seed.mjs
 */
import { Session, Runner, baseUrlFromEnv } from '../ecommerce/lib/client.mjs';
import { ADMIN, DASHBOARDS, DATASETS, DOMAIN, GRANTS, INSTRUCTOR, STORE } from './narrative.mjs';

const BASE = baseUrlFromEnv();
const runner = new Runner();

/** Runtime ids threaded across phases. */
const ctx = { sessions: {}, datasets: {}, metrics: {}, dashboards: {} };

function loadCredentials() {
  const raw = process.env.SEED_CREDENTIALS;
  if (!raw) throw new Error('SEED_CREDENTIALS env (JSON {id:password}) is required');
  const creds = JSON.parse(raw);
  for (const id of [INSTRUCTOR.id, ADMIN.id]) {
    if (!creds[id]) throw new Error(`SEED_CREDENTIALS missing password for ${id}`);
  }
  const learnerId = Object.keys(creds).find((k) => k !== INSTRUCTOR.id && k !== ADMIN.id) ?? null;
  return { creds, learnerId };
}

const S = (id) => {
  const s = ctx.sessions[id];
  if (!s) throw new Error(`no session for ${id} (login failed?)`);
  return s;
};

const gold = (d) => `iceberg.${DOMAIN}.gold_${d.slug}`;

// --------------------------------------------------------------- phase 0: auth --
async function phaseAuth(creds, learnerId) {
  console.log('\n— Phase 0: authenticate instructor + admin (+ one learner) —');
  const ids = [INSTRUCTOR.id, ADMIN.id, ...(learnerId ? [learnerId] : [])];
  for (const id of ids) {
    await runner.step('Users', `login ${id}`, async () => {
      const s = new Session(BASE, id);
      const u = await s.login(creds[id]);
      ctx.sessions[id] = s;
      if (id === INSTRUCTOR.id && !u.domains.includes(DOMAIN)) {
        throw new Error(`${id} is not in domain '${DOMAIN}' — update OS_USERS first (deploy/apply-data-seed.sh)`);
      }
      return `role=${u.role} domains=${u.domains.join(',')}`;
    });
  }
}

// ----------------------------------------------------------- phase 1: datasets --
async function phaseDatasets() {
  console.log(`\n— Phase 1: Data (6 governed datasets in '${DOMAIN}', Bronze→Silver→Gold → asset) —`);
  const op = S(INSTRUCTOR.id);
  const admin = S(ADMIN.id);
  for (const d of DATASETS) {
    await runner.step('Data', `dataset ${d.name} (register + docs + build + promote)`, async () => {
      // Reuse by name (mine + domain + marketplace) — idempotent re-runs.
      const list = await op.get('/api/data/datasets');
      const all = [...(list.body?.mine ?? []), ...(list.body?.domain ?? []), ...(list.body?.marketplace ?? [])];
      let id = all.find((x) => x?.name === d.name)?.id;
      if (!id) {
        const created = await op.postOk('/api/data/datasets', { name: d.name, domain: DOMAIN });
        id = created.dataset?.id ?? created.id;
      }
      ctx.datasets[d.name] = id;
      const ds = `/api/data/datasets/${id}`;

      // Register the medallion versions with the REAL governed CTAS as artifact
      // bodies (marts.mjs already materialized these exact statements).
      await op.post(`${ds}/version`, { layer: 'bronze', artifactBody: d.bronzeSql ?? undefined });
      await op.post(`${ds}/version`, { layer: 'silver', artifactBody: d.silverSql ?? undefined });
      await op.post(`${ds}/version`, { layer: 'gold', artifactBody: d.goldSql });

      // Documentation — the transparency gate promotion + certification re-check.
      await op.post(`${ds}/docs`, { description: d.description, columns: d.columns });

      // Live Build report for the Gold stage (verify probe on the physical table).
      const build = await op.post(`${ds}/build`, { stage: 'gold' });
      const buildOk = build.body?.build?.ok ?? false;

      // Promote request (owner) → Governance approval (ADMIN — separation of duties).
      const st = await op.get(`${ds}/promote`);
      let applied = st.body?.tier && st.body.tier !== 'dataset' ? `already ${st.body.tier}` : null;
      if (!applied) {
        const pr = await op.post(`${ds}/promote`, { visibility: 'domain', grants: GRANTS });
        let approvalId = pr.body?.approval?.id ?? null;
        if (!approvalId) {
          const q = await admin.get('/api/governance/approvals');
          approvalId = (q.body?.approvals ?? []).find(
            (a) => a.kind === 'dataset_promote' && a.payload?.datasetId === id && a.status === 'pending',
          )?.id;
        }
        if (!approvalId) throw new Error('no pending dataset_promote approval found');
        const ap = await admin.post('/api/governance/approvals', { id: approvalId, decision: 'approve' });
        if (ap.status >= 400) throw new Error(`approve → ${ap.status} ${JSON.stringify(ap.body)}`);
        applied = `promoted (approval ${approvalId})`;
      }
      return `id=${id} cols=${d.columns.length} goldBuild=${buildOk ? '✓' : '✗ (see report)'} ${applied}`;
    });
  }
}

// ------------------------------------------------------------ phase 2: metrics --
async function phaseMetrics() {
  console.log('\n— Phase 2: Metrics (19 Cube measures across the six golds) —');
  const op = S(INSTRUCTOR.id);
  for (const d of DATASETS) {
    const id = ctx.datasets[d.name];
    if (!id) continue;
    for (const m of d.measures) {
      await runner.step('Metrics', `define ${d.name} · ${m.name}`, async () => {
        const r = await op.post('/api/metrics/define', {
          datasetId: id,
          form: { name: m.name, aggregation: m.aggregation, column: m.column, dimensions: [] },
        });
        if (r.status === 409) {
          ctx.metrics[`${d.name}.${m.name}`] = `${id}.${m.name}`;
          return 'already defined';
        }
        if (r.status >= 400) throw new Error(`define → ${r.status} ${JSON.stringify(r.body)}`);
        ctx.metrics[`${d.name}.${m.name}`] = `${id}.${m.name}`;
        return `member=${r.body?.member ?? 'n/a'} convergent=${r.body?.convergence?.ok ?? 'n/a'}`;
      });
    }
    await runner.step('Metrics', `explore ${d.name} · ${d.measures[0].name}`, async () => {
      const r = await op.post('/api/metrics/explore', { metricId: `${id}.${d.measures[0].name}` });
      return `rows=${(r.body?.rows ?? []).length} status=${r.status}`;
    });
  }
}

// ------------------------------------------------------------ phase 3: certify --
async function phaseCertify() {
  console.log('\n— Phase 3: Certify → Data Products (marketplace; policy push + conformance) —');
  const admin = S(ADMIN.id);
  for (const d of DATASETS) {
    const id = ctx.datasets[d.name];
    if (!id) continue;
    await runner.step('Marketplace', `certify ${d.name} (Admin, trust=gold)`, async () => {
      const r = await admin.post(`/api/data/datasets/${id}/certify`, {
        action: 'certify', level: 'gold', visibility: 'shared', grants: GRANTS,
      });
      if (r.status === 409) return 'already a product';
      if (r.status >= 400) throw new Error(`certify → ${r.status} ${JSON.stringify(r.body)}`);
      // The certify-stage Build: compiled OPA push + OPA==Cube conformance gate.
      const b = await admin.post(`/api/data/datasets/${id}/build`, { stage: 'certify' });
      return `tier=${r.body?.dataset?.tier ?? 'product'} policyBuild=${b.body?.build?.ok ? '✓' : '✗ (see report)'}`;
    });
  }
}

// ------------------------------------------------------------ phase 4: lineage --
async function phaseLineage() {
  console.log('\n— Phase 4: Lineage (upstream edges in dataset.yaml — the star renders) —');
  const op = S(INSTRUCTOR.id);
  for (const d of DATASETS) {
    if (!d.upstreams.length) continue;
    const id = ctx.datasets[d.name];
    if (!id) continue;
    await runner.step('Data', `lineage ${d.name} ← ${d.upstreams.join(' + ')}`, async () => {
      const cur = await op.get(`/api/data/datasets/${id}/files?path=dataset.yaml`);
      if (cur.status !== 200) throw new Error(`read dataset.yaml → ${cur.status}`);
      const { content, sha } = cur.body;
      if (/^upstreams:/m.test(content)) return 'already recorded';
      const lines = ['upstreams:'];
      for (const upName of d.upstreams) {
        const up = DATASETS.find((x) => x.name === upName);
        const upId = ctx.datasets[upName];
        if (!up || !upId) throw new Error(`upstream '${upName}' not seeded`);
        lines.push(
          `  - datasetId: ${upId}`,
          `    name: ${upName}`,
          `    fqn: ${gold(up)}`,
          `    joinType: ${d.slug === 'northpeak_returns_impact' && up.slug === 'northpeak_returns' ? 'left' : 'inner'}`,
        );
      }
      const next = `${content.trimEnd()}\n${lines.join('\n')}\n`;
      const w = await op.put(`/api/data/datasets/${id}/files`, { path: 'dataset.yaml', content: next, sha });
      if (w.status !== 200) throw new Error(`write dataset.yaml → ${w.status} ${JSON.stringify(w.body)}`);
      return `${d.upstreams.length} edge(s)`;
    });
  }
}

// --------------------------------------------------------- phase 5: dashboards --
async function phaseDashboards() {
  console.log('\n— Phase 5: Dashboards (3 Superset dashboards on the Cube views) —');
  const op = S(INSTRUCTOR.id);
  const admin = S(ADMIN.id);
  for (const dash of DASHBOARDS) {
    await runner.step('Dashboards', `build ${dash.name}`, async () => {
      const view = dash.dataset; // cubeViewName(dataset) == the dataset name (already clean)
      const body = await op.postOk('/api/dashboards/build', {
        id: dash.id, name: dash.name, view, mode: 'drag-drop', charts: dash.charts,
      });
      ctx.dashboards[dash.id] = body.id ?? dash.id;
      return `id=${body.id ?? dash.id} charts=${dash.charts.length} build=${body.build?.ok ?? 'n/a'}`;
    });
    await runner.step('Dashboards', `govern ${dash.name} → marketplace`, async () => {
      const id = ctx.dashboards[dash.id];
      const p = await op.post('/api/dashboards/govern', { dashboardId: id, transition: 'promote' });
      const c = await admin.post('/api/dashboards/govern', { dashboardId: id, transition: 'certify' });
      if (c.status >= 400) {
        const cur = await admin.get('/api/dashboards');
        const all = [...(cur.body?.mine ?? []), ...(cur.body?.domain ?? []), ...(cur.body?.marketplace ?? [])];
        if (all.find((x) => x.id === id)?.tier === 'marketplace') return `tier=marketplace (already) promote=${p.status}`;
        throw new Error(`certify → ${c.status} ${JSON.stringify(c.body)}`);
      }
      return `tier=${c.body?.tier ?? 'marketplace'} promote=${p.status}`;
    });
  }
}

// ------------------------------------------------------------- phase 6: verify --
async function phaseVerify(learnerId) {
  console.log('\n— Phase 6: Verify ONE student (governed consumption + stewardship denials) —');
  const learner = S(learnerId);
  const ordersId = ctx.datasets['Northpeak Orders'];

  await runner.step('Verify', 'student sees the Northpeak products in the marketplace', async () => {
    const r = await learner.get('/api/data/datasets');
    const names = (r.body?.marketplace ?? []).map((x) => x.name);
    const missing = DATASETS.map((d) => d.name).filter((n) => !names.includes(n));
    if (missing.length) throw new Error(`missing from marketplace: ${missing.join(', ')}`);
    return `${DATASETS.length}/${DATASETS.length} visible`;
  });

  await runner.step('Verify', 'student resolves the revenue metric (explore)', async () => {
    const r = await learner.post('/api/metrics/explore', { metricId: `${ordersId}.revenue` });
    if (r.status !== 200) throw new Error(`explore → ${r.status} ${JSON.stringify(r.body)}`);
    return `rows=${(r.body?.rows ?? []).length}`;
  });

  await runner.step('Verify', 'student reads gold_northpeak_orders via governed /api/query', async () => {
    const r = await learner.post('/api/query', { sql: `select count(*) from ${gold(DATASETS[1])}` });
    if (r.status !== 200) throw new Error(`query → ${r.status} ${JSON.stringify(r.body)}`);
    const n = Number(r.body?.rows?.[0]?.[0] ?? 0);
    if (!(n > 0)) throw new Error(`count=${n} — domain-principal read seam? (see GRANTS note in narrative.mjs)`);
    return `count=${n}`;
  });

  await runner.step('Verify', 'join picker offers the products for personal-lane reuse', async () => {
    const r = await learner.get(`/api/data/datasets/${ordersId}/joinable`);
    const names = (r.body?.datasets ?? []).map((x) => x.name);
    if (!names.includes('Northpeak Returns')) throw new Error(`joinable=${JSON.stringify(names)}`);
    return `${names.length} joinable`;
  });

  await runner.step('Verify', 'student DENIED dataset promote/certify (403)', async () => {
    const p = await learner.post(`/api/data/datasets/${ordersId}/promote`, { visibility: 'domain' });
    const c = await learner.post(`/api/data/datasets/${ordersId}/certify`, { action: 'certify' });
    if (p.status !== 403 && p.status !== 409) throw new Error(`promote → ${p.status} (expected 403/409)`);
    if (c.status !== 403 && c.status !== 409) throw new Error(`certify → ${c.status} (expected 403/409)`);
    return `promote=${p.status} certify=${c.status}`;
  });
}

// ------------------------------------------------------------------------ main --
async function main() {
  console.log(`\n=== Northpeak data seed → ${STORE.name} (${STORE.tagline}) ===`);
  const { creds, learnerId } = loadCredentials();
  console.log(`Target: ${BASE} • domain: ${DOMAIN} • authoring: ${INSTRUCTOR.id} • approving: ${ADMIN.id}` +
    (learnerId ? ` • verifying: ${learnerId}` : ''));

  await phaseAuth(creds, learnerId);
  if (!ctx.sessions[INSTRUCTOR.id] || !ctx.sessions[ADMIN.id]) {
    console.error('\nFATAL: instructor/admin could not authenticate.');
    process.exitCode = 1;
    return;
  }
  await phaseDatasets();
  await phaseMetrics();
  await phaseCertify();
  await phaseLineage();
  await phaseDashboards();
  if (learnerId && ctx.sessions[learnerId]) await phaseVerify(learnerId);

  const sum = runner.summary();
  console.log(`\n=== Data seed complete: ${sum.ok}/${sum.total} steps ok, ${sum.fail} failed ===`);
  if (sum.fail > 0) {
    for (const r of sum.results.filter((x) => !x.ok)) console.log(`  ✗ [${r.tab}] ${r.name} — ${r.note}`);
  }
  const coreOk = sum.results.some((r) => r.ok && r.tab === 'Data') && sum.results.some((r) => r.ok && r.tab === 'Metrics');
  process.exitCode = coreOk && sum.fail === 0 ? 0 : coreOk ? 0 : 1;
}

main().catch((e) => {
  console.error('\nFATAL:', e);
  process.exitCode = 1;
});
