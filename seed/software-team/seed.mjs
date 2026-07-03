#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Data Masterclass
 *
 * SOFTWARE DELIVERY TEAM seed — registers the governed 6-agent LangGraph system
 * (orchestrator → planner → builder → tester → deployer → communication) as a
 * domain-Shared agent system in the Agents tab, through the REAL governed routes
 * (never a DB insert):
 *
 *   authenticate (instructor, a Builder) → create system (always Personal) →
 *   write the canonical system.yaml → build (Forgejo/OPA/LiteLLM/Langfuse) →
 *   promote Personal→Shared (so every Creator can RUN it, never edit it).
 *
 * Then, if a second (Creator) credential is provided, it PROVES the trust ladder:
 * the Creator can RUN the shared team (run-scope, 200) but is DENIED editing it
 * (403) — run ≠ edit — and deploy stays a human Builder decision.
 *
 * The Software-tab "Build with the Software Delivery Team" entry runs the SAME
 * canonical yaml directly, so it is operational even without this seed; this seed
 * adds the Agents-tab record for inspection/teaching.
 *
 * Idempotent: reuses an existing system of the same name. Tolerates a missing
 * backend on kind (logs ✗, continues).
 *
 * Run locally (port-forward os-ui to :3000):
 *   OS_UI_URL=http://localhost:3000 \
 *   SEED_CREDENTIALS="$(cat seed/software-team/users.secret.json)" \
 *   SOFTWARE_TEAM_INSTRUCTOR=alp-instructor \
 *   node seed/software-team/seed.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Session, Runner, baseUrlFromEnv } from '../ecommerce/lib/client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = baseUrlFromEnv();
const SYSTEM_NAME = 'Software Delivery Team';
const YAML = readFileSync(resolve(HERE, 'system.yaml'), 'utf8');
const runner = new Runner();

function loadCredentials() {
  const raw = process.env.SEED_CREDENTIALS;
  if (!raw) throw new Error('SEED_CREDENTIALS env (JSON {id:password}) is required');
  const creds = JSON.parse(raw);
  const instructor = process.env.SOFTWARE_TEAM_INSTRUCTOR || Object.keys(creds)[0];
  if (!creds[instructor]) throw new Error(`SEED_CREDENTIALS missing password for instructor ${instructor}`);
  const runnerId = Object.keys(creds).find((k) => k !== instructor) || null;
  return { creds, instructor, runnerId };
}

async function findSystem(session, name) {
  const r = await session.get('/api/agents/systems');
  const all = [...(r.body?.mine ?? []), ...(r.body?.domain ?? []), ...(r.body?.marketplace ?? []), ...(r.body?.items ?? [])];
  return all.find((s) => s && s.name === name) ?? null;
}

async function main() {
  console.log(`\n=== Software Delivery Team seed → ${BASE} ===`);
  const { creds, instructor, runnerId } = loadCredentials();

  const op = new Session(BASE, instructor);
  let opUser;
  try {
    opUser = await op.login(creds[instructor]);
  } catch (e) {
    console.error(`\nFATAL: instructor ${instructor} could not authenticate: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const domain = opUser.domains?.[0] || 'platform';
  console.log(`authoring as ${instructor} (role=${opUser.role}, domain=${domain})`);

  let systemId = null;
  await runner.step('Agents', `author + build + share "${SYSTEM_NAME}"`, async () => {
    const existing = await findSystem(op, SYSTEM_NAME);
    systemId = existing?.id ?? null;
    if (!systemId) {
      const created = await op.postOk('/api/agents/systems', { name: SYSTEM_NAME, domain });
      systemId = created.id;
    }
    // Write the canonical system.yaml (re-parsed + compiled server-side).
    const cur = await op.get(`/api/agents/systems/${systemId}/files?path=system.yaml`);
    const sha = cur.body?.sha ?? '';
    const put = await op.put(`/api/agents/systems/${systemId}/files`, { path: 'system.yaml', content: YAML, sha });
    if (put.status >= 400) throw new Error(`write system.yaml → ${put.status} ${JSON.stringify(put.body)}`);
    const built = await op.post(`/api/agents/systems/${systemId}/build`);
    // Promote Personal → Shared so every in-domain Creator can RUN it.
    const promo = await op.post(`/api/agents/systems/${systemId}/promote`);
    return `id=${systemId} build=${built.body?.mode ?? built.status} visibility=${promo.body?.visibility ?? promo.status}`;
  });

  // Trust-ladder proof: a Creator can RUN but not EDIT the shared team.
  if (runnerId && systemId) {
    const learner = new Session(BASE, runnerId);
    let ok = false;
    await runner.step('Verify', `login ${runnerId}`, async () => {
      const u = await learner.login(creds[runnerId]);
      ok = true;
      return `role=${u.role} domains=${(u.domains ?? []).join(',')}`;
    });
    if (ok) {
      await runner.step('Verify', 'Creator RUNs the Shared team (run-scope, 200)', async () => {
        const run = await learner.post(`/api/agents/systems/${systemId}/run`, {
          prompt: 'Build a tiny renewals tracker: a table of renewals with a status filter.',
        });
        if (run.status === 403) throw new Error('Creator denied run (run-scope not applied?)');
        if (run.status !== 200) throw new Error(`run → ${run.status} ${JSON.stringify(run.body).slice(0, 200)}`);
        return `status=200 team=${run.body?.team ?? false} path=${(run.body?.path ?? []).join('>')}`;
      });
      await runner.step('Verify', 'Creator DENIED editing the Shared team (403)', async () => {
        const cur = await learner.get(`/api/agents/systems/${systemId}/files?path=system.yaml`);
        const sha = cur.body?.sha ?? '';
        const w = await learner.put(`/api/agents/systems/${systemId}/files`, { path: 'system.yaml', content: '# tamper\n', sha });
        if (w.status !== 403) throw new Error(`expected 403 on write, got ${w.status}`);
        return 'status=403 (run ≠ edit)';
      });
    }
  }

  const sum = runner.summary();
  console.log(`\n=== Software Delivery Team seed complete: ${sum.ok}/${sum.total} steps ok, ${sum.fail} failed ===`);
  const coreOk = sum.results.some((r) => r.ok && r.tab === 'Agents');
  process.exitCode = coreOk ? 0 : 1;
}

main().catch((e) => {
  console.error('\nFATAL:', e);
  process.exitCode = 1;
});
