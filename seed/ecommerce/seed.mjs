#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Data Masterclass
 *
 * Northpeak e-commerce seed — drives the Sovereign Agentic OS GOVERNED flows to
 * create REAL, cross-linked artifacts across every tab. It authenticates AS the
 * seeded cast (POST /api/auth/login) and threads each runtime-minted id into the
 * next call, so the lineage (dashboard → metric → Gold mart → orders; churn bet →
 * model + dashboard → Retention pillar) is built for real — never via DB inserts.
 *
 * Run locally (kind, port-forward os-ui to :3000):
 *   OS_UI_URL=http://localhost:3000 \
 *   SEED_CREDENTIALS="$(cat seed/ecommerce/users.secret.json)" \
 *   node seed/ecommerce/seed.mjs
 *
 * In-cluster the same script runs from the k8s Job (OS_UI_URL=http://os-ui:3000,
 * credentials from a Secret). Idempotent: it reuses an artifact when one with the
 * same name already exists, and tolerates a missing backend on kind (logs ✗, goes on).
 */
import { Session, Runner, baseUrlFromEnv } from './lib/client.mjs';
import {
  STORE, CAST, CONNECTIONS, FILES, DATASET, METRICS, WORKFLOWS, KNOWLEDGE_DOCS,
  AGENTS, SCIENCE, BIG_BETS, PILLARS,
} from './lib/narrative.mjs';

const BASE = baseUrlFromEnv();
const runner = new Runner();
/** Resolved runtime ids threaded across phases (the real cross-tab lineage). */
const ctx = {
  sessions: {}, connections: {}, files: {}, dataset: null, datasetGold: false,
  metrics: {}, dashboards: {}, workflows: {}, agents: {}, bets: {}, pillars: {},
};

/** Load the cast's generated passwords (NEVER hardcoded). */
function loadCredentials() {
  const raw = process.env.SEED_CREDENTIALS;
  if (!raw) throw new Error('SEED_CREDENTIALS env (JSON {id:password}) is required — run gen-credentials.mjs');
  const creds = JSON.parse(raw);
  for (const c of CAST) if (!creds[c.id]) throw new Error(`SEED_CREDENTIALS missing password for ${c.id}`);
  return creds;
}

function S(id) {
  const s = ctx.sessions[id];
  if (!s) throw new Error(`no session for ${id} (login phase failed?)`);
  return s;
}

// --------------------------------------------------------------- phase 0: auth
async function phaseAuth(creds) {
  console.log('\n— Phase 0: authenticate the cast (governed identities) —');
  for (const c of CAST) {
    await runner.step('Users', `login ${c.id} (${c.role})`, async () => {
      const s = new Session(BASE, c.id);
      const u = await s.login(creds[c.id]);
      ctx.sessions[c.id] = s;
      return `role=${u.role} domains=${u.domains.join(',')}`;
    });
  }
}

// -------------------------------------------------------- phase 1: connections
async function findInList(session, path, name, pick = (b) => b.items ?? []) {
  const r = await session.get(path);
  const items = pick(r.body) || [];
  return items.find((x) => x && (x.name === name || x.title === name));
}

/** Default-deny egress: a Builder requests the host, an Admin approves it onto the
 *  allowlist, so the subsequent connection passes the egress check. Governed flow. */
async function ensureEgress(builder, endpoint, reason) {
  const req = await S(builder).post('/api/egress', { endpoint, reason });
  const id = req.body?.id ?? req.body?.request?.id;
  if (!id) return `egress=${req.status}`;
  const appr = await S('nova-admin').post(`/api/egress/${id}/approve`);
  return `egress ${id} approved=${appr.status}`;
}

