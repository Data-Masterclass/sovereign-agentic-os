/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { HealthItem, Alert, TraceDetail } from './types.ts';

/**
 * Offline-mock fixtures — the OTHER half of the live/offline dual pattern. When a
 * backend is off (no kind cluster: Langfuse/Dagster/LiteLLM/Prometheus all down),
 * the adapters fall back to these so the tab — and the VALIDATION GATE — is fully
 * demonstrable on a laptop, honestly marked `source:'mock'`.
 *
 * These deliberately encode the golden-path worked example end-to-end so the gate
 * is one coherent story you can click through:
 *
 *   a Sales agent run (run-2002) FAILS overnight  → run lens RED
 *     → its upstream dbt freshness check went stale (pl-3001) → pipeline lens RED
 *       → the ingestion pod was OOMKilled and AUTO-RESTARTED (sys-4001) → system
 *         lens shows the self-heal → the run had already failed
 *   cost for the Sales domain (cost-5001) is NEARING the Governance cap → amber
 *   the mart_sales artifact (art-6001) is stale; the churn model (art-6002) drifts
 *   a system alert NOTIFIES; a KPI/business alert is ABSENT here (Dashboards owns it)
 *
 * Scope fixtures: two different owners (`u_sales_rep` vs `u_other`) so the
 * "a User cannot see another user's trace" invariant is testable.
 */

const NOW = Date.parse('2026-06-30T06:00:00Z');
const ago = (mins: number) => new Date(NOW - mins * 60_000).toISOString();

export const SALES_DOMAIN = 'sales';
export const SALES_OWNER = 'u_sales_rep';
export const OTHER_OWNER = 'u_other';

// --------------------------------------------------------------- runs ----------
export const MOCK_RUNS: HealthItem[] = [
  {
    id: 'run-2002',
    lens: 'runs',
    title: 'Sales Assistant — nightly renewal brief',
    health: 'red',
    detail: 'Run failed: metrics tool errored — upstream mart was stale (no rows for Q2).',
    owner: SALES_OWNER,
    domain: SALES_DOMAIN,
    ts: ago(180),
    metric: 0,
    links: {
      runId: 'run-2002',
      pipelineId: 'pl-3001',
      systemId: 'sys-4001',
      artifactId: 'art-6001',
      auditRef: 'audit-9007',
      capRef: 'cap-sales-monthly',
    },
    source: 'mock',
  },
  {
    id: 'run-2001',
    lens: 'runs',
    title: 'Sales Assistant — discount-policy lookup',
    health: 'green',
    detail: '6 steps · 2 tool calls · 1.8k tokens · 2.1s.',
    owner: SALES_OWNER,
    domain: SALES_DOMAIN,
    ts: ago(220),
    metric: 2100,
    links: { runId: 'run-2001', auditRef: 'audit-9005' },
    source: 'mock',
  },
  {
    id: 'run-2050',
    lens: 'runs',
    title: 'Finance Assistant — month-end variance',
    health: 'green',
    detail: '9 steps · 3 tool calls · 4.2k tokens · 5.0s.',
    owner: OTHER_OWNER,
    domain: 'finance',
    ts: ago(90),
    metric: 5000,
    links: { runId: 'run-2050', auditRef: 'audit-9050' },
    source: 'mock',
  },
];

// ----------------------------------------------------------- pipelines ---------
export const MOCK_PIPELINES: HealthItem[] = [
  {
    id: 'pl-3001',
    lens: 'pipelines',
    title: 'mart_sales — dbt source freshness',
    health: 'red',
    detail: 'dbt source-freshness FAILED: orders source 31h stale (threshold 24h). 1/12 tests red.',
    owner: SALES_OWNER,
    domain: SALES_DOMAIN,
    ts: ago(200),
    links: { pipelineId: 'pl-3001', artifactId: 'art-6001', systemId: 'sys-4001', auditRef: 'audit-9007' },
    source: 'mock',
  },
  {
    id: 'pl-3002',
    lens: 'pipelines',
    title: 'mart_finance — Dagster nightly',
    health: 'green',
    detail: 'Dagster run succeeded · 24/24 dbt tests pass · freshness OK.',
    owner: OTHER_OWNER,
    domain: 'finance',
    ts: ago(140),
    links: { pipelineId: 'pl-3002', artifactId: 'art-6003' },
    source: 'mock',
  },
];

