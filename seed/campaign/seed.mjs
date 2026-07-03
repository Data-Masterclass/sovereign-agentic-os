#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Data Masterclass
 *
 * Campaign-Optimization Big Bet seed — "Northpeak Unlimited". Drives the Sovereign
 * Agentic OS GOVERNED flows to seed the exercise material into the
 * `agentic-leader-q3-2026` domain: 4 governed datasets, 4 CSV data files + 3
 * sample-campaign files (all domain-Shared), 3 knowledge MDs (published Shared +
 * RAG-indexed), 1 Campaign Evaluation Agent (promoted Shared, RUN-able by every
 * Agentic-Leader participant), and 1 reference Campaign App.
 *
 * It authenticates AS the instructor + ONE participant (POST /api/auth/login) and
 * authors everything as the single `alp-instructor` (a Builder in the domain), so
 * every artifact is created through the real governed routes — never a DB insert,
 * then verifies one Agentic-Leader's governed consumption. Idempotent: it reuses
 * an artifact when one of the same name already exists, and tolerates a missing
 * backend on kind (logs ✗, goes on).
 *
 * Run locally (kind, port-forward os-ui to :3000):
 *   OS_UI_URL=http://localhost:3000 \
 *   SEED_CREDENTIALS="$(cat seed/campaign/users.secret.json)" \
 *   node seed/campaign/seed.mjs
 *
 * Reuses the e-commerce seed's zero-dependency governed-API client UNCHANGED.
 */
import { Session, Runner, baseUrlFromEnv } from '../ecommerce/lib/client.mjs';
import {
  STORE, DOMAIN, INSTRUCTOR, DATASETS, DATA_FILES, SAMPLE_FILES,
  KNOWLEDGE, EVAL_AGENT, CAMPAIGN_APP,
} from './narrative.mjs';

const BASE = baseUrlFromEnv();
const runner = new Runner();
const OP = INSTRUCTOR.id; // the operator that authors + shares everything

/** Runtime ids threaded across phases (the real cross-tab lineage). */
const ctx = { sessions: {}, datasets: {}, files: {}, workflows: {}, agent: null, app: null };

function loadCredentials() {
  const raw = process.env.SEED_CREDENTIALS;
  if (!raw) throw new Error('SEED_CREDENTIALS env (JSON {id:password}) is required — run gen-credentials.mjs');
  const creds = JSON.parse(raw);
  // The live seed needs exactly two identities: the instructor (authors + shares
  // everything) and ONE Agentic-Leader participant (the first roster email) to
  // prove governed consumption + run-scope. The other 35 identities are seeded
  // into the OS via OS_USERS but never logged in by the seed.
  if (!creds[INSTRUCTOR.id]) throw new Error(`SEED_CREDENTIALS missing password for instructor ${INSTRUCTOR.id}`);
  const learnerId = Object.keys(creds).find((k) => k !== INSTRUCTOR.id);
  if (!learnerId) throw new Error('SEED_CREDENTIALS must include one participant (first roster email) to prove run-scope');
  return { creds, learnerId };
}

function S(id) {
  const s = ctx.sessions[id];
  if (!s) throw new Error(`no session for ${id} (login phase failed?)`);
  return s;
}

async function findInList(session, path, name, pick = (b) => b.items ?? []) {
  const r = await session.get(path);
  const items = pick(r.body) || [];
  return items.find((x) => x && (x.name === name || x.title === name));
}

// --------------------------------------------------------------- phase 0: auth --
async function phaseAuth(creds, learnerId) {
  console.log('\n— Phase 0: authenticate instructor + one Agentic Leader (run-scope proof) —');
  for (const id of [INSTRUCTOR.id, learnerId]) {
    await runner.step('Users', `login ${id}`, async () => {
      const s = new Session(BASE, id);
      const u = await s.login(creds[id]);
      ctx.sessions[id] = s;
      return `role=${u.role} domains=${u.domains.join(',')}`;
    });
  }
}