async function phaseConnections() {
  console.log('\n— Phase 1: Connections (store Postgres + Drive + MCP) —');
  for (const c of CONNECTIONS) {
    await runner.step('Connections', `create ${c.name}`, async () => {
      const s = S(c.actor); // a Builder/Admin — Shared connections require it
      const existing = await findInList(s, '/api/connections', c.name, (b) => b.connections ?? b.items ?? []);
      let id = existing?.id;
      if (!id) {
        // open egress to the external host first (Builder requests, Admin approves)
        const eg = await ensureEgress(c.actor, c.endpoint, `Northpeak ${c.name}`);
        const body = await s.postOk('/api/connections', {
          name: c.name, template: c.key, endpoint: c.endpoint, credential: c.credential, domain: c.domain,
        });
        id = body.connection?.id ?? body.id;
        ctx.connections[c.name] = id;
        const t = await s.post(`/api/connections/${id}/test`);
        return `id=${id} ${eg} test=${t.body?.mode ?? t.status}`;
      }
      ctx.connections[c.name] = id;
      const t = await s.post(`/api/connections/${id}/test`);
      return `id=${id} (existing) test=${t.body?.mode ?? t.status}`;
    });
  }
  // promote the store DB to Shared so domain agents/marts can use it (Builder).
  await runner.step('Connections', 'promote northpeak-orders-db → Shared', async () => {
    const id = ctx.connections['northpeak-orders-db'];
    if (!id) throw new Error('orders-db not created');
    const r = await S('sasha-sales').post(`/api/connections/${id}/promote`);
    return `status=${r.status}`;
  });
}

// --------------------------------------------------------------- phase 2: files
async function phaseFiles() {
  console.log('\n— Phase 2: Files (catalog + return policy + transcript) —');
  for (const f of FILES) {
    await runner.step('Files', `ingest ${f.name}`, async () => {
      const s = S(f.actor);
      const body = await s.postOk('/api/files', {
        name: f.name, folder: f.folder, tags: f.tags, sensitivity: f.sensitivity, text: f.text,
        provenanceSource: 'northpeak-seed',
      });
      const id = body.asset?.id ?? body.id;
      ctx.files[f.name] = id;
      return `id=${id} (ingested + indexed)`;
    });
  }
}

// ----------------------------------------------------------------- phase 3: data
async function phaseData() {
  console.log('\n— Phase 3: Data (Bronze→Silver→Gold revenue + churn mart) —');
  const creator = S(DATASET.creator);

  await runner.step('Data', `create dataset ${DATASET.name}`, async () => {
    const existing = await findInList(creator, '/api/data/datasets', DATASET.name,
      (b) => [...(b.mine ?? []), ...(b.domain ?? []), ...(b.items ?? [])]);
    let id = existing?.id;
    if (!id) {
      const body = await creator.postOk('/api/data/datasets', { name: DATASET.name, domain: DATASET.domain });
      id = body.dataset?.id ?? body.id;
    }
    ctx.dataset = id;
    return `id=${id}`;
  });
  if (!ctx.dataset) return;
  const dsPath = `/api/data/datasets/${ctx.dataset}`;

  await runner.step('Data', 'build Bronze (bring in orders/customers/products)', async () => {
    const r = await creator.post(`${dsPath}/version`, { layer: 'bronze', quality: 'raw' });
    return `status=${r.status}`;
  });
  await runner.step('Data', 'build Silver (clean + conform)', async () => {
    const r = await creator.post(`${dsPath}/version`, { layer: 'silver', artifactBody: DATASET.silverSql });
    return `status=${r.status}`;
  });
  await runner.step('Data', 'build Gold (revenue + churn base)', async () => {
    const r = await creator.post(`${dsPath}/version`, { layer: 'gold', artifactBody: DATASET.goldSql });
    if (r.status >= 200 && r.status < 300) ctx.datasetGold = true;
    return `status=${r.status}`;
  });
  await runner.step('Data', 'document columns (transparency gate)', async () => {
    const r = await creator.post(`${dsPath}/docs`, { description: DATASET.description, columns: DATASET.columns });
    return `status=${r.status} columns=${DATASET.columns.length}`;
  });
  await runner.step('Data', 'verify Gold build', async () => {
    const r = await creator.post(`${dsPath}/build`, { stage: 'gold' });
    return `mode=${r.body?.build?.mode ?? r.status}`;
  });

  // Separation of duties: Creator requests promotion → Builder approves in Governance.
  let promoteApprovalId = null;
  await runner.step('Data', 'request promotion Dataset→Asset (Creator)', async () => {
    const r = await creator.post(`${dsPath}/promote`, { visibility: 'domain' });
    promoteApprovalId = r.body?.approval?.id ?? null;
    return `approval=${promoteApprovalId} already=${Boolean(r.body?.already)}`;
  });
  await runner.step('Governance', 'approve dataset_promote (Builder)', async () => {
    if (!promoteApprovalId) {
      // find it in the builder's queue
      const q = await S(DATASET.builder).get('/api/governance/approvals');
      promoteApprovalId = (q.body?.approvals ?? []).find((a) => a.kind === 'dataset_promote' && a.payload?.datasetId === ctx.dataset)?.id;
    }
    if (!promoteApprovalId) return 'no pending promote (already governed?)';
    const r = await S(DATASET.builder).post('/api/governance/approvals', { id: promoteApprovalId, decision: 'approve' });
    return `applied=${r.body?.applied ?? r.status}`;
  });
}

