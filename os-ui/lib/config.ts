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

  // agent-runtime (shared LangGraph IR interpreter, Agents tab live execution):
  // POST {AGENT_RUNTIME_URL}/reload  {systemId, ir}  — register a compiled graph;
  // POST {AGENT_RUNTIME_URL}/run     {systemId, prompt, ...guards} — one invocation.
  // The runtime holds ONLY its scoped LiteLLM key + can reach ONLY LiteLLM, this
  // governed-tool endpoint and Forgejo-read (Cilium default-deny egress).
  agentRuntimeUrl: base(env('AGENT_RUNTIME_URL', 'http://agent-runtime:8000')),
  // Shared bearer the runtime presents to the os-ui governed-tool endpoint (the
  // ONLY way the runtime reaches OPA/Langfuse — it has neither itself). Server-only.
  agentRuntimeToken: env('AGENT_RUNTIME_TOKEN', 'dev-only-insecure-agent-runtime-token'),
  // Agent SCHEDULE CronJobs (Agents tab). Saving a `cron` schedule provisions a
  // batch/v1 CronJob in the platform namespace that curls the scheduled-run
  // receiver below with the shared runtime bearer. The bearer is read at run time
  // from a Secret (never baked into the CronJob spec) — its name/key are
  // env-configurable so this tracks whatever Secret mounts AGENT_RUNTIME_TOKEN.
  scheduledRunUrl: base(env('SCHEDULED_RUN_URL', 'http://os-ui:3000/api/agents/scheduled-run')),
  scheduleCronImage: env('SCHEDULE_CRON_IMAGE', 'curlimages/curl:8.11.1'),
  agentRuntimeTokenSecret: env('AGENT_RUNTIME_TOKEN_SECRET', 'os-ui'),
  agentRuntimeTokenSecretKey: env('AGENT_RUNTIME_TOKEN_SECRET_KEY', 'agent-runtime-token'),

  // ml-agent (LangGraph Science driver): GET {ML_AGENT_URL}/health, /models;
  // POST /run. Off by default (opt-in Science component); probed gracefully.
  mlAgentUrl: base(env('ML_AGENT_URL', 'http://ml-agent:8000')),

  // query-tool (governed, Trino): POST {QUERY_TOOL_URL}/query  {"sql": "..."}
  queryToolUrl: base(env('QUERY_TOOL_URL', 'http://query-tool:8000')),

  // data-runner (real INGEST): POST {DATA_RUNNER_URL}/ingest {principal, dataset,
  // objectKey} — reads an uploaded file from MinIO and writes a PHYSICAL Iceberg
  // Bronze table `iceberg.personal_<uid>.bronze_<slug>` via Polaris. Cluster-internal
  // only (the trusted os-ui backend supplies `principal`, session-bound). When the
  // runner is unreachable (laptop) the Data-tab upload degrades to the honest
  // offline-mock so the teaching flow still runs.
  dataRunnerUrl: base(env('DATA_RUNNER_URL', 'http://data-runner:8000')),

  // Object storage (MinIO / STACKIT Object Storage) — the Data-tab upload streams
  // a file to `s3://<uploadsBucket>/uploads/<uid>/<file>` (path-style SigV4 PUT,
  // lib/data/object-store.ts) before calling the runner. Server-only creds; the
  // SAME `object-storage-credentials` Secret + `soa.s3Endpoint` the lakehouse uses.
  s3Endpoint: base(env('S3_ENDPOINT', 'http://minio:9000')),
  s3Region: env('S3_REGION', 'us-east-1'),
  s3PathStyle: env('S3_PATH_STYLE', 'true').toLowerCase() !== 'false',
  uploadsBucket: env('UPLOADS_BUCKET', 'lakehouse'),
  // The governed Files-tab object store. Uploaded originals live under the store's
  // prefix invariant `s3://files/<owner|domain>/…` (lib/files/asset-schema.ts →
  // objectPrefixFor); this bucket name is the `files` in that scheme.
  filesBucket: env('FILES_BUCKET', 'files'),
  awsAccessKeyId: env('AWS_ACCESS_KEY_ID', ''),
  awsSecretAccessKey: env('AWS_SECRET_ACCESS_KEY', ''),
  // M1 upload cap (documented). Streams a single buffered PUT; ~100 MB keeps the
  // os-ui pod memory bounded. Larger loads are an M2 connector (dlt source) job.
  uploadMaxBytes: Number(env('UPLOAD_MAX_BYTES', String(100 * 1024 * 1024))) || 100 * 1024 * 1024,

  // (Removed) sandbox-duckdb personal-query engine — the second engine. The personal
  // lane now reads through the SAME governed Trino path (owner-principal); there is
  // no separate query engine.

  // Langfuse: GET {LANGFUSE_URL}/api/public/traces  (HTTP basic auth)
  langfuseUrl: base(env('LANGFUSE_URL', 'http://agentic-os-langfuse-web:3000')),
  langfusePublicKey: env('LANGFUSE_PUBLIC_KEY', 'pk-lf-localdev0000public'),
  langfuseSecretKey: env('LANGFUSE_SECRET_KEY', 'sk-lf-localdev0000secret'),
  // Langfuse SSO service account (server-only). Langfuse authenticates with
  // NextAuth — no trusted-header remote-user mode — so the /tools/langfuse proxy
  // signs in server-side with THIS account and injects the resulting session
  // cookie (lib/tool-sso-langfuse.ts). The password NEVER reaches the browser.
  // Defaults to the local headless-init user; on STACKIT point these at a
  // dedicated read-only (VIEWER) Langfuse account via the os-ui Secret.
  langfuseSsoEmail: env('LANGFUSE_SSO_EMAIL', 'alex@datamasterclass.com'),
  langfuseSsoPassword: env('LANGFUSE_SSO_PASSWORD', 'langfuse-local-dev-admin'),

  // OpenSearch (Knowledge / Search): GET/POST {OPENSEARCH_URL}/knowledge/_search
  // Security plugin is disabled locally (no auth); on STACKIT enable security+TLS.
  opensearchUrl: base(env('OPENSEARCH_URL', 'http://opensearch:9200')),
  knowledgeIndex: env('KNOWLEDGE_INDEX', 'knowledge'),
  // Knowledge context layer (Knowledge tab). The `sovereign-embed` LiteLLM model
  // (mock-model on kind) emits deterministic 384-dim vectors; the dim MUST match
  // opensearch.knnDimension (chart `retrieval.knnDimension`). When LiteLLM is
  // unreachable the index/retrieve pipeline falls back to a deterministic local
  // hash embedding of the SAME dim, so cosine ranking still works offline.
  embedModel: env('KNOWLEDGE_EMBED_MODEL', 'sovereign-embed'),
  embedDim: Number(env('KNOWLEDGE_EMBED_DIM', '384')) || 384,
  // Artifact-metadata index (workspace lifecycle store). Best-effort durable
  // mirror of the artifact registry; the OS UI degrades to an in-process store
  // when OpenSearch is unreachable so the teaching flows work offline.
  artifactsIndex: env('ARTIFACTS_INDEX', 'os-artifacts'),
  // App registry index (Software golden path). Best-effort durable mirror of the
  // in-process app store; the OS UI degrades to in-memory when OpenSearch is off.
  appsIndex: env('APPS_INDEX', 'os-apps'),
  // Dataset registry index (Data tab). Best-effort durable mirror of the
  // in-process dataset store so seeded datasets/metrics survive an os-ui restart;
  // degrades to in-memory when OpenSearch is off.
  datasetsIndex: env('DATASETS_INDEX', 'os-datasets'),
  // Domain registry index (Platform-Admin). Durable mirror of the domain store;
  // when it is empty (or OpenSearch is off) the domains are DERIVED from the
  // tenant's users so Admin → Domains reflects the real tenant, never 0.
  domainsIndex: env('DOMAINS_INDEX', 'os-domains'),

  // ---- Files tab (unstructured context products). The `files` hybrid index, the
  // shared embedding model + its k-NN dimension, and the ingest-by-type services.
  // The OS UI degrades to a deterministic in-process mock for every one of these
  // when the service is unreachable (kind), so the golden path runs offline. ----
  filesIndex: env('FILES_INDEX', 'files'),
  // The SHARED embedding model fronted by LiteLLM (kind: sovereign-embed@384;
  // STACKIT: Qwen3-VL-Embedding-8B@4096 via STACKIT-managed inference). NEVER
  // hardcode the dim — the helm template wires FILES_EMBED_DIM from
  // `retrieval.knnDimension` (the single source), so changing the model + dim
  // reindexes consistently.
  filesEmbedModel: env('FILES_EMBED_MODEL', 'sovereign-embed'),
  filesEmbedDim: Number(env('FILES_EMBED_DIM', '384')),
  // Ingest-by-type services (Phase 3). Docling (docs), a transcriber (audio/video),
  // an OCR/caption service (images). In-cluster Service defaults; the live adapters
  // fall back to the deterministic mock when these are absent.
  doclingUrl: base(env('DOCLING_URL', 'http://docling:5001')),
  transcribeUrl: base(env('TRANSCRIBE_URL', 'http://whisper:9000')),
  ocrUrl: base(env('OCR_URL', 'http://ocr-caption:8000')),

  // ---- Identity (pragmatic, Ory-replaceable). OS_USERS is a JSON array of
  // seeded users { id, name, password, domain, role }. OS_SESSION_SECRET signs
  // the session cookie (HMAC-SHA256). Both are server-only. Replace this whole
  // block with Ory (Kratos/Hydra) later without touching the consumers. -------
  sessionSecret: env(
    'OS_SESSION_SECRET',
    'dev-only-insecure-session-secret-change-me-in-prod',
  ),
  usersSeed: env('OS_USERS', ''),
  // Signs the per-user bearer token for the remote MCP endpoint (/api/mcp).
  // Server-only. Falls back to the session secret so the endpoint works out of
  // the box; set OS_MCP_TOKEN_SECRET in prod to rotate MCP tokens independently.
  mcpTokenSecret: env(
    'OS_MCP_TOKEN_SECRET',
    env('OS_SESSION_SECRET', 'dev-only-insecure-session-secret-change-me-in-prod'),
  ),

  // ---- Outbound email (OPTIONAL). Transactional mail (email verification today;
  // user invites later) goes through a small, dependency-free PLUGGABLE mailer
  // (lib/mailer.ts) with two transports, selected by config (Graph > SMTP > none):
  //   • Graph (recommended for M365, avoids SMTP-AUTH deprecation): set
  //     GRAPH_TENANT_ID + GRAPH_CLIENT_ID + GRAPH_CLIENT_SECRET (+ MAIL_FROM).
  //   • SMTP (generic fallback): set SMTP_HOST (+ PORT/USER/PASS/FROM/SECURE).
  // The mailer reads these LIVE from the environment (testable without a reload).
  // With NEITHER configured the platform works fully without email: the first-run
  // bootstrap admin auto-verifies and later accounts are active immediately.
  // Secrets (GRAPH_CLIENT_SECRET, SMTP_PASS) come from k8s Secrets, never
  // committed. MAIL_FROM/SMTP_FROM default to support@datamasterclass.com.
  // OS_EMAIL_VERIFICATION=false force-disables verification even with a mailer.
  // OS_PUBLIC_URL sets the absolute base used in emailed links. See lib/mailer.ts.

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

  // Software golden path — Phase 2 in-cluster app RUNNER (lib/software/runner.ts).
  // A go-live provisions a real Deployment+Service+Ingress for the built app into
  // a dedicated runner namespace, on the app's per-app host (App.subdomain). The
  // image is the app's CI-published registry artifact by default; set
  // SOFTWARE_RUNNER_IMAGE to a known-good prebuilt image (e.g. traefik/whoami) to
  // serve every app from a teaching placeholder until its own image is published.
  // Ingress class + TLS issuer MATCH the chart's tool ingress (ingress.className /
  // ingress.tlsIssuer) so per-app hosts get a cert-manager cert exactly like the
  // consoles. When the k8s API is unreachable the runner degrades honestly (no URL).
  softwareRunnerNamespace: env('SOFTWARE_RUNNER_NAMESPACE', 'agentic-apps'),
  softwareRunnerImage: env('SOFTWARE_RUNNER_IMAGE', ''),
  appsIngressClass: env('OS_APPS_INGRESS_CLASS', 'nginx'),
  appsTlsIssuer: env('OS_APPS_TLS_ISSUER', 'letsencrypt-prod'),

  // Hermes autonomous runtime (Layer 1, opt-in). GATED OFF by default — the chart
  // sets HERMES_ENABLED=true only when `hermes.enabled` is on (never in base/kind).
  // When off the Agent tab still SHOWS the runtime option (documented) but the
  // gateway is not provisioned. The gateway (when on) reaches models ONLY via
  // LiteLLM and tools ONLY via the governed /api/mcp surface.
  hermesEnabled: env('HERMES_ENABLED', '') === 'true',
  hermesGatewayUrl: base(env('HERMES_GATEWAY_URL', 'http://hermes-gateway:8080')),

  // LiteLLM gateway (Models & Tools): GET {LITELLM_URL}/v1/models +
  // {LITELLM_URL}/v1/mcp/tools  (Bearer master key).
  litellmUrl: base(env('LITELLM_URL', 'http://agentic-os-litellm:4000')),
  litellmMasterKey: env('LITELLM_MASTER_KEY', 'sk-litellm-local-dev-master'),
  // Chat model fronted by LiteLLM that the task-scoped agent chat windows call
  // (POST {LITELLM_URL}/v1/chat/completions). Offline default = the mock model.
  litellmChatModel: env('LITELLM_CHAT_MODEL', 'sovereign-mock'),
  // Two-tier models for the agentic assistant harness (lib/assistant). PLAN once
  // with the reasoning tier, then ACT (tool-calling) with the cheap-first light
  // tier — both self-hosted STACKIT Qwen with thinking disabled. Offline these
  // fall back to the mock chat model so the loop still runs on a laptop.
  litellmReasoningModel: env('LITELLM_REASONING_MODEL', env('LITELLM_CHAT_MODEL', 'sovereign-reasoning')),
  litellmExecModel: env('LITELLM_EXEC_MODEL', env('LITELLM_CHAT_MODEL', 'sovereign-default')),
  // Ask-the-OS assistant: max PLAN→ACT tool-call rounds per turn. Raised from the
  // original 8 so multi-step builds (ingest → silver → gold → metric → publish) can
  // complete in one conversation. Tunable via env without a rebuild.
  assistantMaxSteps: Number(env('ASSISTANT_MAX_STEPS', '')) || 20,
  // LLM Gateway tab — the read-only, tenant-total usage/spend panel
  // (app/api/gateway/usage). The budget envelope is surfaced for the "budget
  // used" bar; it mirrors the chart's litellmAgentKey.maxBudget / budgetDuration
  // (USD cap + reset window). Read-only; no key or per-user datum reaches the
  // browser — the master key stays server-side in the usage route.
  litellmBudgetUsd: Number(env('LITELLM_BUDGET_USD', '5')) || 0,
  litellmBudgetWindow: env('LITELLM_BUDGET_WINDOW', 'weekly'),

  // OPA (Policy): POST {OPA_URL}/v1/data/agentic/authz/allow and
  // GET {OPA_URL}/v1/data/grants for the principal -> tools grant map.
  opaUrl: base(env('OPA_URL', 'http://opa:8181')),
  // Data-authz FAIL MODE. Default DENY-by-default: if OPA is unreachable/errors
  // the governed data spine (`lib/governed.ts`) DENIES — consistent with the
  // agent spine. Set OPA_FAIL_OPEN=true ONLY for the offline-mock teaching flow
  // on a laptop with no OPA; a LIVE cluster must leave this unset so an OPA
  // outage cannot silently open every metrics/query authz.
  opaFailOpen: env('OPA_FAIL_OPEN', '').toLowerCase() === 'true',

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
  // consoleEnv (NOT env): when ingress is on but ingress.hosts.terminal is unset,
  // the chart renders TERMINAL_BROKER_WS="" (soa.terminalWsUrl). That explicit
  // empty must surface as "not reachable on this deployment" — not silently fall
  // back to a dead ws://localhost the browser can never reach on a real deploy.
  terminalBrokerWsUrl: consoleEnv('TERMINAL_BROKER_WS', 'ws://localhost:8090/terminal'),

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
  // consoleEnv for the same reason as terminalBrokerWsUrl above (chart renders
  // "" when ingress.hosts.workbench is unset — honour it, don't dial localhost).
  workbenchBrokerUrl: base(consoleEnv('WORKBENCH_BROKER_URL', 'http://localhost:8091')),

  // Dagster (Orchestration): POST {DAGSTER_URL}/graphql (no auth locally).
  dagsterUrl: base(env('DAGSTER_URL', 'http://agentic-os-dagster-webserver:80')),

  // Cube (Metrics / semantic layer): POST {CUBE_URL}/cubejs-api/v1/load
  // with a Cube query. No auth in dev (CUBEJS_DEV_MODE); add a JWT on STACKIT.
  cubeUrl: base(env('CUBE_URL', 'http://cube:4000')),

  // Cube model-sync (GET /api/cube/models): embed the compiled Cube access policy
  // (member_level excludes) into the delivered model YAML. Default on; set
  // CUBE_EMBED_ACCESS_POLICY=false to serve plain models if a Cube version rejects
  // `access_policy` blocks (data-tab-plan risk #2 fallback — the full policy still
  // rides in the JSON payload for audit + the Trino-OPA enforcement path).
  cubeEmbedAccessPolicy: env('CUBE_EMBED_ACCESS_POLICY', 'true') !== 'false',

  // OpenMetadata (catalog & lineage): server-side REST API base. OFF by default
  // locally (~2.5 GB JVM) — the Data/Unstructured surfaces probe it and degrade
  // to the query-tool catalog / OpenSearch index when it's unreachable.
  openmetadataApiUrl: base(env('OPENMETADATA_API_URL', 'http://openmetadata:8585')),
  // OpenMetadata bot JWT (server-only). OM requires a Bearer token — an
  // unauthenticated call 401s. When this is set the catalog sends it; when it is
  // EMPTY (the default until a bot token is minted into the os-ui Secret) the
  // catalog SKIPS OpenMetadata entirely and reports it honestly, rather than
  // firing a doomed 401 and silently degrading. See app/api/catalog/route.ts.
  openmetadataJwt: env('OPENMETADATA_JWT', ''),
  // The OpenMetadata SERVICE name the Trino/Iceberg lakehouse is ingested under
  // (OM entity FQNs are `<service>.<catalog>.<schema>.<table>`). Used ONLY to build
  // browser deep links from a governed mart (`iceberg.<schema>.<table>`) to its OM
  // entity page — see lib/data/openmetadata.ts omEntityUrl. Must match the OM
  // ingestion pipeline's service name; defaults to `trino`.
  openmetadataService: env('OPENMETADATA_SERVICE', 'trino'),

  // ---- Layer-4 (Science / ML) ENABLEMENT. Off by default; an Admin enables
  // Science per domain (`ml.enabled=true`) + sets GPU quotas. When OFF, the
  // Science tab + its APIs short-circuit to a disabled surface (the capability
  // is not in the cohort-1 path). When ON, the flow is demonstrable even with no
  // live backend (deterministic seed). Distinct from backend REACHABILITY below.
  mlEnabled: env('ML_ENABLED', 'false').toLowerCase() === 'true',

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
  // Internal (in-cluster) Superset Service — the target of the same-origin
  // /tools/superset reverse proxy (lib/tool-proxy.ts). Server-only; the browser
  // never sees it. Distinct from supersetUrl (the optional native console link).
  supersetInternalUrl: base(env('SUPERSET_INTERNAL_URL', 'http://agentic-os-superset:8088')),
  langfuseConsoleUrl: base(consoleEnv('LANGFUSE_CONSOLE_URL', 'http://localhost:3000')),
  forgejoConsoleUrl: base(consoleEnv('FORGEJO_CONSOLE_URL', 'http://localhost:3001')),
  argocdUrl: base(consoleEnv('ARGOCD_URL', 'http://localhost:8080')),
  openmetadataUrl: base(consoleEnv('OPENMETADATA_URL', 'http://localhost:8585')),
  dagsterConsoleUrl: base(consoleEnv('DAGSTER_CONSOLE_URL', 'http://localhost:3070')),
  opensearchDashboardsUrl: base(
    consoleEnv('OPENSEARCH_DASHBOARDS_URL', 'http://localhost:5601'),
  ),
  // Internal (in-cluster) OpenSearch Dashboards Service — target of the
  // same-origin /tools/opensearch reverse proxy. Server-only.
  opensearchDashboardsInternalUrl: base(
    env('OPENSEARCH_DASHBOARDS_INTERNAL_URL', 'http://opensearch-dashboards:5601'),
  ),
  cubeConsoleUrl: base(consoleEnv('CUBE_CONSOLE_URL', 'http://localhost:4001')),

  // Layer-4 consoles (browser-reachable; default to local port-forwards).
  jupyterhubConsoleUrl: base(consoleEnv('JUPYTERHUB_CONSOLE_URL', 'http://localhost:8000')),
  mlflowConsoleUrl: base(consoleEnv('MLFLOW_CONSOLE_URL', 'http://localhost:5000')),
  featureformConsoleUrl: base(consoleEnv('FEATUREFORM_CONSOLE_URL', 'http://localhost:7878')),
  kserveConsoleUrl: base(consoleEnv('KSERVE_CONSOLE_URL', 'http://localhost:8080')),
} as const;

export type AppConfig = typeof config;