// --------------------------------------------------------------- phase 1: data --
// 4 governed datasets (catalog / lineage / agent-grants). The instructor is a
// Builder, so it authors, requests promotion AND approves its own domain-scoped
// promotion (a domain approval, not a tenant one).
async function phaseData() {
  console.log('\n— Phase 1: Data (4 governed campaign datasets, Bronze→Silver→Gold) —');
  const op = S(OP);
  for (const d of DATASETS) {
    await runner.step('Data', `dataset ${d.name} (build + promote)`, async () => {
      const existing = await findInList(op, '/api/data/datasets', d.name,
        (b) => [...(b.mine ?? []), ...(b.domain ?? []), ...(b.items ?? [])]);
      let id = existing?.id;
      if (!id) {
        const body = await op.postOk('/api/data/datasets', { name: d.name, domain: d.domain });
        id = body.dataset?.id ?? body.id;
      }
      ctx.datasets[d.name] = id;
      const ds = `/api/data/datasets/${id}`;
      await op.post(`${ds}/version`, { layer: 'bronze', quality: 'raw' });
      await op.post(`${ds}/version`, { layer: 'silver', artifactBody: d.silverSql });
      await op.post(`${ds}/version`, { layer: 'gold', artifactBody: d.goldSql });
      await op.post(`${ds}/docs`, { description: d.description, columns: d.columns });
      await op.post(`${ds}/build`, { stage: 'gold' });
      // Request promotion → domain, then self-approve (Builder, domain scope).
      const pr = await op.post(`${ds}/promote`, { visibility: 'domain' });
      let approvalId = pr.body?.approval?.id ?? null;
      if (!approvalId) {
        const q = await op.get('/api/governance/approvals');
        approvalId = (q.body?.approvals ?? []).find(
          (a) => a.kind === 'dataset_promote' && a.payload?.datasetId === id)?.id;
      }
      let applied = pr.body?.already ? 'already' : 'n/a';
      if (approvalId) {
        const ap = await op.post('/api/governance/approvals', { id: approvalId, decision: 'approve' });
        applied = ap.body?.applied ?? ap.status;
      }
      return `id=${id} cols=${d.columns.length} promote=${applied}`;
    });
  }
}

// -------------------------------------------------------------- phase 2: files --
// The ACTUAL ROWS (4 CSVs) + 3 sample-campaign files, each promoted domain-Shared:
// create → document (description + tags) → request promote → self-approve.
async function phaseFiles() {
  console.log('\n— Phase 2: Files (4 data CSVs + 3 sample-campaign files, domain-Shared) —');
  const op = S(OP);
  const all = [...DATA_FILES, ...SAMPLE_FILES];
  for (const f of all) {
    await runner.step('Files', `ingest + share ${f.name}`, async () => {
      const existing = await findInList(op, '/api/files', f.name,
        (b) => [...(b.mine ?? []), ...(b.domain ?? []), ...(b.items ?? [])]);
      let id = existing?.id;
      if (!id) {
        const body = await op.postOk('/api/files', {
          name: f.name, folder: f.folder, tags: f.tags, sensitivity: 'internal',
          text: f.text, provenanceSource: 'campaign-seed',
        });
        id = body.asset?.id ?? body.id;
      }
      ctx.files[f.name] = id;
      // Documentation gate for promotion: description + >=1 tag.
      await op.patch(`/api/files/${id}`, { description: f.description, tags: f.tags });
      // Request promote → domain, then self-approve (file_promote is domain-scoped).
      const pr = await op.post(`/api/files/${id}/promote`, { visibility: 'domain' });
      let approvalId = pr.body?.approval?.id ?? null;
      if (!approvalId) {
        const q = await op.get('/api/governance/approvals');
        approvalId = (q.body?.approvals ?? []).find(
          (a) => a.kind === 'file_promote' && a.payload?.fileId === id)?.id;
      }
      let applied = 'n/a';
      if (approvalId) {
        const ap = await op.post('/api/governance/approvals', { id: approvalId, decision: 'approve' });
        applied = ap.body?.applied ?? ap.status;
      }
      return `id=${id} bytes=${f.text.length} share=${applied}`;
    });
  }
}

// ---------------------------------------------------------- phase 3: knowledge --
// 3 MDs authored as governed workflows (published Shared + indexed) AND pushed to
// the RAG doc index so participants' agents can retrieve the prose.
async function phaseKnowledge() {
  console.log('\n— Phase 3: Knowledge (3 campaign MDs — published Shared + RAG) —');
  const op = S(OP);
  for (const k of KNOWLEDGE) {
    await runner.step('Knowledge', `workflow "${k.title}"`, async () => {
      const existing = await findInList(op, '/api/knowledge/workflows', k.title,
        (b) => [...(b.mine ?? []), ...(b.domain ?? []), ...(b.items ?? [])]);
      let id = existing?.id;
      if (!id) {
        const body = await op.postOk('/api/knowledge/workflows', { title: k.title, domain: DOMAIN });
        id = body.id;
      }
      ctx.workflows[k.key] = id;
      // Write the full workflow.md (frontmatter rules + step blocks + tacit).
      const cur = await op.get(`/api/knowledge/workflows/${id}`);
      const sha = cur.body?.sha ?? undefined;
      const patch = await op.patch(`/api/knowledge/workflows/${id}`, { md: k.md, sha });
      // Publish Personal(draft) → Shared(live). Builder gate.
      const pub = await op.post(`/api/knowledge/workflows/${id}/publish`, { action: 'publish' });
      // Re-index for RAG (best-effort).
      await op.post(`/api/knowledge/workflows/${id}/index`);
      // Also push the prose into the tenant knowledge doc index (best-effort; needs OpenSearch).
      const doc = await op.post('/api/knowledge/docs', { title: k.title, text: k.docText });
      return `id=${id} patch=${patch.status} publish=${pub.body?.visibility ?? pub.status} doc=${doc.status}`;
    });
  }
}