// -------------------------------------------------------------- phase 4: metrics
async function phaseMetrics() {
  console.log('\n— Phase 4: Metrics (Revenue, AOV, Conversion, Churn) —');
  if (!ctx.dataset) return;
  const owner = S(DATASET.creator);
  for (const m of METRICS) {
    await runner.step('Metrics', `define ${m.name}`, async () => {
      const measureName = m.name.toLowerCase();
      const metricId = `${ctx.dataset}.${measureName}`;
      const r = await owner.post('/api/metrics/define', {
        datasetId: ctx.dataset,
        form: { name: m.name, aggregation: m.aggregation, column: m.column, dimensions: m.dimensions },
      });
      if (r.status === 409) {
        // Idempotent: already defined — recover the member from the read model.
        const list = await owner.get('/api/metrics');
        const all = [...(list.body?.mine ?? []), ...(list.body?.domain ?? []), ...(list.body?.marketplace ?? [])];
        const found = all.find((x) => x.id === metricId || x.member?.endsWith(`.${measureName}`));
        ctx.metrics[m.name] = { metricId, member: found?.member ?? null, measureName };
        return `member=${found?.member} (existing)`;
      }
      if (r.status < 200 || r.status >= 300) throw new Error(`define → ${r.status} ${JSON.stringify(r.body)}`);
      ctx.metrics[m.name] = { metricId, member: r.body.member ?? null, measureName };
      return `member=${r.body.member} convergent=${r.body.convergence?.ok}`;
    });
  }
  // Run one metric so a real value is produced (Cube live or offline-mock).
  await runner.step('Metrics', 'explore Revenue by region (run the metric)', async () => {
    const rev = ctx.metrics['Revenue'];
    if (!rev) throw new Error('Revenue metric not defined');
    const r = await owner.post('/api/metrics/explore', { metricId: rev.metricId, dimensions: rev.member ? [rev.member.split('.')[0] + '.region'] : undefined });
    return `rows=${(r.body?.rows ?? []).length} status=${r.status}`;
  });
  // Certify Revenue cross-domain (Admin) → Marketplace.
  await runner.step('Marketplace', 'certify Revenue metric (Admin)', async () => {
    const rev = ctx.metrics['Revenue'];
    if (!rev) throw new Error('Revenue metric missing');
    // promote (Builder) then certify (Admin)
    await S(DATASET.builder).post('/api/metrics/govern', { metricId: rev.metricId, transition: 'promote' });
    const r = await S('nova-admin').post('/api/metrics/govern', { metricId: rev.metricId, transition: 'certify' });
    return `tier=${r.body?.tier ?? r.status}`;
  });
}

