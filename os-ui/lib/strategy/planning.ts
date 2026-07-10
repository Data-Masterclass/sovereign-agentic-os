/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Planning-workspace seed data for the Strategy and Big Bets surfaces
 * (os-application.md §4). These are the domain's transformation cockpit:
 * Strategy holds pillars + a readiness heatmap; Big Bets holds the high-value
 * use cases each linked to the agents/software/data that deliver them and the
 * value they target. Static seed for v1 — the authoring/persistence layer
 * (Supabase + RLS, certification/go-live via OPA) lands with the registry.
 */

// ---- Strategy: pillars and readiness ------------------------------------

export type Readiness = 'mature' | 'developing' | 'nascent';

export type Pillar = {
  name: string;
  intent: string;
  /** Per-function readiness across the agentic-transformation maturity model. */
  readiness: Record<string, Readiness>;
};

export const FUNCTIONS = ['Data', 'Agents', 'Governance', 'Delivery'] as const;

export const PILLARS: Pillar[] = [
  {
    name: 'Govern every action',
    intent: 'Default-deny tool authz, identity-bound, audited, cost-capped.',
    readiness: { Data: 'mature', Agents: 'mature', Governance: 'developing', Delivery: 'developing' },
  },
  {
    name: 'Talk to your data',
    intent: 'Conversational agents grounded in governed knowledge + metrics.',
    readiness: { Data: 'mature', Agents: 'developing', Governance: 'developing', Delivery: 'mature' },
  },
  {
    name: 'Ship sovereignly',
    intent: 'Scaffold → CI → GitOps deploy without leaving the OS.',
    readiness: { Data: 'developing', Agents: 'nascent', Governance: 'developing', Delivery: 'mature' },
  },
  {
    name: 'Scale to ML',
    intent: 'Layer-4 features, training, and inference when the domain needs it.',
    readiness: { Data: 'developing', Agents: 'nascent', Governance: 'nascent', Delivery: 'nascent' },
  },
];

export const READINESS_LABEL: Record<Readiness, string> = {
  mature: 'Mature',
  developing: 'Developing',
  nascent: 'Nascent',
};

// ---- Big Bets: value targets -------------------------------------------

export type BetStatus = 'live' | 'in-flight' | 'planned';

export type BigBet = {
  name: string;
  thesis: string;
  status: BetStatus;
  value: string; // targeted value
  confidence: number; // 0–100
  delivers: string[]; // linked artifacts (agents / software / data)
};

export const BIG_BETS: BigBet[] = [
  {
    name: 'Self-serve analytics agent',
    thesis: 'Every analyst asks questions in natural language instead of filing BI tickets.',
    status: 'live',
    value: '−60% time-to-insight',
    confidence: 78,
    delivers: ['Domain RAG Agent', 'Cube metrics', 'Superset dashboards'],
  },
  {
    name: 'Governed knowledge copilot',
    thesis: 'Institutional knowledge stays current, cited, and policy-gated across the domain.',
    status: 'in-flight',
    value: '+1 reuse of every doc',
    confidence: 64,
    delivers: ['Knowledge index', 'Docling ingest', 'Compliance Monitor'],
  },
  {
    name: 'One-sentence software delivery',
    thesis: 'A plain-language request scaffolds, builds, and deploys an internal app.',
    status: 'in-flight',
    value: '−1 week per app',
    confidence: 52,
    delivers: ['Next.js App Template', 'Forgejo CI', 'Argo CD'],
  },
  {
    name: 'ML for the domain (Layer 4)',
    thesis: 'Domains that need forecasting train and serve models without a platform team.',
    status: 'planned',
    value: 'New revenue lines',
    confidence: 35,
    delivers: ['JupyterHub', 'MLflow', 'Featureform', 'KServe'],
  },
];

// ---- Shared KPI strip (Strategy + Big Bets headline numbers) ------------

export type Kpi = { label: string; value: string; sub: string };

export const KPIS: Kpi[] = [
  { label: 'Active bets', value: '4', sub: '1 live · 2 in-flight · 1 planned' },
  { label: 'Pillars on track', value: '3 / 4', sub: 'Layer-4 still nascent' },
  { label: 'Avg. confidence', value: '57%', sub: 'across the bet portfolio' },
  { label: 'Governed surface', value: '100%', sub: 'every action policy-checked' },
];
