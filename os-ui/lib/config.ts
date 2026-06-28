/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Server-side backend configuration for the OS UI.
 *
 * Every backend base URL is env-configurable so the same image runs both
 * in-cluster (defaults below = the in-cluster Service names) and locally
 * (point the vars at `kubectl port-forward` addresses). This module is
 * server-only: it is imported exclusively by API routes + server components,
 * so credentials/keys never reach the browser.
 */

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

// Trim a single trailing slash so we can safely append paths.
function base(url: string): string {
  return url.replace(/\/+$/, '');
}

export const config = {
  // sample-agent (LangGraph RAG): GET {SAMPLE_AGENT_URL}/ask?q=...
  sampleAgentUrl: base(env('SAMPLE_AGENT_URL', 'http://sample-agent:8000')),

  // poet-agent (LangGraph compose→save): GET {POET_AGENT_URL}/write?topic=...
  poetAgentUrl: base(env('POET_AGENT_URL', 'http://poet-agent:8000')),

  // ml-agent (LangGraph Science driver): GET {ML_AGENT_URL}/health, /models;
  // POST /run. Off by default (opt-in Science component); probed gracefully.
  mlAgentUrl: base(env('ML_AGENT_URL', 'http://ml-agent:8000')),

  // query-tool (DuckDB/Iceberg): POST {QUERY_TOOL_URL}/query  {"sql": "..."}
  queryToolUrl: base(env('QUERY_TOOL_URL', 'http://query-tool:8000')),

  // Langfuse: GET {LANGFUSE_URL}/api/public/traces  (HTTP basic auth)
  langfuseUrl: base(env('LANGFUSE_URL', 'http://agentic-os-langfuse-web:3000')),
  langfusePublicKey: env('LANGFUSE_PUBLIC_KEY', 'pk-lf-localdev0000public'),
  langfuseSecretKey: env('LANGFUSE_SECRET_KEY', 'sk-lf-localdev0000secret'),

  // OpenSearch (Knowledge / Search): GET/POST {OPENSEARCH_URL}/knowledge/_search
  // Security plugin is disabled locally (no auth); on STACKIT enable security+TLS.
  opensearchUrl: base(env('OPENSEARCH_URL', 'http://opensearch:9200')),
  knowledgeIndex: env('KNOWLEDGE_INDEX', 'knowledge'),
  // Artifact-metadata index (workspace lifecycle store). Best-effort durable
  // mirror of the artifact registry; the OS UI degrades to an in-process store
  // when OpenSearch is unreachable so the teaching flows work offline.
  artifactsIndex: env('ARTIFACTS_INDEX', 'os-artifacts'),

  // ---- Identity (pragmatic, Ory-replaceable). OS_USERS is a JSON array of
  // seeded users { id, name, password, domain, role }. OS_SESSION_SECRET signs
  // the session cookie (HMAC-SHA256). Both are server-only. Replace this whole
  // block with Ory (Kratos/Hydra) later without touching the consumers. -------
  sessionSecret: env(
    'OS_SESSION_SECRET',
    'dev-only-insecure-session-secret-change-me-in-prod',
  ),
  usersSeed: env('OS_USERS', ''),

  // Forgejo (Software / Delivery): GET {FORGEJO_URL}/api/v1/...  (HTTP basic auth)
  forgejoUrl: base(env('FORGEJO_URL', 'http://forgejo-http:3000')),
  forgejoUser: env('FORGEJO_USER', 'gitea_admin'),
  forgejoPassword: env('FORGEJO_PASSWORD', 'forgejo-admin-local-dev'),
  forgejoRepoOwner: env('FORGEJO_REPO_OWNER', 'gitea_admin'),
  forgejoDemoRepo: env('FORGEJO_DEMO_REPO', 'demo-app'),

  // LiteLLM gateway (Models & Tools): GET {LITELLM_URL}/v1/models +
  // {LITELLM_URL}/v1/mcp/tools  (Bearer master key).
  litellmUrl: base(env('LITELLM_URL', 'http://agentic-os-litellm:4000')),
  litellmMasterKey: env('LITELLM_MASTER_KEY', 'sk-litellm-local-dev-master'),
  // Chat model fronted by LiteLLM that the task-scoped agent chat windows call
  // (POST {LITELLM_URL}/v1/chat/completions). Offline default = the mock model.
  litellmChatModel: env('LITELLM_CHAT_MODEL', 'sovereign-mock'),

  // OPA (Policy): POST {OPA_URL}/v1/data/agentic/authz/allow and
  // GET {OPA_URL}/v1/data/grants for the principal -> tools grant map.
  opaUrl: base(env('OPA_URL', 'http://opa:8181')),

  // Platform / Components surface — namespace the stack workloads live in. The
  // OS UI server reads their status + scales them 0<->1 NATIVELY via the
  // in-cluster Kubernetes API using the pod's scoped ServiceAccount (see
  // lib/platform.ts + lib/k8s.ts). This replaces the former server-side proxy to
  // the standalone `admin-console` service — there is no cross-pod hop anymore.
  platformNamespace: env('NAMESPACE', env('OS_NAMESPACE', 'agentic-os')),

  // Dagster (Orchestration): POST {DAGSTER_URL}/graphql (no auth locally).
  dagsterUrl: base(env('DAGSTER_URL', 'http://agentic-os-dagster-webserver:80')),

  // Cube (Metrics / semantic layer): POST {CUBE_URL}/cubejs-api/v1/load
  // with a Cube query. No auth in dev (CUBEJS_DEV_MODE); add a JWT on STACKIT.
  cubeUrl: base(env('CUBE_URL', 'http://cube:4000')),

  // OpenMetadata (catalog & lineage): server-side REST API base. OFF by default
  // locally (~2.5 GB JVM) — the Data/Unstructured surfaces probe it and degrade
  // to the query-tool catalog / OpenSearch index when it's unreachable.
  openmetadataApiUrl: base(env('OPENMETADATA_API_URL', 'http://openmetadata:8585')),

  // ---- Layer-4 (Science / ML) backends. Off by default; the Science surface
  // pings these server-side and degrades gracefully when a service is absent.
  // In-cluster Service defaults; point at port-forwards locally. -------------
  jupyterhubUrl: base(env('JUPYTERHUB_URL', 'http://proxy-public:80')),
  mlflowUrl: base(env('MLFLOW_URL', 'http://mlflow:5000')),
  featureformUrl: base(env('FEATUREFORM_URL', 'http://featureform:7878')),
  kserveUrl: base(env('KSERVE_URL', 'http://kserve:80')),

  // ---- Deployment identity (read-only, surfaced on Settings; non-secret) ----
  deploymentProfile: env('OS_PROFILE', 'local'),
  deploymentNamespace: env('OS_NAMESPACE', 'agentic-os'),
  deploymentTenant: env('OS_TENANT', 'data-masterclass'),
  deploymentDomain: env('OS_DOMAIN', 'data-masterclass'),
  osVersion: env('OS_VERSION', '1.0.0'),

  // ---- Browser-reachable consoles (opened/linked from the browser, never
  // proxied; each tool has its own auth + session). Default to the local
  // port-forward addresses from docs/components/*.md; override per environment
  // (e.g. an Ingress host) once each console is exposed. -----------------------
  supersetUrl: base(env('SUPERSET_URL', 'http://localhost:8088')),
  langfuseConsoleUrl: base(env('LANGFUSE_CONSOLE_URL', 'http://localhost:3000')),
  forgejoConsoleUrl: base(env('FORGEJO_CONSOLE_URL', 'http://localhost:3001')),
  argocdUrl: base(env('ARGOCD_URL', 'http://localhost:8080')),
  openmetadataUrl: base(env('OPENMETADATA_URL', 'http://localhost:8585')),
  dagsterConsoleUrl: base(env('DAGSTER_CONSOLE_URL', 'http://localhost:3070')),
  opensearchDashboardsUrl: base(
    env('OPENSEARCH_DASHBOARDS_URL', 'http://localhost:5601'),
  ),
  cubeConsoleUrl: base(env('CUBE_CONSOLE_URL', 'http://localhost:4001')),

  // Layer-4 consoles (browser-reachable; default to local port-forwards).
  jupyterhubConsoleUrl: base(env('JUPYTERHUB_CONSOLE_URL', 'http://localhost:8000')),
  mlflowConsoleUrl: base(env('MLFLOW_CONSOLE_URL', 'http://localhost:5000')),
  featureformConsoleUrl: base(env('FEATUREFORM_CONSOLE_URL', 'http://localhost:7878')),
  kserveConsoleUrl: base(env('KSERVE_CONSOLE_URL', 'http://localhost:8080')),
} as const;

export type AppConfig = typeof config;
