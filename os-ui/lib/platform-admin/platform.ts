/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Platform / Components — native stack control plane (server-only).
 *
 * This is the OS UI's own implementation of what used to be the standalone
 * `admin-console` service: the single-source-of-truth component registry plus
 * live status (read the workload from the k8s API), on/off toggling (scale the
 * Deployment/StatefulSet 0<->1, with a core-guard) and the per-component docs.
 * The OS UI server already runs in-cluster with a scoped ServiceAccount, so it
 * does this directly — no cross-pod fetch to `admin-console:8080`.
 *
 * Registry fields:
 *   kind:   deploy | sts | cluster | job   (how to read/scale it)
 *   toggle: whether the UI may scale it 0<->1 (false = core / not a workload)
 */
import { config } from '@/lib/core/config';
import { k8s } from '@/lib/infra/k8s';

const NS = config.platformNamespace;

export type Component = {
  id: string;
  name: string;
  layer: string;
  kind: 'deploy' | 'sts' | 'cluster' | 'job';
  workload: string;
  svc: string;
  port: number;
  ui: boolean;
  url_path?: string;
  login: string;
  toggle: boolean;
  summary: string;
};

/** What the Components surface receives per component (registry + live state). */
export type ComponentView = Component & {
  ns: string;
  lport: number;
  status: string;
};

