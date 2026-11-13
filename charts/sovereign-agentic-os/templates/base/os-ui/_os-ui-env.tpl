{{- /*
  os-ui ENVIRONMENT — defined once, SPLIT IN TWO (engine rebuild A4 review M-4):

    soa.osUI.runEnv    everything an agent RUN needs: the model gateway's scoped agent key,
                       the stores, the service bearers, the object storage, Langfuse. The
                       `os-ui-worker` Deployment gets exactly this and nothing more.
    soa.osUI.adminEnv  the ADMIN/HTTP-only credentials — session + MCP token signing keys,
                       the Graph mail secret, the LiteLLM UI login and the LiteLLM MASTER
                       key. None of them is reachable from the run path, and the worker
                       serves no HTTP, so the worker pod must not hold them: a compromised
                       run would otherwise find full gateway admin and a session-forging key
                       in its own environment.
    soa.osUI.env       both, in that order — what the os-ui Deployment includes, so os-ui.yaml
                       is unchanged and the two lists can never drift.

  Included with `nindent 12`; `AGENTS_WORKER` is in neither, because its value differs per
  workload (os-ui only switches to `worker` when `osUI.worker.enabled`).
*/}}
{{- define "soa.osUI.env" -}}
{{- include "soa.osUI.runEnv" . }}
{{ include "soa.osUI.adminEnv" . }}
{{- end }}

{{- /* The RUN path's environment — the only list the worker pod gets. */}}
{{- define "soa.osUI.runEnv" -}}
{{- $u := .Values.osUI -}}
- name: PORT
  value: "3000"
- name: HOSTNAME
  value: "0.0.0.0"
{{- /* Model pricing for Monitoring cost facts (EUR per 1M tokens per
     LiteLLM model_name). Nil-safe: absent under --reuse-values ⇒ env
     unset ⇒ cost shows an honest "—". */}}
{{- if .Values.osUI.modelPricesJson }}
- name: MODEL_PRICES_JSON
  value: {{ .Values.osUI.modelPricesJson | quote }}
{{- end }}
# Namespace the stack workloads live in — the native Components
# surface reads their status + scales them 0<->1 here via the k8s API.
- name: NAMESPACE
  value: {{ .Release.Namespace | quote }}
{{- /* Offline (in-memory) user seeding is a no-cluster DEV convenience.
     Production fails closed (503) instead of reverting passwords. */}}
- name: OS_ALLOW_OFFLINE_USER_SEED
  value: {{ ternary "true" "false" (eq (toString $u.allowOfflineUserSeed) "true") | quote }}
{{- /* Tab gating. Empty = base-tier default. */}}
{{- if .Values.osUI.enabledTabs }}
- name: OS_ENABLED_TABS
  value: {{ .Values.osUI.enabledTabs | quote }}
{{- end }}
{{- with .Values.osUI.usersSeed }}
# Optional operator pre-seed of REAL users (JSON array). Not shipped;
# plaintext passwords here are hashed on ingest. Empty = first-run
# bootstrap admin only (admin/admin, forced-change on first login).
- name: OS_USERS
  value: {{ . | quote }}
{{- end }}
# ---- Outbound email (OPTIONAL — os-ui/lib/mailer.ts pluggable mailer,
# transports selected Graph > SMTP > none). With NEITHER block enabled
# the platform works fully without email (the first-run admin
# auto-verifies, later accounts are active at once). Secrets come from
# k8s Secrets — never plaintext here.
{{- if .Values.osUI.graph.enabled }}
# Transport 1 — Microsoft Graph sendMail (recommended for M365).
# GRAPH_CLIENT_SECRET comes from the os-ui-graph Secret.
- name: GRAPH_TENANT_ID
  value: {{ .Values.osUI.graph.tenantId | quote }}
- name: GRAPH_CLIENT_ID
  value: {{ .Values.osUI.graph.clientId | quote }}
- name: MAIL_FROM
  value: {{ .Values.osUI.graph.mailFrom | default "support@datamasterclass.com" | quote }}
{{- end }}
{{- if .Values.osUI.smtp.enabled }}
# Transport 2 — generic SMTP relay (fallback). SMTP_PASS comes from the
# os-ui-smtp Secret.
- name: SMTP_HOST
  value: {{ .Values.osUI.smtp.host | quote }}
- name: SMTP_PORT
  value: {{ .Values.osUI.smtp.port | quote }}
