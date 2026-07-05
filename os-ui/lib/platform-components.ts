/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Marketplace catalog — the cross-domain place to discover, request, and reuse
 * installable components, agents, and templates (os-application.md §3, §4).
 * Seeded from the real stack component list + the golden-path artifact types.
 * Static for v1: the registry-over-everything backing store lands with the
 * OPA visibility model. "Installed" items are the ones already wired into this
 * deployment; the rest are one-click adds a Builder/Administrator can enable.
 */

export type MarketplaceKind = 'Component' | 'Agent' | 'Template' | 'Connector' | 'Dataset';

export type MarketplaceItem = {
  id: string;
  name: string;
  kind: MarketplaceKind;
  publisher: string;
  installed: boolean;
  summary: string;
  tags: string[];
  /** Internal surface this item maps to, or an external doc anchor. */
  href?: string;
};

export const MARKETPLACE: MarketplaceItem[] = [
  // ---- Agents ----
  {
    id: 'sample-agent',
    name: 'Domain RAG Agent',
    kind: 'Agent',
    publisher: 'Data Masterclass',
    installed: true,
    summary:
      'LangGraph retrieve → generate → trace loop, grounded in your knowledge index and governed by the gateway.',
    tags: ['langgraph', 'rag', 'governed'],
    href: '/agents',
  },
  {
    id: 'compliance-agent',
    name: 'Compliance Monitor',
    kind: 'Agent',
    publisher: 'Data Masterclass',
    installed: false,
    summary:
      'A continuous security/compliance routine that checks tenant posture against EU AI Act / GDPR controls.',
    tags: ['governance', 'routine', 'admin'],
  },

  // ---- Components ----
  {
    id: 'cube',
    name: 'Cube Semantic Layer',
    kind: 'Component',
    publisher: 'Cube Dev · Apache-2.0',
    installed: true,
    summary:
      'Define metrics once (grain, dimensions, measures) and serve them consistently to dashboards and agents.',
    tags: ['metrics', 'semantic'],
    href: '/metrics',
  },
  {
    id: 'superset',
    name: 'Superset BI',
    kind: 'Component',
    publisher: 'Apache · Apache-2.0',
    installed: true,
    summary: 'Self-service dashboards and SQL Lab over the dbt warehouse and Cube metrics.',
    tags: ['dashboards', 'bi'],
    href: '/dashboards',
  },
  {
    id: 'docling',
    name: 'Docling Parsing',
    kind: 'Component',
    publisher: 'IBM · MIT',
    installed: false,
    summary:
      'Convert PDFs/DOCX/HTML into clean markdown for the knowledge index. Off locally (RAM-heavy); on for STACKIT.',
    tags: ['ingest', 'unstructured'],
    href: '/unstructured',
  },
  {
    id: 'openmetadata',
    name: 'OpenMetadata Catalog',
    kind: 'Component',
    publisher: 'Collate · Apache-2.0',
    installed: false,
    summary: 'Data catalog + lineage + profiler. Off by default locally; enable in the Admin Console.',
    tags: ['catalog', 'lineage', 'quality'],
  },
  {
    id: 'mlflow',
    name: 'MLflow Tracking',
    kind: 'Component',
    publisher: 'LF AI & Data · Apache-2.0',
    installed: false,
    summary:
      'Layer-4 experiment tracking + model registry for the Science surface. Enable when the domain does ML.',
    tags: ['science', 'ml', 'layer-4'],
    href: '/science',
  },

  // ---- Templates ----
  {
    id: 'tpl-nextjs-app',
    name: 'Next.js App Template',
    kind: 'Template',
    publisher: 'Data Masterclass',
    installed: true,
    summary:
      'Scaffold a frontend + backend app, push to Forgejo, CI builds it, Argo CD deploys to your namespace.',
    tags: ['software', 'scaffold'],
    href: '/software',
  },
  {
    id: 'tpl-dbt-product',
    name: 'dbt Data Product',
    kind: 'Template',
    publisher: 'Data Masterclass',
    installed: true,
    summary:
      'A dbt project skeleton with staging + marts models and tests, wired into Dagster as materializable assets.',
    tags: ['data', 'dbt', 'quality'],
    // Nav consolidation: /orchestration was folded into /components (admin-only);
    // students land on the Data tab, where dbt data products live.
    href: '/data',
  },
  {
    id: 'tpl-superset-dash',
    name: 'Revenue Dashboard',
    kind: 'Template',
    publisher: 'Data Masterclass',
    installed: false,
    summary: 'A starter Superset dashboard on the daily_revenue Cube metric — clone and adapt.',
    tags: ['dashboards', 'starter'],
  },

  // ---- Datasets / connectors ----
  {
    id: 'ds-knowledge-seed',
    name: 'Platform Knowledge Base',
    kind: 'Dataset',
    publisher: 'Data Masterclass',
    installed: true,
    summary: 'The curated knowledge index that grounds the domain agent out of the box.',
    tags: ['knowledge', 'rag'],
    href: '/knowledge',
  },
  {
    id: 'conn-postgres',
    name: 'PostgreSQL Connector',
    kind: 'Connector',
    publisher: 'Data Masterclass',
    installed: true,
    summary: 'Register an external Postgres source; credentials go to the secrets store, never the browser.',
    tags: ['connection', 'sql'],
    href: '/connections',
  },
];

export const KINDS: MarketplaceKind[] = ['Agent', 'Component', 'Template', 'Connector', 'Dataset'];