// -------------------------------------------------------------- phase 4: agent --
function buildSystemYaml() {
  const sys = {
    version: '1',
    system: { name: EVAL_AGENT.name, domain: EVAL_AGENT.domain, visibility: 'Personal' },
    runtime: 'langgraph',
    safetyPreset: 'read-only',
    entrypoint: EVAL_AGENT.entrypoint,
    state: { channels: { messages: 'add_messages' } },
    grants: {
      data: EVAL_AGENT.grantData.map((n) => ctx.datasets[n]).filter(Boolean),
      knowledge: EVAL_AGENT.grantKnowledge.map((k) => ctx.workflows[k]).filter(Boolean),
      tools: EVAL_AGENT.grantTools,
      connections: [],
    },
    routing: { overrides: {} },
    agents: [{ id: EVAL_AGENT.agent.id, role: EVAL_AGENT.agent.role, agent_md: EVAL_AGENT.agent.agent_md, memory_md: '' }],
    edges: [],
  };
  return JSON.stringify(sys, null, 2);
}

async function phaseAgent() {
  console.log('\n— Phase 4: Agents (Campaign Evaluation Agent — build + promote Shared) —');
  const op = S(OP);
  await runner.step('Agents', `author + build + share "${EVAL_AGENT.name}"`, async () => {
    const existing = await findInList(op, '/api/agents/systems', EVAL_AGENT.name,
      (b) => [...(b.mine ?? []), ...(b.domain ?? []), ...(b.marketplace ?? [])]);
    let id = existing?.id;
    if (!id) {
      const created = await op.postOk('/api/agents/systems', { name: EVAL_AGENT.name, domain: EVAL_AGENT.domain });
      id = created.id;
    }
    ctx.agent = id;
    const cur = await op.get(`/api/agents/systems/${id}/files?path=system.yaml`);
    const sha = cur.body?.sha ?? '';
    const put = await op.put(`/api/agents/systems/${id}/files`, { path: 'system.yaml', content: buildSystemYaml(), sha });
    if (put.status >= 400) throw new Error(`write system.yaml → ${put.status} ${JSON.stringify(put.body)}`);
    const built = await op.post(`/api/agents/systems/${id}/build`);
    // Promote Personal → Shared so every Agentic-Leader participant can RUN it (run-scope).
    const promo = await op.post(`/api/agents/systems/${id}/promote`);
    return `id=${id} build=${built.body?.mode ?? built.status} visibility=${promo.body?.visibility ?? promo.status} data=${EVAL_AGENT.grantData.length} knowledge=${EVAL_AGENT.grantKnowledge.length}`;
  });
}