- name: SMTP_SECURE
  value: {{ .Values.osUI.smtp.secure | quote }}
{{- with .Values.osUI.smtp.user }}
- name: SMTP_USER
  value: {{ . | quote }}
{{- end }}
- name: SMTP_PASS
  valueFrom:
    secretKeyRef:
      name: os-ui-smtp
      key: SMTP_PASS
      optional: true
- name: SMTP_FROM
  value: {{ .Values.osUI.smtp.from | default "support@datamasterclass.com" | quote }}
{{- end }}
{{- with (toString .Values.osUI.emailVerification) }}
# Coerced via toString so a YAML/`--set` boolean false is honoured too.
- name: OS_EMAIL_VERIFICATION
  value: {{ . | quote }}
{{- end }}
{{- $publicUrl := .Values.osUI.publicUrl | default (include "soa.consoleUrl" (dict "ctx" . "key" "osUI" "fallback" "")) }}
{{- with $publicUrl }}
# Absolute base for emailed verification links AND the remote MCP
# endpoint URL (/api/mcp). Defaults to the os-ui ingress host; set
# osUI.publicUrl to override.
- name: OS_PUBLIC_URL
  value: {{ . | quote }}
{{- end }}
# In-cluster backend Service URLs (overridable per environment).
# Live agent-runtime backend (Agents tab) + the shared token the UI
# uses to call it and to validate the runtime's governed-tool calls.
- name: AGENT_RUNTIME_URL
  value: "http://agent-runtime:8000"
- name: AGENT_RUNTIME_TOKEN
  valueFrom:
    secretKeyRef:
      name: agent-runtime-token
      key: token
- name: QUERY_TOOL_URL
  value: {{ $u.queryToolUrl | quote }}
# Shared service bearer the os-ui presents to query-tool + data-runner
# (defense-in-depth behind the NetworkPolicies). Rendered ONLY when
# serviceBearer.enabled — nil-safe: absent => no header, services skip check.
{{- /* nindent 0: this template is itself included with `nindent 12`, which supplies the
     container-env indentation for every line below. */}}
{{- include "soa.serviceBearerEnv" . | nindent 0 }}
{{- if .Values.softwareRunner.enabled }}
# ---- Software live-app runner (Software tab). The os-ui provisions a
# real Deployment+Service+Ingress per built app into softwareRunner.namespace
# (RBAC in templates/os-ui/apps-runner.yaml). Per-app host is
# <slug>.<domain>.<appsDomain>; runnerImage is the teaching default when a
# built app has no image of its own. ----
- name: SOFTWARE_RUNNER_NAMESPACE
  value: {{ .Values.softwareRunner.namespace | quote }}
- name: OS_APPS_DOMAIN
  value: {{ .Values.softwareRunner.appsDomain | quote }}
- name: SOFTWARE_RUNNER_IMAGE
  value: {{ .Values.softwareRunner.runnerImage | quote }}
- name: OS_APPS_INGRESS_CLASS
  value: {{ .Values.softwareRunner.ingressClass | default .Values.ingress.className | quote }}
- name: OS_APPS_TLS_ISSUER
  value: {{ .Values.softwareRunner.tlsIssuer | default .Values.ingress.tlsIssuer | quote }}
{{- end }}
# ---- Data-tab ingest (T3). os-ui streams an uploaded file to MinIO
# (uploads/<uid>/) with a SigV4 PUT, then calls the data-runner /ingest —
# which writes the physical Iceberg Bronze table. Reuses the SAME
# object-storage endpoint + `objectStorage.secretName` Secret the lakehouse
# uses (no new broad creds), and the SAME warehouse bucket for uploads/. ----
- name: DATA_RUNNER_URL
  value: {{ $u.dataRunnerUrl | default "http://data-runner:8000" | quote }}
- name: S3_ENDPOINT
  value: {{ include "soa.s3Endpoint" . | quote }}
- name: S3_REGION
  value: {{ .Values.objectStorage.region | default "us-east-1" | quote }}
- name: S3_PATH_STYLE
  value: "true"
- name: UPLOADS_BUCKET
  value: {{ $u.uploadsBucket | default "lakehouse" | quote }}
- name: AWS_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ .Values.objectStorage.secretName }}
      key: AWS_ACCESS_KEY_ID
- name: AWS_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.objectStorage.secretName }}
      key: AWS_SECRET_ACCESS_KEY
- name: LANGFUSE_URL
  value: {{ $u.langfuseUrl | quote }}