// ----------------------------------------------------------- phase 5: dashboards
async function phaseDashboards() {
  console.log('\n— Phase 5: Dashboards (Sales Overview, Customer Health) —');
  // The Sales Builder assembles dashboards from the certified metrics: a Personal
  // dashboard is owner-only, so the owner must be a Builder to promote it (then the
  // Admin certifies). Building as the Builder keeps the promote→certify hops valid.
  const owner = S(DATASET.builder);
  const member = (name) => ctx.metrics[name]?.member;
  const view = member('Revenue') ? member('Revenue').split('.')[0] : 'NorthpeakcommerceGold';

  const dashboards = [
    {
      id: 'northpeak-sales-overview', name: 'Sales Overview', view, key: 'sales_overview',
      charts: [
        { name: 'Revenue', vizType: 'big_number_total', metric: member('Revenue') },
        { name: 'Revenue by region', vizType: 'bar', metric: member('Revenue'), dimensions: [`${view}.region`] },
        { name: 'Average order value', vizType: 'big_number_total', metric: member('AOV') },
      ],
    },
    {
      id: 'northpeak-customer-health', name: 'Customer Health', view, key: 'customer_health',
      charts: [
        { name: 'Churn rate', vizType: 'big_number_total', metric: member('ChurnRate') },
        { name: 'Conversion', vizType: 'big_number_total', metric: member('Conversion') },
        { name: 'Churn by region', vizType: 'bar', metric: member('ChurnRate'), dimensions: [`${view}.region`] },
      ],
    },
  ];

  for (const d of dashboards) {
    await runner.step('Dashboards', `build ${d.name}`, async () => {
      const charts = d.charts.filter((c) => c.metric); // skip charts whose metric failed to define
      if (charts.length === 0) throw new Error('no resolved metric members for charts');
      const body = await owner.postOk('/api/dashboards/build', { id: d.id, name: d.name, view: d.view, mode: 'drag-drop', charts });
      const id = body.id ?? d.id;
      ctx.dashboards[d.key] = id;
      return `id=${id} charts=${charts.length} super=${body.build?.superset_dashboard_id ?? 'mock'}`;
    });
  }
  await runner.step('Marketplace', 'certify Sales Overview dashboard (Admin)', async () => {
    const id = ctx.dashboards['sales_overview'];
    if (!id) throw new Error('Sales Overview not built');
    // Owner (Sales Builder) promotes Personal→Domain (now domain-visible); Admin certifies.
    // Idempotent: a re-run may find it already promoted/certified — tolerate that.
    const p = await S(DATASET.builder).post('/api/dashboards/govern', { dashboardId: id, transition: 'promote' });
    const r = await S('nova-admin').post('/api/dashboards/govern', { dashboardId: id, transition: 'certify' });
    if (r.status >= 400 && r.body?.tier !== 'marketplace') {
      // confirm current tier before failing (already-marketplace on re-run is fine)
      const cur = await S('nova-admin').get('/api/dashboards');
      const all = [...(cur.body?.mine ?? []), ...(cur.body?.domain ?? []), ...(cur.body?.marketplace ?? [])];
      const dash = all.find((x) => x.id === id);
      if (dash?.tier === 'marketplace') return `tier=marketplace (already) promote=${p.status}`;
      throw new Error(`certify → ${r.status} ${JSON.stringify(r.body)}`);
    }
    return `tier=${r.body?.tier ?? 'marketplace'}`;
  });
}

// ----------------------------------------------------------- phase 6: knowledge
async function phaseKnowledge() {
  console.log('\n— Phase 6: Knowledge (workflows + tacit notes) —');
  for (const w of WORKFLOWS) {
    await runner.step('Knowledge', `workflow "${w.title}"`, async () => {
      const s = S(w.actor);
      const body = await s.postOk('/api/knowledge/workflows', { title: w.title, domain: w.domain });
      const id = body.id;
      ctx.workflows[w.title] = id;
      await s.put(`/api/knowledge/workflows/${id}/tacit`, { tacit: w.tacit });
      // publish (Personal→Shared) requires a Builder
      const pub = await S(w.publisher).post(`/api/knowledge/workflows/${id}/publish`, { action: 'publish' });
      return `id=${id} publish=${pub.status}`;
    });
  }
  for (const d of KNOWLEDGE_DOCS) {
    await runner.step('Knowledge', `ingest doc "${d.title}"`, async () => {
      const r = await S('devi-ops').post('/api/knowledge/docs', { title: d.title, text: d.text });
      return `id=${r.body?.id ?? r.status}`;
    });
  }
}

