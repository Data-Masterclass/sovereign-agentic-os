#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Data Masterclass
 *
 * Northpeak cohort data seed — PHYSICAL layer. Materializes the six datasets'
 * bronze/silver/gold Iceberg tables into `iceberg.northpeak` THROUGH THE GOVERNED
 * WRITE PATH: every statement goes to the query-tool `POST /execute` (statement
 * allowlist + target-schema/role floor in execute_guard.py, CTAS reads governed by
 * Trino→OPA as the caller) and is verified with a governed `POST /query` count.
 * Never Trino directly, never the Kubernetes API.
 *
 * Fail-fast Polaris gate: new-table creates fail on Polaris 1.0.1 (virtual-host S3
 * bug), so step 0 is a tiny write probe (CTAS → count → drop). If the probe fails
 * the run aborts with the real error BEFORE touching anything else — run this only
 * after the Polaris 1.1.0 upgrade is verified green.
 *
 * Idempotent: CREATE OR REPLACE everywhere; if every gold table already has rows
 * the run is skipped (MARTS_FORCE=true rebuilds).
 *
 *   QUERY_TOOL_URL=http://localhost:8000 node seed/ecommerce-data/marts.mjs
 */
import { BASE_MART, DOMAIN, GOLD_TABLES, INSTRUCTOR, martStatements } from './narrative.mjs';

const QT = (process.env.QUERY_TOOL_URL || 'http://query-tool:8000').replace(/\/+$/, '');
const FORCE = process.env.MARTS_FORCE === 'true';

/** The seed identity: the instructor, a Builder whose domains include `northpeak`
 *  (the deploy script appends it to OS_USERS first). The guard authorizes the
 *  domain-schema writes on exactly this uid/domains/role triple, and every CTAS
 *  read runs as this principal under Trino→OPA. */
const IDENTITY = {
  principal: process.env.SEED_PRINCIPAL || INSTRUCTOR.id,
  uid: process.env.SEED_UID || INSTRUCTOR.id,
  domains: [DOMAIN],
  role: INSTRUCTOR.role,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body) {
  const res = await fetch(`${QT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { error: text.slice(0, 300) }; }
  return { status: res.status, body: parsed };
}

async function execute(sql) {
  const r = await post('/execute', { sql, ...IDENTITY });
  if (r.status !== 200 || r.body.ok === false || r.body.error) {
    throw new Error(`/execute [${r.status}] ${r.body.error ?? JSON.stringify(r.body)}`);
  }
  return r.body;
}

async function count(fqn) {
  const r = await post('/query', { sql: `select count(*) from ${fqn}`, principal: IDENTITY.principal, schema: DOMAIN });
  if (r.status !== 200 || r.body.error) throw new Error(`/query count(${fqn}) [${r.status}] ${r.body.error ?? ''}`);
  return Number(r.body.rows?.[0]?.[0] ?? 0);
}

async function waitForQueryTool() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${QT}/health`);
      if (r.ok) return;
    } catch {}
    await sleep(5000);
  }
  throw new Error(`query-tool not reachable at ${QT}`);
}

/** Step 0 — the Polaris write-probe. A new-table CTAS is exactly the operation the
 *  1.0.1 bug breaks; prove it works before running the real statements. */
async function polarisWriteProbe() {
  const probe = `iceberg.${DOMAIN}.seed_write_probe`;
  await execute(`create schema if not exists iceberg.${DOMAIN}`);
  await execute(`create or replace table ${probe} as select 1 as ok`);
  const c = await count(probe);
  if (c !== 1) throw new Error(`write probe count = ${c}, expected 1`);
  await execute(`drop table if exists ${probe}`);
  console.log('✓ Polaris write probe passed (governed CTAS create/count/drop)');
}

async function main() {
  console.log(`=== Northpeak data seed — physical marts → iceberg.${DOMAIN} (via ${QT}) ===`);
  console.log(`identity: uid=${IDENTITY.uid} domains=${IDENTITY.domains} role=${IDENTITY.role}`);
  await waitForQueryTool();

  // The base mart must exist (northpeak-marts-init) — everything derives from it.
  const base = await count(BASE_MART);
  if (base <= 0) throw new Error(`${BASE_MART} is empty — run the northpeak-marts-init job first`);
  console.log(`✓ base mart ${BASE_MART}: ${base} rows`);

  await polarisWriteProbe();

  if (!FORCE) {
    try {
      const counts = await Promise.all(GOLD_TABLES.map((t) => count(t)));
      if (counts.every((c) => c > 0)) {
        console.log(`✓ all ${GOLD_TABLES.length} gold marts already populated — skipping (MARTS_FORCE=true to rebuild)`);
        return;
      }
    } catch { /* one or more tables missing → build */ }
  }

  const stmts = martStatements();
  for (const s of stmts) {
    const started = Date.now();
    await execute(s.sql);
    if (s.kind === 'ctas') {
      const c = await count(s.target);
      if (c <= 0) throw new Error(`${s.target} materialized but has 0 rows`);
      console.log(`✓ ${s.target} — ${c} rows (${Date.now() - started}ms)`);
    } else {
      console.log(`✓ ${s.target} (schema) (${Date.now() - started}ms)`);
    }
  }

  // Headline sanity so the log doubles as run evidence.
  const stats = await post('/query', {
    sql:
      `select (select count(*) from iceberg.${DOMAIN}.gold_northpeak_web_sessions) as sessions, ` +
      `(select count(*) from iceberg.${DOMAIN}.gold_northpeak_orders) as orders, ` +
      `(select round(sum(net_amount), 2) from iceberg.${DOMAIN}.gold_northpeak_orders) as revenue, ` +
      `(select round(avg(churn_flag), 4) from iceberg.${DOMAIN}.gold_northpeak_customers) as churn_rate, ` +
      `(select round(avg(return_rate), 4) from iceberg.${DOMAIN}.gold_northpeak_returns_impact) as return_rate`,
    principal: IDENTITY.principal,
    schema: DOMAIN,
  });
  console.log('=== marts materialized:', JSON.stringify(stats.body.rows?.[0] ?? stats.body), '===');
}

main().catch((e) => {
  console.error('\nFATAL (marts):', e.message);
  process.exitCode = 1;
});