- name: OPENSEARCH_URL
  value: {{ $u.opensearchUrl | quote }}
- name: KNOWLEDGE_INDEX
  value: {{ $u.knowledgeIndex | quote }}
# Knowledge k-NN dimension — sourced from the SINGLE retrieval.knnDimension
# (same source as FILES_EMBED_DIM) so real embed vectors aren't rejected and
# silently downgraded to the offline hash when the dim changes (384↔4096).
- name: KNOWLEDGE_EMBED_DIM
  value: {{ .Values.retrieval.knnDimension | quote }}
# ---- Files tab (unstructured context products). The `files` hybrid
# index + the SHARED embedding model. FILES_EMBED_DIM is sourced from
# the SINGLE retrieval.knnDimension so the knn_vector mapping and the
# query vectors always match — NEVER hardcoded here.
- name: FILES_INDEX
  value: {{ $u.filesIndex | default "files" | quote }}
- name: FILES_EMBED_MODEL
  value: {{ $u.filesEmbedModel | default "sovereign-embed" | quote }}
- name: FILES_EMBED_DIM
  value: {{ .Values.retrieval.knnDimension | quote }}
{{- with $u.doclingUrl }}
- name: DOCLING_URL
  value: {{ . | quote }}
{{- end }}
{{- with $u.transcribeUrl }}
- name: TRANSCRIBE_URL
  value: {{ . | quote }}
{{- end }}
{{- with $u.ocrUrl }}
- name: OCR_URL
  value: {{ . | quote }}
{{- end }}
# The SCOPED virtual key the run path uses instead of the master key.
# Provisioned + registered in LiteLLM by the litellm-agent-key-init Job
# (model allowlist + USD cap). `optional` so a cluster without the
# agent key still starts; the run path then refuses to run rather
# than silently falling back to the master key.
- name: LITELLM_AGENT_KEY
  valueFrom:
    secretKeyRef:
      name: agent-litellm-key
      key: apiKey
      optional: true
# LangGraph checkpoint store for agent runs (engine rebuild A1): the `agent_runs`
# database declared in postgres.extraDatabases, wired exactly like LiteLLM's DB —
# username/password from the role's credential Secret, host = the CNPG rw Service,
# composed with k8s dependent-env expansion. os-ui runs PostgresSaver.setup() at boot
# (idempotent). Unset → in-memory checkpoints, and every run report says so.
{{- if .Values.postgres.enabled }}
- name: AGENT_RUNS_DB_USERNAME
  valueFrom:
    secretKeyRef: { name: postgres-agent-runs-credentials, key: username }
- name: AGENT_RUNS_DB_PASSWORD
  valueFrom:
    secretKeyRef: { name: postgres-agent-runs-credentials, key: password }
- name: AGENT_RUNS_DATABASE_URL
  value: postgresql://$(AGENT_RUNS_DB_USERNAME):$(AGENT_RUNS_DB_PASSWORD)@pg-rw/agent_runs
{{- end }}
- name: LITELLM_URL
  value: {{ $u.litellmUrl | quote }}
- name: OPA_URL
  value: {{ $u.opaUrl | quote }}
- name: DAGSTER_URL
  value: {{ $u.dagsterUrl | quote }}
# External-warehouse connectors (Glue/Snowflake/BigQuery/Databricks/Fabric).
# OFF by default — surfaces the warehouse create-flow + MCP tools only when the
# operator opts in (lib/core/config.ts reads EXTERNAL_CONNECTORS_ENABLED).
- name: EXTERNAL_CONNECTORS_ENABLED
  value: {{ $u.externalConnectorsEnabled | default false | quote }}
# Browser-reachable consoles (linked/opened from the browser). When
# ingress is enabled these resolve to the PUBLIC ingress host
# (https://<tool>.<domain>) via soa.consoleUrl — never localhost — so
# deployed links work; tools with no public host (e.g. dagster) get an
# empty value and the UI hides their "Open" link. Local-kind keeps the
# port-forward defaults from values.yaml.
- name: LANGFUSE_CONSOLE_URL
  value: {{ include "soa.consoleUrl" (dict "ctx" . "key" "langfuse" "fallback" $u.langfuseConsoleUrl) | quote }}
- name: DAGSTER_CONSOLE_URL
  value: {{ include "soa.consoleUrl" (dict "ctx" . "key" "dagster" "fallback" $u.dagsterConsoleUrl) | quote }}