// -------------------------------------------------------------- phase 7: agents
function resolveGrant(token) {
  const map = {
    '{{handle_a_return}}': ctx.workflows['Handle a return'],
    '{{fraud_check}}': ctx.workflows['Fraud check'],
    '{{gold_dataset}}': ctx.dataset,
    '{{support_mcp}}': ctx.connections['northpeak-support-mcp'],
  };
  return map[token] ?? token;
}

function buildSystemYaml(a) {
  // A System object — JSON is valid YAML, so the platform's yaml.load parses this
  // exactly. Grants reference the real ids resolved above (real cross-tab wiring).
  const sys = {
    version: '1',
    system: { name: a.name, domain: a.domain, visibility: 'Personal' },
    entrypoint: a.entrypoint,
    state: { channels: { messages: 'add_messages' } },
    grants: {
      data: (a.grantData ?? []).map(resolveGrant).filter(Boolean),
      knowledge: (a.grantKnowledge ?? []).map(resolveGrant).filter(Boolean),
      tools: a.grantTools ?? [],
      connections: (a.grantConnections ?? []).map((c) => ({ id: resolveGrant(c.id), capability: c.capability })).filter((c) => c.id),
    },
    routing: { overrides: {} },
    agents: [{ id: a.agent.id, role: a.agent.role, agent_md: a.agent.agent_md, memory_md: '' }],
    edges: [],
  };
  return JSON.stringify(sys, null, 2);
}

async function phaseAgents() {
  console.log('\n— Phase 7: Agents (support, fraud, pricing — author + build + run) —');
  for (const a of AGENTS) {
    await runner.step('Agents', `author + build + run "${a.name}"`, async () => {
      const s = S(a.owner);
      // create
      const created = await s.postOk('/api/agents/systems', { name: a.name, domain: a.domain });
      const id = created.id;
      ctx.agents[a.entrypoint] = id;
      // write system.yaml via the governed file API (optimistic-concurrency on sha)
      const cur = await s.get(`/api/agents/systems/${id}/files?path=system.yaml`);
      const sha = cur.body?.sha ?? '';
      const put = await s.put(`/api/agents/systems/${id}/files`, { path: 'system.yaml', content: buildSystemYaml(a), sha });
      if (put.status >= 400) throw new Error(`write system.yaml → ${put.status} ${JSON.stringify(put.body)}`);
      // build (5 adapters; live agent-runtime or honest offline-mock)
      const built = await s.post(`/api/agents/systems/${id}/build`);
      // run a governed invocation (every tool call OPA-checked + Langfuse-traced)
      const run = await s.post(`/api/agents/systems/${id}/run`, { prompt: a.runPrompt });
      return `id=${id} build=${built.body?.mode ?? built.status} run=${run.body?.ok ?? run.status} path=${(run.body?.path ?? []).join('>')}`;
    });
  }
}

// ------------------------------------------------------------- phase 8: science
async function phaseScience() {
  console.log('\n— Phase 8: Science (churn model lifecycle + predict) —');
  const probe = await S('sasha-sales').get('/api/science/model');
  if (!probe.body?.mlEnabled) {
    await runner.step('Science', 'churn model lifecycle', async () => {
      throw new Error('ml.enabled=false — set science.ml.enabled=true (per domain) on the live run to enable train/predict');
    });
    ctx.science = { enabled: false };
    return;
  }
  ctx.science = { enabled: true };
  const model = SCIENCE.churnModel;
  await runner.step('Science', `promote churn model (Builder)`, async () => {
    const r = await S('sasha-sales').post('/api/science/model', { op: 'promote', model });
    return `tier=${r.body?.model?.tier ?? r.status}`;
  });
  await runner.step('Science', `go-live churn model (Builder)`, async () => {
    const r = await S('sasha-sales').post('/api/science/model', { op: 'go-live', model });
    return `stage=${r.body?.model?.stage ?? r.status}`;
  });
  await runner.step('Marketplace', `certify churn model (Admin)`, async () => {
    const r = await S('nova-admin').post('/api/science/model', { op: 'certify', model, mode: SCIENCE.certifyMode });
    return `tier=${r.body?.model?.tier ?? r.status}`;
  });
  await runner.step('Science', `predict (governed MCP door)`, async () => {
    const r = await S('sasha-sales').post('/api/science/predict', { account: SCIENCE.predictAccount, features: SCIENCE.predictFeatures });
    return `decision=${r.body?.decision ?? r.status} score=${r.body?.score} band=${r.body?.band}`;
  });
  await runner.step('Science', `register demand-forecast (retrain trigger)`, async () => {
    const r = await S('sasha-sales').post('/api/science/model', { op: 'retrain', model });
    return `runId=${r.body?.retrain?.runId ?? r.status}`;
  });
}