// -------------------------------------------------------------- cost -----------
export const MOCK_COST: HealthItem[] = [
  {
    id: 'cost-5001',
    lens: 'cost',
    title: 'Sales domain — LLM spend (month-to-date)',
    health: 'amber',
    detail: '$182 of the $200 Governance cap (91%). sovereign-mock + premium-eu split.',
    owner: SALES_OWNER,
    domain: SALES_DOMAIN,
    metric: 182,
    series: [
      { t: ago(60 * 24 * 5), v: 40 },
      { t: ago(60 * 24 * 4), v: 78 },
      { t: ago(60 * 24 * 3), v: 110 },
      { t: ago(60 * 24 * 2), v: 150 },
      { t: ago(60 * 24 * 1), v: 168 },
      { t: ago(60), v: 182 },
    ],
    cap: { id: 'cap-sales-monthly', limitUsd: 200, spentUsd: 182 },
    links: { capRef: 'cap-sales-monthly' },
    source: 'mock',
  },
  {
    id: 'cost-5002',
    lens: 'cost',
    title: 'Finance domain — LLM spend (month-to-date)',
    health: 'green',
    detail: '$54 of the $300 Governance cap (18%).',
    owner: OTHER_OWNER,
    domain: 'finance',
    metric: 54,
    series: [
      { t: ago(60 * 24 * 3), v: 20 },
      { t: ago(60 * 24 * 2), v: 38 },
      { t: ago(60 * 24 * 1), v: 49 },
      { t: ago(60), v: 54 },
    ],
    cap: { id: 'cap-finance-monthly', limitUsd: 300, spentUsd: 54 },
    links: { capRef: 'cap-finance-monthly' },
    source: 'mock',
  },
];

// ------------------------------------------------------------- system ----------
export const MOCK_SYSTEM: HealthItem[] = [
  {
    id: 'sys-4001',
    lens: 'system',
    title: 'dagster-ingest pod — OOMKilled',
    health: 'amber',
    detail: 'Pod OOMKilled (RAM-bound) and auto-restarted by the kubelet; back Ready in 14s.',
    owner: SALES_OWNER,
    domain: SALES_DOMAIN,
    ts: ago(205),
    selfHeal: 'Self-healed — pod auto-restarted (no human needed). The in-flight run had already failed.',
    links: { systemId: 'sys-4001', pipelineId: 'pl-3001' },
    source: 'mock',
  },
  {
    id: 'sys-4002',
    lens: 'system',
    title: 'OpenSearch cluster status',
    health: 'green',
    detail: 'green · 3/3 shards active · no relocations.',
    owner: 'platform',
    domain: 'platform',
    cluster: true,
    selfHeal: 'Healthy.',
    source: 'mock',
  },
  {
    id: 'sys-4003',
    lens: 'system',
    title: 'Argo CD — root app sync',
    health: 'green',
    detail: 'Synced · Healthy · self-heal on (drift auto-reverted).',
    owner: 'platform',
    domain: 'platform',
    cluster: true,
    selfHeal: 'GitOps self-heal active.',
    source: 'mock',
  },
];

// ------------------------------------------------------------ artifacts --------
export const MOCK_ARTIFACTS: HealthItem[] = [
  {
    id: 'art-6001',
    lens: 'artifacts',
    title: 'mart_sales (data product)',
    health: 'red',
    detail: 'Stale — last successful load 31h ago (freshness breach). Owner: Sales.',
    owner: SALES_OWNER,
    domain: SALES_DOMAIN,
    ts: ago(31 * 60),
    links: { artifactId: 'art-6001', pipelineId: 'pl-3001' },
    source: 'mock',
  },
  {
    id: 'art-6002',
    lens: 'artifacts',
    title: 'churn-model (KServe serving)',
    health: 'amber',
    detail: 'Serving up · p95 prediction latency 240ms · drift score 0.18 (warn ≥ 0.15).',
    owner: SALES_OWNER,
    domain: SALES_DOMAIN,
    metric: 0.18,
    links: { artifactId: 'art-6002' },
    source: 'mock',
  },
  {
    id: 'art-6003',
    lens: 'artifacts',
    title: 'mart_finance (data product)',
    health: 'green',
    detail: 'Fresh · lineage intact · no drift.',
    owner: OTHER_OWNER,
    domain: 'finance',
    links: { artifactId: 'art-6003' },
    source: 'mock',
  },
];