# Langfuse project keys — public key is non-secret; secret key via Secret.
- name: LANGFUSE_PUBLIC_KEY
  value: {{ .Values.langfuseInit.publicKey | quote }}
- name: LANGFUSE_SECRET_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $u.langfuseSecret.name | quote }}
      key: {{ $u.langfuseSecret.key | quote }}
{{- end }}

{{- /*
  ADMIN / HTTP-only credentials. Deliberately absent from `soa.osUI.runEnv`, so the
  `os-ui-worker` pod — which executes agent runs and serves no HTTP — never holds them.
  Checked by `scripts/check-worker-env.mjs` (run from os-ui/scripts/gate.sh when helm is
  available) and by the manual `helm template` in docs/components/os-ui.md.
*/}}
{{- define "soa.osUI.adminEnv" -}}
{{- $u := .Values.osUI -}}
{{- $dpg := $u.dataProjectGit | default dict -}}
{{- if $dpg.enabled }}
# Data products in git (engine rebuild B1): every dataset change regenerates the
# domain's dbt project and commits it to /repos/<domain>.git (the os-repos PVC).
# ADMIN-side on purpose (merge of A4-review-M-4 with B1): the only readers are
# `instrumentation.ts`'s commit-hook install, `tabs/data/**` and `app/api/data/**`
# — nothing under `tabs/agents/**`, `core/runtime/**` or `worker/` touches the git
# store — and the worker pod mounts no `os-repos` PVC, so `/repos` would not exist
# there. Keeping it out of `runEnv` means a run can neither read nor write a repo.
- name: DATA_PROJECT_GIT
  value: "true"
- name: OS_REPOS_DIR
  value: /repos
{{- if and .Values.trino.enabled .Values.trino.accessControl .Values.trino.accessControl.enabled }}
# Trino FILE-BASED ACCESS CONTROL (engine rebuild B3). With this on, os-ui reconciles the
# `trino-access-rules` ConfigMap from real domain membership at boot — who the dbt service
# user may act as, and which principals own which Iceberg schema. Off ⇒ only the chart's
# bootstrap file applies (impersonation bounded by the id shape, ownership unchanged).
- name: TRINO_ACCESS_RULES
  value: "true"
- name: TRINO_DBT_USER
  value: {{ .Values.trino.accessControl.serviceUser | default "dbt-runner" | quote }}
{{- end }}
{{- end }}
# Session-signing secret (HMAC-SHA256 for the auth cookie). Sourced
# from the generated `os-ui-session` Secret — NEVER the in-code
# dev fallback, which would let anyone forge an admin session.
- name: OS_SESSION_SECRET
  valueFrom:
    secretKeyRef:
      name: os-ui-session
      key: OS_SESSION_SECRET
# Signs the per-user bearer token for the remote MCP endpoint
# (/api/mcp). Sourced from the same os-ui-session Secret so it works
# out of the box; repoint to its own Secret/key later to rotate MCP
# tokens independently of session cookies.
- name: OS_MCP_TOKEN_SECRET
  valueFrom:
    secretKeyRef:
      name: os-ui-session
      key: OS_SESSION_SECRET
{{- if .Values.osUI.graph.enabled }}
# GRAPH_CLIENT_SECRET — outbound mail is an HTTP-path concern (verification links,
# invitations); a run never sends mail.
- name: GRAPH_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: os-ui-graph
      key: GRAPH_CLIENT_SECRET
      optional: true
{{- end }}
# UI-only credential for the EMBEDDED LiteLLM admin console. os-ui mints a
# browser session from this server-side (core/infra/tool-sso-litellm.ts) so an
# admin opening Admin -> LLM Gateway is already signed in. Same Secret LiteLLM
# itself reads, so there is one credential, not two. Deliberately NOT the proxy
# master key: a leaked UI session must not equal full API access. Absent =>
# the OS reports "not configured" instead of framing LiteLLM's own login.
- name: LITELLM_UI_USERNAME
  valueFrom:
    secretKeyRef:
      name: litellm-credentials
      key: UI_USERNAME
      optional: true
- name: LITELLM_UI_PASSWORD
  valueFrom:
    secretKeyRef:
      name: litellm-credentials
      key: UI_PASSWORD
      optional: true
# LiteLLM master key — from a Secret so it never sits in plaintext.
# Override the name/key per environment.
- name: LITELLM_MASTER_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $u.litellmSecret.name | quote }}
      key: {{ $u.litellmSecret.key | quote }}
{{- end }}
