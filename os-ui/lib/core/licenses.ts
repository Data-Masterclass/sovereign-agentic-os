/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Third-party component licenses, seeded from the stack's component docs
 * (docs/components/*.md) and the known dependency set. Drives the
 * About / Licenses surface. An authoritative THIRD-PARTY-LICENSES.md is
 * generated separately; this list mirrors its spirit and is reconciled by hand.
 *
 * SPDX identifiers are used throughout. `Apache-2.0` covers most of the data
 * tier; `MIT` covers the agent/gateway/observability tier; a handful of
 * components carry BSD-3, MPL-2.0, the PostgreSQL license, or GPL.
 */

export type Component = {
  name: string;
  license: string; // SPDX identifier
  layer: string; // architectural tier (informational)
  note: string;
};

export const COMPONENTS: Component[] = [
  // ---- Agent & gateway tier ----
  { name: 'LangGraph', license: 'MIT', layer: 'Agents', note: 'Agent runtime (retrieve → generate → trace).' },
  { name: 'LiteLLM', license: 'MIT', layer: 'Gateway', note: 'One governed model + MCP endpoint.' },
  { name: 'Langfuse', license: 'MIT', layer: 'Monitoring', note: 'Tracing, evals, cost — every action traced.' },
  { name: 'Haystack', license: 'Apache-2.0', layer: 'Agents', note: 'RAG retrieval pipeline over OpenSearch.' },

  // ---- Retrieval & knowledge tier ----
  { name: 'OpenSearch', license: 'Apache-2.0', layer: 'Knowledge', note: 'Vector + lexical retrieval store.' },
  { name: 'OpenSearch Dashboards', license: 'Apache-2.0', layer: 'Knowledge', note: 'Search/visualization UI over OpenSearch.' },
  { name: 'Docling', license: 'MIT', layer: 'Unstructured Data', note: 'Document → markdown parsing for the index.' },

  // ---- Lakehouse & data tier ----
  { name: 'Apache Iceberg', license: 'Apache-2.0', layer: 'Structured Data', note: 'Open table format for the lakehouse.' },
  { name: 'Apache Polaris', license: 'Apache-2.0', layer: 'Structured Data', note: 'Iceberg REST catalog.' },
  { name: 'Trino', license: 'Apache-2.0', layer: 'Structured Data', note: 'Distributed SQL query engine over Iceberg (query-tool).' },
  { name: 'dbt Core', license: 'Apache-2.0', layer: 'Structured Data', note: 'Transforms raw data into the warehouse.' },
  { name: 'Cube', license: 'Apache-2.0', layer: 'Metrics', note: 'Semantic / metrics layer over the warehouse.' },
  { name: 'OpenMetadata', license: 'Apache-2.0', layer: 'Governance', note: 'Data catalog + lineage + profiler.' },
  { name: 'Dagster', license: 'Apache-2.0', layer: 'Orchestration', note: 'Orchestrates the data tier (dbt assets).' },

  // ---- BI ----
  { name: 'Apache Superset', license: 'Apache-2.0', layer: 'Dashboards', note: 'Self-service dashboards & SQL Lab.' },

  // ---- Storage & infra ----
  { name: 'PostgreSQL', license: 'PostgreSQL', layer: 'Infrastructure', note: 'Infra database (via CloudNativePG operator).' },
  { name: 'CloudNativePG', license: 'Apache-2.0', layer: 'Infrastructure', note: 'Postgres operator.' },
  { name: 'ClickHouse', license: 'Apache-2.0', layer: 'Monitoring', note: "Langfuse v3's analytics backend." },
  { name: 'MinIO', license: 'AGPL-3.0', layer: 'Infrastructure', note: 'S3-compatible object storage (local stand-in).' },
  { name: 'Valkey', license: 'BSD-3-Clause', layer: 'Infrastructure', note: 'Redis-protocol queue/cache (not Redis).' },

  // ---- Delivery & GitOps ----
  { name: 'Forgejo', license: 'GPL-3.0-or-later', layer: 'Software', note: 'Sovereign Git hosting + Actions CI.' },
  { name: 'Argo CD', license: 'Apache-2.0', layer: 'Software', note: 'GitOps continuous delivery.' },

  // ---- Governance & egress ----
  { name: 'Open Policy Agent', license: 'Apache-2.0', layer: 'Governance', note: 'Default-deny tool authorization.' },
  { name: 'Ory', license: 'Apache-2.0', layer: 'Governance', note: 'Identity & roles.' },
  { name: 'tinyproxy', license: 'GPL-2.0-or-later', layer: 'Governance', note: 'Allowlist-only egress chokepoint.' },

  // ---- Science (Layer 4) ----
  { name: 'JupyterHub', license: 'BSD-3-Clause', layer: 'Science', note: 'Multi-user notebooks.' },
  { name: 'MLflow', license: 'Apache-2.0', layer: 'Science', note: 'Experiment tracking + model registry.' },
  { name: 'Featureform', license: 'MPL-2.0', layer: 'Science', note: 'Feature store / virtual feature engineering.' },
  { name: 'KServe', license: 'Apache-2.0', layer: 'Science', note: 'Model inference serving.' },

  // ---- OS UI tier ----
  { name: 'Next.js', license: 'MIT', layer: 'OS UI', note: 'App-router front door framework.' },
  { name: 'React', license: 'MIT', layer: 'OS UI', note: 'UI runtime.' },
  { name: 'TypeScript', license: 'Apache-2.0', layer: 'OS UI', note: 'Typed superset of JavaScript.' },
  { name: 'Supabase', license: 'Apache-2.0', layer: 'OS UI', note: 'Postgres + auth + RLS (app stack).' },
];

/** Group components by SPDX license, license keys sorted by component count. */
export function byLicense(): { license: string; items: Component[] }[] {
  const map = new Map<string, Component[]>();
  for (const c of COMPONENTS) {
    const list = map.get(c.license) ?? [];
    list.push(c);
    map.set(c.license, list);
  }
  return Array.from(map.entries())
    .map(([license, items]) => ({
      license,
      items: items.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.items.length - a.items.length || a.license.localeCompare(b.license));
}

export const TRADEMARK_NOTE =
  'The Sovereign Agentic OS core is licensed Apache-2.0. Each bundled component ' +
  'keeps its own license, shown above. "Sovereign Agentic OS" and "Data Masterclass" ' +
  'are trademarks of Borek Data Ventures UG. This project is not affiliated with, ' +
  'endorsed by, or sponsored by the Apache Software Foundation; "Apache" and the ' +
  'names of Apache projects are trademarks of the Apache Software Foundation.';