// ------------------------------------------------------------ phase 6: verify --
// Prove one Agentic-Leader participant's GOVERNED-CONSUMPTION rights on the
// instructor's Shared materials: they SEE + READ + RUN, but are DENIED every
// steward action (edit/promote). This is the run-scope fix + the role lockdown,
// exercised end-to-end as the first roster participant.
async function phaseVerify(learnerId) {
  console.log('\n— Phase 6: Verify one Agentic Leader (governed consumption + lockdown) —');
  const learner = S(learnerId);
  const csvId = ctx.files['sample-campaign-performance-daily.csv'];
  const dsId = ctx.datasets[DATASETS[0]?.name];

  await runner.step('Verify', 'Agentic Leader SEES the Shared eval agent', async () => {
    const r = await learner.get('/api/agents/systems');
    const shared = [...(r.body?.domain ?? []), ...(r.body?.items ?? [])]
      .find((s) => s && (s.id === ctx.agent || s.name === EVAL_AGENT.name));
    if (!shared) throw new Error('shared eval agent not visible to the participant');
    return `visible id=${shared.id ?? 'n/a'}`;
  });

  await runner.step('Verify', 'reads a Shared CSV file’s rows (HTTP 200)', async () => {
    if (!csvId) throw new Error('CSV file id missing (phaseFiles failed?)');
    const r = await learner.get(`/api/files/${csvId}`);
    if (r.status !== 200) throw new Error(`read CSV → ${r.status}`);
    return `status=200 name=${r.body?.asset?.name ?? r.body?.name ?? 'csv'}`;
  });

  await runner.step('Verify', 'RUNs the Shared eval agent (run-scope, 200)', async () => {
    if (!ctx.agent) throw new Error('eval agent not created');
    const run = await learner.post(`/api/agents/systems/${ctx.agent}/run`, {
      prompt: 'Evaluate this recommendation: INCREASE CMP-1002 budget by 20% for 14 days because COS 15% < target 16% and CAC ~48 EUR is below the new-customer ceiling.',
    });
    if (run.status === 403) throw new Error('participant denied run (run-scope fix not applied?)');
    if (run.status !== 200) throw new Error(`run → ${run.status}`);
    return `status=${run.status} ok=${run.body?.ok ?? 'n/a'} path=${(run.body?.path ?? []).join('>')}`;
  });

  await runner.step('Verify', 'DENIED file-write on the Shared agent (403)', async () => {
    const cur = await learner.get(`/api/agents/systems/${ctx.agent}/files?path=system.yaml`);
    const sha = cur.body?.sha ?? '';
    const w = await learner.put(`/api/agents/systems/${ctx.agent}/files`, { path: 'system.yaml', content: '# tamper\n', sha });
    if (w.status !== 403) throw new Error(`expected 403 on write, got ${w.status}`);
    return 'status=403 (edit-scope denied — run ≠ edit)';
  });

  await runner.step('Verify', 'DENIED promote of the Shared agent (403)', async () => {
    const p = await learner.post(`/api/agents/systems/${ctx.agent}/promote`);
    if (p.status !== 403) throw new Error(`expected 403 on agent promote, got ${p.status}`);
    return 'status=403 (promote.shared denied)';
  });

  await runner.step('Verify', 'DENIED dataset promote (403)', async () => {
    if (!dsId) throw new Error('dataset id missing (phaseData failed?)');
    const p = await learner.post(`/api/data/datasets/${dsId}/promote`, { visibility: 'domain' });
    if (p.status !== 403) throw new Error(`expected 403 on dataset promote, got ${p.status}`);
    return 'status=403 (dataset promote denied)';
  });
}

// --------------------------------------------------------------- phase 5: app --
async function phaseApp() {
  console.log('\n— Phase 5: Software (reference Campaign App — promote Shared) —');
  const op = S(OP);
  await runner.step('Software', `create + share "${CAMPAIGN_APP.name}"`, async () => {
    const list = await op.get('/api/apps');
    const existing = (list.body?.apps ?? []).find((a) => a.name === CAMPAIGN_APP.name && a.owner === OP);
    let id = existing?.id;
    if (!id) {
      const created = await op.postOk('/api/apps', {
        name: CAMPAIGN_APP.name, template: CAMPAIGN_APP.template,
        domain: CAMPAIGN_APP.domain, description: CAMPAIGN_APP.description,
      });
      id = created.app?.id ?? created.id;
    }
    ctx.app = id;
    const promo = await op.post(`/api/apps/${id}/promote`);
    return `id=${id} visibility=${promo.body?.app?.visibility ?? promo.status}`;
  });
}

// ------------------------------------------------------------------------- main --
async function main() {
  console.log(`\n=== Campaign seed → ${STORE.name} (${STORE.tagline}) ===`);
  const { creds, learnerId } = loadCredentials();
  console.log(`Target OS UI: ${BASE}  •  domain: ${DOMAIN}  •  authoring as ${OP}, verifying as ${learnerId}`);

  await phaseAuth(creds, learnerId);
  if (!ctx.sessions[OP]) {
    console.error('\nFATAL: the instructor could not authenticate. Is OS_USERS seeded + os-ui reachable?');
    process.exitCode = 1;
    return;
  }
  await phaseData();
  await phaseFiles();
  await phaseKnowledge();
  await phaseAgent();
  await phaseApp();
  if (ctx.sessions[learnerId]) await phaseVerify(learnerId);

  const sum = runner.summary();
  console.log(`\n=== Campaign seed complete: ${sum.ok}/${sum.total} steps ok, ${sum.fail} failed ===`);
  if (sum.fail > 0) {
    console.log('Failed steps (expected on kind where a live backend is absent):');
    for (const r of sum.results.filter((x) => !x.ok)) console.log(`  ✗ [${r.tab}] ${r.name} — ${r.note}`);
  }
  // Non-zero exit only if the core authoring (Data + Files + Agents) all failed.
  const coreOk = sum.results.some((r) => r.ok && ['Data', 'Files', 'Agents'].includes(r.tab));
  process.exitCode = coreOk ? 0 : 1;
}

main().catch((e) => {
  console.error('\nFATAL:', e);
  process.exitCode = 1;
});