// --- component registry (single source of truth) ---------------------------
export const REGISTRY: Component[] = [
  // Infrastructure / data tier
  { id: 'minio', name: 'MinIO (object storage)', layer: 'Infrastructure', kind: 'deploy', workload: 'minio',
    svc: 'minio', port: 9001, ui: true, login: 'agentic-os-local / agentic-os-local-secret', toggle: true,
    summary: 'S3 object storage for the Iceberg lakehouse + Langfuse blobs.' },
  { id: 'postgres', name: 'PostgreSQL (CloudNativePG)', layer: 'Infrastructure', kind: 'cluster', workload: 'pg',
    svc: 'pg-rw', port: 5432, ui: false, login: 'per-database role (see doc)', toggle: false,
    summary: 'Operator-managed Postgres backing Langfuse, LiteLLM, Dagster, the warehouse, Polaris, Superset.' },
  { id: 'valkey', name: 'Valkey (cache)', layer: 'Infrastructure', kind: 'deploy', workload: 'valkey',
    svc: 'valkey', port: 6379, ui: false, login: 'password: valkey-local-dev', toggle: true,
    summary: 'Redis-protocol queue/cache for Langfuse (BSD-3, not Redis).' },
  { id: 'clickhouse', name: 'ClickHouse (analytics)', layer: 'Infrastructure', kind: 'deploy', workload: 'clickhouse',
    svc: 'clickhouse', port: 8123, ui: false, login: 'langfuse / clickhouse-local-dev', toggle: true,
    summary: 'Langfuse v3 analytics backend.' },
  // Layer 1 — agent core
  { id: 'langfuse', name: 'Langfuse (observability)', layer: 'Layer 1 — Agent core', kind: 'deploy',
    workload: 'agentic-os-langfuse-web', svc: 'agentic-os-langfuse-web', port: 3000, ui: true,
    login: 'admin@datamasterclass.com / langfuse-local-dev-admin', toggle: true,
    summary: 'Traces every agent action; the default Administrator console.' },
  { id: 'litellm', name: 'LiteLLM (model + MCP gateway)', layer: 'Layer 1 — Agent core', kind: 'deploy',
    workload: 'agentic-os-litellm', svc: 'agentic-os-litellm', port: 4000, ui: true, url_path: '/ui',
    login: 'admin / litellm-admin-local-dev  (master key sk-litellm-local-dev-master)', toggle: true,
    summary: 'One governed endpoint for models + MCP tools; per-key cost caps.' },
  { id: 'mock-model', name: 'Mock model (local LLM)', layer: 'Layer 1 — Agent core', kind: 'deploy',
    workload: 'mock-model', svc: 'mock-model', port: 8080, ui: false, login: 'none', toggle: true,
    summary: 'Tiny offline OpenAI-compatible stub LiteLLM routes to (sovereign demo).' },
  { id: 'opensearch', name: 'OpenSearch (retrieval)', layer: 'Layer 1 — Agent core', kind: 'sts',
    workload: 'opensearch-master', svc: 'opensearch', port: 9200, ui: false, login: 'none (security disabled locally)',
    toggle: true, summary: 'Vector + lexical retrieval backbone for RAG.' },
  // NB: system agents (domain RAG, ML agent, Hermes) are NOT platform components —
  // they live in lib/agents/system-agents.ts. This registry is infrastructure only.
  // Layer 2 — context
  { id: 'opa', name: 'OPA (policy)', layer: 'Layer 2 — Context', kind: 'deploy', workload: 'opa',
    svc: 'opa', port: 8181, ui: false, login: 'none', toggle: true,
    summary: 'Default-deny tool authorization at the MCP/tool boundary.' },
  { id: 'haystack', name: 'Haystack (RAG pipeline)', layer: 'Layer 2 — Context', kind: 'deploy',
    workload: 'haystack', svc: 'haystack', port: 8000, ui: false, login: 'none', toggle: true,
    summary: 'RAG retrieval pipeline over OpenSearch, embedding via LiteLLM.' },
  { id: 'dagster', name: 'Dagster (orchestrator)', layer: 'Layer 2 — Context', kind: 'deploy',
    workload: 'agentic-os-dagster-webserver', svc: 'agentic-os-dagster-webserver', port: 80, ui: true,
    login: 'none', toggle: true, summary: 'Orchestrates dbt + ingestion + metadata crawls.' },
  { id: 'dbt', name: 'dbt (transforms)', layer: 'Layer 2 — Context', kind: 'job', workload: '',
    svc: '', port: 0, ui: false, login: 'n/a (runs as a Job / Dagster asset)', toggle: false,
    summary: 'Builds the analytics warehouse (seed -> staging -> mart).' },
  { id: 'cube', name: 'Cube (metrics)', layer: 'Layer 2 — Context', kind: 'deploy', workload: 'cube',
    svc: 'cube', port: 4000, ui: true, login: 'none (dev playground)', toggle: true,
    summary: 'Semantic/metrics layer over the dbt warehouse.' },
  { id: 'docling', name: 'Docling (doc parsing)', layer: 'Layer 2 — Context', kind: 'deploy', workload: 'docling',
    svc: 'docling', port: 5001, ui: false, login: 'none', toggle: true,
    summary: 'Parses uploaded documents into markdown for the knowledge index. (Off by default locally.)' },
  { id: 'openmetadata', name: 'OpenMetadata (catalog)', layer: 'Layer 2 — Context', kind: 'deploy',
    workload: 'openmetadata', svc: 'openmetadata', port: 8585, ui: true,
    login: 'admin@open-metadata.org / admin', toggle: true,
    summary: 'Catalog + lineage. (Off by default locally for RAM.)' },
  { id: 'opensearch-dashboards', name: 'OpenSearch Dashboards', layer: 'Layer 2 — Context', kind: 'deploy',
    workload: 'opensearch-dashboards', svc: 'opensearch-dashboards', port: 5601, ui: true, login: 'none',
    toggle: true, summary: 'Search/visualization UI over OpenSearch. (Off by default locally.)' },
  // Layer 3 — self-service
  { id: 'polaris', name: 'Polaris (Iceberg catalog)', layer: 'Layer 3 — Self-service', kind: 'deploy',
    workload: 'polaris', svc: 'polaris', port: 8182, ui: false,
    login: 'OAuth2 root / polaris-local-dev-secret', toggle: true,
    summary: 'Iceberg REST catalog for the lakehouse.' },
  { id: 'query-tool', name: 'Trino query tool (MCP)', layer: 'Layer 3 — Self-service', kind: 'deploy',
    workload: 'query-tool', svc: 'query-tool', port: 8000, ui: false,
    login: 'via LiteLLM MCP (sk-litellm-local-dev-master)', toggle: true,
    summary: 'Governed query engine: Trino over Iceberg; an MCP tool in LiteLLM.' },
  { id: 'superset', name: 'Superset (dashboards/BI)', layer: 'Layer 3 — Self-service', kind: 'deploy',
    workload: 'agentic-os-superset', svc: 'agentic-os-superset', port: 8088, ui: true,
    login: 'admin / superset-admin-local-dev', toggle: true,
    summary: 'Dashboards on the dbt warehouse / Cube.' },
  { id: 'forgejo', name: 'Forgejo (git)', layer: 'Layer 3 — Self-service', kind: 'deploy', workload: 'forgejo',
    svc: 'forgejo-http', port: 3000, ui: true, login: 'gitea_admin / forgejo-admin-local-dev', toggle: true,
    summary: 'Self-hosted git for the Software golden path.' },
  { id: 'argocd', name: 'Argo CD (GitOps)', layer: 'Layer 3 — Self-service', kind: 'deploy',
    workload: 'argocd-server', svc: 'argocd-server', port: 80, ui: true,
    login: 'admin / (kubectl get secret argocd-initial-admin-secret)', toggle: false,
    summary: 'Deploys apps from Forgejo repos into per-domain namespaces.' },
  { id: 'ci-runner', name: 'CI runner (Forgejo Actions)', layer: 'Layer 3 — Self-service', kind: 'deploy',
    workload: 'ci-runner', svc: '', port: 0, ui: false, login: 'none (registered to Forgejo)', toggle: true,
    summary: 'Executes CI workflows on push (act_runner + DinD); completes push -> CI -> deploy.' },
  // Security baseline
  { id: 'egress-proxy', name: 'Egress proxy', layer: 'Security baseline', kind: 'deploy', workload: 'egress-proxy',
    svc: 'egress-proxy', port: 3128, ui: false, login: 'none', toggle: true,
    summary: 'The single outbound chokepoint (allowlist forward proxy).' },
  { id: 'web-fetch', name: 'Governed web_fetch tool', layer: 'Security baseline', kind: 'deploy',
    workload: 'web-fetch', svc: 'web-fetch', port: 8000, ui: false, login: 'none (OPA-gated)', toggle: true,
    summary: 'The only sanctioned path to the web: OPA-authorized, proxied, sanitized.' },
  // Layer 4 — Science / ML (opt-in; off by default — heavy)
  { id: 'mlflow', name: 'MLflow (experiments/registry)', layer: 'Layer 4 — Science', kind: 'deploy',
    workload: 'mlflow', svc: 'mlflow', port: 5000, ui: true, login: 'none (in-cluster)', toggle: true,
    summary: 'ML experiment tracking + model registry; artifacts in object storage.' },
  { id: 'jupyterhub', name: 'JupyterHub (notebooks)', layer: 'Layer 4 — Science', kind: 'deploy',
    workload: 'hub', svc: 'proxy-public', port: 80, ui: true, login: 'any user / jupyter-local-dev',
    toggle: true, summary: 'Multi-user notebooks (Zero-to-JupyterHub). Off by default (heavy).' },
  { id: 'featureform', name: 'Featureform (feature store)', layer: 'Layer 4 — Science', kind: 'deploy',
    workload: 'featureform', svc: 'featureform', port: 7878, ui: false, login: 'none', toggle: true,
    summary: 'Feature store (MPL-2.0, optional); online store = Valkey. Off by default.' },
  { id: 'ml-agent', name: 'ML agent (LangGraph)', layer: 'Layer 4 — Science', kind: 'deploy',
    workload: 'ml-agent', svc: 'ml-agent', port: 8000, ui: false, login: 'none', toggle: true,
    summary: 'Plans features->train->deploy via LiteLLM; lists the model registry. Off by default.' },
  // Platform / front door
  { id: 'os-ui', name: 'OS UI (front door)', layer: 'Platform', kind: 'deploy', workload: 'os-ui',
    svc: 'os-ui', port: 3000, ui: true, login: 'none (open locally)', toggle: false,
    summary: 'The Next.js front door + control plane: Home / Agents / Data / Monitoring / Components.' },
];