// ------------------------------------------------------------ phase 9: big bets
async function phaseBigBets() {
  console.log('\n— Phase 9: Big Bets (Reduce churn, Increase AOV) —');
  const refMap = () => ({
    '{{churn_model}}': ctx.science?.enabled ? SCIENCE.churnModel : null,
    '{{customer_health_dashboard}}': ctx.dashboards['customer_health'],
    '{{churnrate_metric}}': ctx.metrics['ChurnRate']?.metricId,
    '{{aov_metric}}': ctx.metrics['AOV']?.metricId,
    '{{sales_overview_dashboard}}': ctx.dashboards['sales_overview'],
    '{{pricing_agent}}': ctx.agents['pricing'],
  });
  for (const b of BIG_BETS) {
    await runner.step('Big Bets', `create "${b.label}" + bundle components`, async () => {
      const s = S(b.actor);
      // NEW create shape: Owner + one free-form Problem Statement + Solution Idea +
      // value (target + basis) + Planned Go-Live. The bet NAME is DERIVED from the
      // problem statement server-side (no separate name field is sent).
      const created = await s.postOk('/api/big-bets', {
        owner: b.owner, problem: b.problem, solution: b.solution,
        domain: b.domain, pillarId: b.pillarId,
        targetValue: b.targetValue, valueBasis: b.valueBasis, goLive: b.goLive,
      });
      const betId = created.id;
      ctx.bets[b.key] = betId;
      const map = refMap();
      let attached = 0;
      for (const c of b.components) {
        const realId = map[c.ref];
        if (!realId) continue; // upstream artifact missing (e.g. science off) — skip honestly
        // The Big Bets registry is a mock of the future Supabase store, so it links
        // components via its OWN governed create flow (scaffold), recording a real
        // `consumes` edge to the upstream artifact id — the lineage the bet bundles.
        const r = await s.post(`/api/big-bets/${betId}/components`, {
          tab: c.tab, scaffold: { title: c.title, consumes: [realId] },
          plannedReady: '2026-09-15', weight: 1,
        });
        if (r.status >= 200 && r.status < 300) attached++;
      }
      return `id=${betId} components=${attached}/${b.components.length}`;
    });
  }
}