// -------------------------------------------------------------- alerts ---------
// Operational (system/run health) ONLY. The commented business alert is what a
// KPI alert would look like — it MUST live in Dashboards, never here.
export const MOCK_ALERTS: Alert[] = [
  {
    id: 'al-7001',
    severity: 'warning',
    title: 'OOMKilled: dagster-ingest',
    detail: 'Pod OOMKilled and auto-restarted (self-healed). Watching RAM; no action needed.',
    domain: SALES_DOMAIN,
    owner: SALES_OWNER,
    disposition: 'self-healed',
    links: { systemId: 'sys-4001' },
    source: 'mock',
  },
  {
    id: 'al-7002',
    severity: 'critical',
    title: 'Agent run failed: Sales nightly brief',
    detail: 'Run-2002 failed (stale upstream). Notified Sales Builder via in-app + email.',
    domain: SALES_DOMAIN,
    owner: SALES_OWNER,
    disposition: 'notified',
    links: { runId: 'run-2002' },
    source: 'mock',
  },
];

// --------------------------------------------------- trace drill fixtures ------
const MOCK_TRACE_DETAILS: Record<string, TraceDetail> = {
  'run-2002': {
    id: 'run-2002',
    name: 'agent.sales.nightly-renewal-brief',
    owner: SALES_OWNER,
    domain: SALES_DOMAIN,
    health: 'red',
    ts: ago(180),
    contextPack: [
      'knowledge:discount-policy (certified) — renewals 5–10% off list',
      'file:contract.pdf — renewal terms, CPI cap',
      'metric request: daily_revenue.total_revenue · Q2 2026',
    ],
    steps: [
      { name: 'supervisor', kind: 'span', ms: 120, status: 'ok', output: 'plan: fetch revenue → draft brief' },
      { name: 'retrieve', kind: 'tool', ms: 210, tokens: 0, status: 'ok', input: 'renewal discount policy', output: '2 passages' },
      { name: 'metrics', kind: 'tool', ms: 480, status: 'error', input: 'daily_revenue.total_revenue Q2', output: 'ERROR: mart_sales returned 0 rows (stale source)' },
      { name: 'generate', kind: 'llm', ms: 0, tokens: 0, costUsd: 0, status: 'error', output: 'aborted — missing revenue figure' },
    ],
    logs: [
      `${ago(180)} INFO  supervisor start run=run-2002`,
      `${ago(180)} INFO  tool.retrieve hits=2`,
      `${ago(180)} ERROR tool.metrics cube_rows=0 reason="mart_sales stale (freshness breach)"`,
      `${ago(180)} ERROR run aborted decision=fail`,
    ],
    links: { runId: 'run-2002', pipelineId: 'pl-3001', systemId: 'sys-4001', artifactId: 'art-6001', auditRef: 'audit-9007', capRef: 'cap-sales-monthly' },
    source: 'mock',
  },
  'run-2001': {
    id: 'run-2001',
    name: 'agent.sales.discount-policy-lookup',
    owner: SALES_OWNER,
    domain: SALES_DOMAIN,
    health: 'green',
    ts: ago(220),
    contextPack: ['knowledge:discount-policy (certified)'],
    steps: [
      { name: 'supervisor', kind: 'span', ms: 90, status: 'ok' },
      { name: 'retrieve', kind: 'tool', ms: 180, status: 'ok', output: '1 passage' },
      { name: 'generate', kind: 'llm', ms: 1830, tokens: 1800, costUsd: 0.004, status: 'ok', output: 'Renewals may offer 5–10% off list.' },
    ],
    logs: [`${ago(220)} INFO run ok run=run-2001 tokens=1800`],
    links: { runId: 'run-2001', auditRef: 'audit-9005' },
    source: 'mock',
  },
  'run-2050': {
    id: 'run-2050',
    name: 'agent.finance.month-end-variance',
    owner: OTHER_OWNER,
    domain: 'finance',
    health: 'green',
    ts: ago(90),
    contextPack: ['metric request: mart_finance.variance'],
    steps: [
      { name: 'supervisor', kind: 'span', ms: 110, status: 'ok' },
      { name: 'metrics', kind: 'tool', ms: 520, status: 'ok', output: 'variance computed' },
      { name: 'generate', kind: 'llm', ms: 4200, tokens: 4200, costUsd: 0.012, status: 'ok' },
    ],
    logs: [`${ago(90)} INFO run ok run=run-2050`],
    links: { runId: 'run-2050', auditRef: 'audit-9050' },
    source: 'mock',
  },
};

/** Lookup a mock trace by id (used by the offline drill path). */
export function mockTrace(id: string): TraceDetail | null {
  return MOCK_TRACE_DETAILS[id] ?? null;
}

/** All mock items across lenses (for correlation walking + tests). */
export function allMockItems(): HealthItem[] {
  return [...MOCK_RUNS, ...MOCK_PIPELINES, ...MOCK_COST, ...MOCK_SYSTEM, ...MOCK_ARTIFACTS];
}
