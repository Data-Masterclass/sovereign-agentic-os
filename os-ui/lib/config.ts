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

// Like env(), but distinguishes "unset" from "set-but-empty". Used for the
// browser-reachable console URLs: when ingress is enabled but a tool has NO
// public host, the chart sets its console env var to an EXPLICIT empty string
// (soa.consoleUrl). That empty string must be honoured as "no public URL" so
// the UI HIDES that tool's "Open" link — NOT silently fall back to a localhost
// default (which would render a dead localhost link on a real deployment). When
// the var is genuinely unset (local dev / local-kind), we still use the
// port-forward fallback so local links keep working.
function consoleEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined ? fallback : v;
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

  // agent-runtime (shared LangGraph IR interpreter, Agents tab live execution):
  // POST {AGENT_RUNTIME_URL}/reload  {systemId, ir}  — register a compiled graph;
  // POST {AGENT_RUNTIME_URL}/run     {systemId, prompt, ...guards} — one invocation.
  // The runtime holds ONLY its scoped LiteLLM key + can reach ONLY LiteLLM, this
  // governed-tool endpoint and Forgejo-read (Cilium default-deny egress).
  agentRuntimeUrl: base(env('AGENT_RUNTIME_URL', 'http://agent-runtime:8000')),
  // Shared bearer the runtime presents to the os-ui governed-tool endpoint (the
  // ONLY way the runtime reaches OPA/Langfuse — it has neither itself). Server-only.
  agentRuntimeToken: env('AGENT_RUNTIME_TOKEN', 'dev-only-insecure-agent-runtime-token'),

  // ml-agent (LangGraph Science driver): GET {ML_AGENT_URL}/health, /models;
  // POST /run. Off by default (opt-in Science component); probed gracefully.
  mlAgentUrl: base(env('ML_AGENT_URL', 'http://ml-agent:8000')),

  // query-tool (governed, Trino): POST {QUERY_TOOL_URL}/query  {"sql": "..."}
  queryToolUrl: base(env('QUERY_TOOL_URL', 'http://query-tool:8000')),

  // sandbox-duckdb (personal/sandbox lane): ephemeral DuckDB scoped to the user's
  // private prefix ONLY (uploads + Trino-authorized extracts) — never governed
  // marts. POST {SANDBOX_DUCKDB_URL}/query {"sql": "..."}.
  sandboxDuckdbUrl: base(env('SANDBOX_DUCKDB_URL', 'http://sandbox-duckdb:8000')),

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
  // App registry index (Software golden path). Best-effort durable mirror of the
  // in-process app store; the OS UI degrades to in-memory when OpenSearch is off.
  appsIndex: env('APPS_INDEX', 'os-apps'),

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

  // Software golden path: per-app live subdomain suffix + image registry. Harbor
  // is a default-off heavy workload (chart `harbor.enabled`); locally CI uses
  // Forgejo's built-in OCI registry, so HARBOR_REGISTRY defaults to it.
  appsBaseDomain: env('OS_APPS_DOMAIN', 'apps.local'),
  harborEnabled: env('HARBOR_ENABLED', '') === 'true',
  harborRegistry: env('HARBOR_REGISTRY', 'forgejo-http:3000/gitea_admin'),

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

  // ---- In-UI Terminal. The OS UI mints a short-lived, single-use HMAC token
  // (signed with terminalBrokerSecret — the SAME value the terminal-broker
  // verifies with) only for an authenticated user whose role is in
  // terminalAllowedRoles. The browser then opens a WebSocket to the broker at
  // terminalBrokerWsUrl with that token. The broker spawns the locked-down
  // sandbox Pod. Default OFF; the secret is server-only and never reaches the
  // browser. terminalBrokerWsUrl is browser-reachable (ingress host on a deploy;
  // a `kubectl port-forward svc/terminal-broker 8090:8080` address locally). ----
  terminalEnabled: env('TERMINAL_ENABLED', '') === 'true',
  terminalAllowedRoles: env('TERMINAL_ALLOWED_ROLES', 'builder,admin')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean),
  terminalBrokerSecret: env('TERMINAL_BROKER_SECRET', 'dev-only-insecure-terminal-secret-change-me'),
  terminalBrokerWsUrl: env('TERMINAL_BROKER_WS', 'ws://localhost:8090/terminal'),

  // ---- Domain-Builder Workbench. The OS UI mints a short-lived single-use HMAC
  // token (signed with workbenchBrokerSecret — the SAME value the workbench-broker
  // verifies with) for an authenticated `builder` whose role is in
  // workbenchAllowedRoles, scoped to ONE of their domains. The browser then opens
  // their PERSISTENT code-server through the broker at workbenchBrokerUrl (which
  // reconciles + reverse-proxies it). Default OFF; the secret is server-only and
  // never reaches the browser. ----------------------------------------------
  workbenchEnabled: env('WORKBENCH_ENABLED', '') === 'true',
  workbenchAllowedRoles: env('WORKBENCH_ALLOWED_ROLES', 'builder,admin')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean),
  workbenchBrokerSecret: env('WORKBENCH_BROKER_SECRET', 'dev-only-insecure-workbench-secret-change-me'),
  workbenchBrokerUrl: base(env('WORKBENCH_BROKER_URL', 'http://localhost:8091')),

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
  // (e.g. an Ingress host) once each console is exposed. These use consoleEnv so
  // an EXPLICIT empty value from the chart (tool exposed via ingress but with no
  // public host) yields "" and the UI hides the "Open" link instead of linking
  // to a dead localhost address on a real deployment. -------------------------
  supersetUrl: base(consoleEnv('SUPERSET_URL', 'http://localhost:8088')),
  langfuseConsoleUrl: base(consoleEnv('LANGFUSE_CONSOLE_URL', 'http://localhost:3000')),
  forgejoConsoleUrl: base(consoleEnv('FORGEJO_CONSOLE_URL', 'http://localhost:3001')),
  argocdUrl: base(consoleEnv('ARGOCD_URL', 'http://localhost:8080')),
  openmetadataUrl: base(consoleEnv('OPENMETADATA_URL', 'http://localhost:8585')),
  dagsterConsoleUrl: base(consoleEnv('DAGSTER_CONSOLE_URL', 'http://localhost:3070')),
  opensearchDashboardsUrl: base(
    consoleEnv('OPENSEARCH_DASHBOARDS_URL', 'http://localhost:5601'),
  ),
  cubeConsoleUrl: base(consoleEnv('CUBE_CONSOLE_URL', 'http://localhost:4001')),

  // Layer-4 consoles (browser-reachable; default to local port-forwards).
  jupyterhubConsoleUrl: base(consoleEnv('JUPYTERHUB_CONSOLE_URL', 'http://localhost:8000')),
  mlflowConsoleUrl: base(consoleEnv('MLFLOW_CONSOLE_URL', 'http://localhost:5000')),
  featureformConsoleUrl: base(consoleEnv('FEATUREFORM_CONSOLE_URL', 'http://localhost:7878')),
  kserveConsoleUrl: base(consoleEnv('KSERVE_CONSOLE_URL', 'http://localhost:8080')),
} as const;

export type AppConfig = typeof config;