export const BY_ID: Record<string, Component> = Object.fromEntries(
  REGISTRY.map((c) => [c.id, c]),
);

// --- k8s helpers -----------------------------------------------------------
function workloadPath(c: Component, scale = false): string | null {
  const kind = c.kind === 'deploy' ? 'deployments' : c.kind === 'sts' ? 'statefulsets' : null;
  if (!kind) return null;
  const p = `/apis/apps/v1/namespaces/${NS}/${kind}/${c.workload}`;
  return scale ? `${p}/scale` : p;
}

export async function statusOf(c: Component): Promise<string> {
  if (c.kind === 'cluster') {
    const { status, body } = await k8s(
      'GET',
      `/apis/postgresql.cnpg.io/v1/namespaces/${NS}/clusters/${c.workload}`,
    );
    if (status === 200) {
      const st = (body.status ?? {}) as Record<string, unknown>;
      const ready = Number(st.readyInstances ?? 0) || 0;
      return ready > 0 ? 'running' : 'stopped';
    }
    // No CloudNativePG Cluster of this name — the self-contained / STACKIT profiles
    // ship Postgres as a plain StatefulSet of the same name. Fall back to a STS check
    // so a healthy `pg` isn't mislabeled "not deployed".
    const sts = await k8s('GET', `/apis/apps/v1/namespaces/${NS}/statefulsets/${c.workload}`);
    if (sts.status === 200) {
      const st = (sts.body.status ?? {}) as Record<string, unknown>;
      const ready = Number(st.readyReplicas ?? 0) || 0;
      return ready > 0 ? 'running' : 'stopped';
    }
    return 'unknown';
  }
  // Job-based components (e.g. dbt via Dagster) have no standing workload — they run
  // on demand, so "on-demand" is the honest status, not "not deployed".
  if (c.kind === 'job') return 'on-demand';
  if (!c.workload) return 'n/a';

  const p = workloadPath(c);
  if (!p) return 'unknown';
  const { status, body } = await k8s('GET', p);
  if (status === 404) return 'disabled';
  if (status !== 200) return 'unknown';
  const spec = (body.spec ?? {}) as Record<string, unknown>;
  const st = (body.status ?? {}) as Record<string, unknown>;
  const replicas = Number(spec.replicas ?? 0) || 0;
  const ready = Number(st.readyReplicas ?? 0) || 0;
  if (replicas === 0) return 'off';
  return ready > 0 ? 'running' : 'starting';
}

export type ToggleResult = { ok: boolean; msg: string };

export async function toggleComponent(id: string): Promise<ToggleResult> {
  const c = BY_ID[id];
  if (!c) return { ok: false, msg: 'unknown component' };
  if (!c.toggle) return { ok: false, msg: 'not toggleable' };
  const cur = await statusOf(c);
  const target = cur === 'running' || cur === 'starting' ? 0 : 1;
  const p = workloadPath(c, true);
  if (!p) return { ok: false, msg: 'not scalable' };
  const { status } = await k8s('PATCH', p, { spec: { replicas: target } });
  const ok = status === 200 || status === 201;
  return { ok, msg: ok ? `scaled to ${target}` : `scale failed (${status})` };
}

/** The full registry with namespace, local port + live status resolved. */
export async function listComponentsWithStatus(): Promise<ComponentView[]> {
  return Promise.all(
    REGISTRY.map(async (c) => ({
      ...c,
      ns: NS,
      lport: c.port,
      status: await statusOf(c),
    })),
  );
}