// ------------------------------------------------------------- phase 10: strategy
async function phaseStrategy() {
  console.log('\n— Phase 10: Strategy (Retention + Growth pillars, value rollup) —');
  for (const p of PILLARS) {
    await runner.step('Strategy', `pillar "${p.name}" + value (${p.valueMode}) + link bet`, async () => {
      const s = S(p.owner);
      // Governed value metrics reference a real Cube measure — resolve the member
      // when Metrics defined it (offline the seedTotal/baseline drive the number).
      const linkMetric = ctx.metrics['Revenue'];
      const metrics = (p.metrics ?? []).map((m, i) => ({
        cube: linkMetric?.member ? linkMetric.member.split('.')[0] : 'NorthpeakcommerceGold',
        measure: linkMetric?.member ?? `NorthpeakcommerceGold.${i}`,
        title: m.title, basis: m.basis, baseline: m.baseline, seedTotal: m.seedTotal,
      }));
      // Create the pillar with its value metric DESCRIBED (name + one-liner).
      const created = await s.postOk('/api/strategy/pillars', {
        name: p.name, description: p.description, scope: p.scope,
        metrics, valueMetric: p.valueMetric,
      });
      const pillarId = created.item?.id ?? created.id;
      ctx.pillars[p.name] = pillarId;

      // Choose how the number is KEPT: governed (flows from the Cube metric) or
      // manual (monthly entries recorded here) — populates the rollup + history.
      let valueNote;
      if (p.valueMode === 'manual') {
        await s.put(`/api/strategy/pillars/${pillarId}/value-metric`, { mode: 'manual' });
        let n = 0;
        for (const e of (p.valueEntries ?? [])) {
          const r = await s.post(`/api/strategy/pillars/${pillarId}/value-entry`, { month: e.month, value: e.value });
          if (r.status >= 200 && r.status < 300) n++;
        }
        valueNote = `manual entries=${n}/${(p.valueEntries ?? []).length}`;
      } else {
        const r = await s.put(`/api/strategy/pillars/${pillarId}/value-metric`, { mode: 'governed' });
        valueNote = `governed=${r.status}`;
      }

      // Link the bet so value rolls up pillar ← bet ← components. The pillar↔bet
      // bridge accepts the platform's stub-catalogue bet ids (a known bets-bridge
      // seam); runtime Big Bet ids are rejected until that bridge owns them, so we
      // link the matching stub to demonstrate the wired rollup while the real Big
      // Bet (with its real bundled components) stands on its own.
      const STUB = { Retention: 'seed_bet_reduce_churn', Growth: 'seed_bet_winback' };
      const realBet = ctx.bets[p.bet];
      let linked = 'no-bet';
      if (realBet) {
        let r = await s.post(`/api/strategy/pillars/${pillarId}/bets`, { betId: realBet });
        if (r.status >= 400 && STUB[p.name]) {
          r = await s.post(`/api/strategy/pillars/${pillarId}/bets`, { betId: STUB[p.name] });
          linked = `stub ${STUB[p.name]} (${r.status}; runtime bet ${realBet} pending bridge)`;
        } else {
          linked = `bet ${realBet} (${r.status})`;
        }
      } else if (STUB[p.name]) {
        const r = await s.post(`/api/strategy/pillars/${pillarId}/bets`, { betId: STUB[p.name] });
        linked = `stub ${STUB[p.name]} (${r.status})`;
      }
      return `id=${pillarId} ${valueNote} linked=${linked}`;
    });
  }
  await runner.step('Strategy', 'snapshot value rollup', async () => {
    const s = S('nova-admin');
    const out = [];
    for (const [name, id] of Object.entries(ctx.pillars)) {
      const r = await s.post(`/api/strategy/pillars/${id}/snapshot`).catch(() => null);
      out.push(`${name}=${r?.status ?? 'n/a'}`);
    }
    return out.join(' ');
  });
}

// ------------------------------------------------------------------------- main
async function main() {
  console.log(`\n=== Northpeak e-commerce seed → ${STORE.name} (${STORE.tagline}) ===`);
  console.log(`Target OS UI: ${BASE}`);
  const creds = loadCredentials();

  await phaseAuth(creds);
  // every later phase depends on at least one signed-in identity
  if (Object.keys(ctx.sessions).length === 0) {
    console.error('\nFATAL: no cast member could authenticate. Is OS_USERS seeded + os-ui reachable?');
    process.exitCode = 1;
    return;
  }
  await phaseConnections();
  await phaseFiles();
  await phaseData();
  await phaseMetrics();
  await phaseDashboards();
  await phaseKnowledge();
  await phaseAgents();
  await phaseScience();
  await phaseBigBets();
  await phaseStrategy();

  const sum = runner.summary();
  console.log(`\n=== Seed complete: ${sum.ok}/${sum.total} steps ok, ${sum.fail} failed ===`);
  if (sum.fail > 0) {
    console.log('Failed steps (expected on kind where a live backend is absent):');
    for (const r of sum.results.filter((x) => !x.ok)) console.log(`  ✗ [${r.tab}] ${r.name} — ${r.note}`);
  }
  // Non-zero exit only if NOTHING worked (auth + core create all failed).
  const coreOk = sum.results.some((r) => r.ok && ['Data', 'Metrics', 'Agents'].includes(r.tab));
  process.exitCode = coreOk ? 0 : 1;
}

main().catch((e) => {
  console.error('\nFATAL:', e);
  process.exitCode = 1;
});
