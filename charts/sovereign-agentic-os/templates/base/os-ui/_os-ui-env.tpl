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
{{- /* Production secret guard (core/kernel/secret-guard.ts): a production build refuses to boot
       when a guarded secret is missing or equals its public development default. A LAPTOP
       install (profile `local` AND no Ingress) renders those defaults from values.yaml on
       purpose, so it — and only it — is told so. Any install with an Ingress, and every
       non-local profile, gets no such variable and is guarded. */}}
{{- if and (eq .Values.global.profile "local") (not (.Values.ingress | default dict).enabled) }}
- name: OS_ALLOW_PUBLIC_DEV_SECRETS
  value: "laptop"
{{- end }}
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
{{- /* MAY THIS DEPLOYMENT FABRICATE? (core/kernel/offline-mock.ts). `refuse` ⇒ an unreachable
     engine is a typed ENGINE_UNAVAILABLE refusal, never a hash-seeded `offline-mock` number,
     table, row count or passing security scan. `allow` ⇒ the local teaching flow.
     SET EXPLICITLY, deliberately: the gate this replaces keyed on OS_PROFILE, which no chart,
     values file, deploy script or manifest ever set — so it read `local` on the live cluster and
     the honesty gate was inert exactly where it mattered. RUN-path, so the `os-ui-worker` pod
     that EXECUTES agent runs carries the same answer as the UI; the two cannot drift.
     ONE lever, with no per-subsystem exemption: see the `osUI.offlineMock` comment in
     values.yaml for what `refuse` blocks (notably: a software deploy cannot be approved until a
     real security scanner is wired) and why `allow` is not the fix for that.
     Nil-safe under `--reuse-values` (an absent key renders the `refuse` default). */}}
- name: OS_OFFLINE_MOCK
  value: {{ $u.offlineMock | default "refuse" | quote }}
{{- /* WHICH MODELS MAY BE SENT IMAGES (MODEL_IMAGE_ALLOWLIST — os-ui/core/models/capabilities.ts).
     A JSON array of LiteLLM model_names that REPLACES the built-in list. Rendered ONLY when
     `osUI.imageAllowlist` is a list, so an absent key (the default, and `--reuse-values`) leaves
     the env unset and the built-in list in force. An EMPTY list renders "[]" = no model at all.
     RUN-path: the `os-ui-worker` pod makes the model calls, so it must carry the same list as
     the UI that displays it. */}}
{{- if kindIs "slice" $u.imageAllowlist }}
- name: MODEL_IMAGE_ALLOWLIST
  value: {{ $u.imageAllowlist | toJson | quote }}
{{- end }}
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
# The shared SERVICE BEARER. A5 deleted the Python agent-runtime this was named
# after (agent graphs run in this process now), but the token stayed: os-ui
# VALIDATES it on its unauthenticated service paths — the agent scheduled-run
# endpoint, the metrics data-sync sweep and the connections catalog-refresh sweep
# all present it from their CronJobs. Renamed when the data side owns the Secret.
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
# ---- Software live-app runner (Software tab). The os-ui applies each app's
# COMMITTED apps/<slug>/k8s/ manifests into softwareRunner.namespace (RBAC in
# templates/os-ui/apps-runner.yaml; WP-54). Per-app host is
# <slug>.<domain>.<appsDomain>; images must come from imageRegistry by digest. ----
- name: SOFTWARE_RUNNER_NAMESPACE
  value: {{ .Values.softwareRunner.namespace | quote }}
- name: OS_APPS_DOMAIN
  value: {{ .Values.softwareRunner.appsDomain | quote }}
- name: SOFTWARE_IMAGE_REGISTRY
  value: {{ .Values.softwareRunner.imageRegistry | default "" | quote }}
{{- if .Values.priorityClasses.enabled }}
# WP-47: user apps run in the lowest PriorityClass (never above a platform pod, never preempting).
- name: SOFTWARE_RUNNER_PRIORITY_CLASS
  value: {{ .Values.priorityClasses.userApps.name | quote }}
{{- end }}
- name: OS_APPS_INGRESS_CLASS
  value: {{ .Values.softwareRunner.ingressClass | default .Values.ingress.className | quote }}
- name: OS_APPS_TLS_ISSUER
  value: {{ .Values.softwareRunner.tlsIssuer | default .Values.ingress.tlsIssuer | quote }}
{{- end }}
{{- /* ---- Software SECURITY SCANNER (tabs/software/lib/scan-trivy.ts). os-ui launches ONE
     Trivy Job per deploy request in THIS namespace (RBAC + NetworkPolicy in
     templates/base/os-ui/software-scanner.yaml) and maps its JSON onto the review card's
     scan. `mode: 'live'` only when the Job completed; a failure, a timeout or an
     unreachable API server leaves the scan `unavailable` with a reason and the deploy
     unapprovable (PR #56). This is what `osUI.offlineMock: refuse` tells an operator to
     wire — it is NOT an offline-mock lever and it weakens nothing.
     RUN-path, so `os-ui-worker` (which executes agent runs, and therefore the Platform MCP's
     `request_deploy`) resolves the scanner exactly as the UI pod does; the two cannot drift.
     Nil-safe under `--reuse-values`: an absent `software.scanner` renders the code defaults. */}}
{{- $sc := (($u.software | default dict).scanner | default dict) }}
- name: SOFTWARE_SCANNER_ENABLED
  value: {{ ternary "true" "false" ($sc.enabled | default false) | quote }}
{{- if $sc.enabled | default false }}
- name: SOFTWARE_SCANNER_IMAGE
  value: {{ printf "%s:%s" (($sc.image | default dict).repository | default "aquasec/trivy") (($sc.image | default dict).tag | default "0.58.2") }}{{ if ($sc.image | default dict).digest }}{{ printf "@%s" ($sc.image).digest }}{{ end }}
- name: SOFTWARE_SCANNER_NAMESPACE
  value: {{ $sc.namespace | default .Release.Namespace | quote }}
- name: SOFTWARE_SCANNER_DB_MODE
  value: {{ $sc.dbMode | default "mirror" | quote }}
- name: SOFTWARE_SCANNER_DB_REPOSITORY
  value: {{ $sc.dbRepository | default "ghcr.io/aquasecurity/trivy-db" | quote }}
- name: SOFTWARE_SCANNER_TIMEOUT_MS
  value: {{ mul ($sc.timeoutSeconds | default 180) 1000 | quote }}
{{- end }}
# ---- Data-tab ingest (T3). os-ui streams an uploaded file to MinIO
# (uploads/<uid>/) with a SigV4 PUT, then calls the data-runner /ingest —
# which writes the physical Iceberg Bronze table. Reuses the SAME
# object-storage endpoint + `objectStorage.secretName` Secret the lakehouse
# uses (no new broad creds), and the SAME warehouse bucket for uploads/. ----
- name: OS_ICEBERG_SNAPSHOT_RETENTION
  value: {{ (((.Values.trino).catalog).iceberg).snapshotRetention | default "7d" | quote }}
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
{{- /* OpenSearch URL (+ credentials once WP-22 sets opensearchClient.credentialsSecret):
       one helper for every client in the chart. */}}
{{ include "soa.opensearchClientEnv" . }}
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
{{- if .Values.docling.enabled }}
# docling-serve's API key, sent as X-Api-Key (the same Secret the docling pod reads).
- name: DOCLING_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "soa.doclingApiKeySecret" . }}
      key: apiKey
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
# The secret an agent system's stored model key is encrypted under (os-ui Build writes the
# encrypted key to the `agent_runs` database; os-ui AND the worker decrypt it for that
# system's model calls). RUN-path, so the worker gets it. A dedicated secret — NOT the
# LiteLLM master key, which stays in adminEnv and never reaches the worker. Not `optional`:
# a pod that could not decrypt would fail every run with "encryption secret missing".
- name: AGENT_KEY_ENCRYPTION_KEY
  valueFrom:
    secretKeyRef:
      name: {{ ($u.agentKeyEncryption | default dict).existingSecret | default "os-ui-agent-key-encryption" | quote }}
      key: AGENT_KEY_ENCRYPTION_KEY
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
{{- /* RETENTION for the `agent_runs` database (A13 follow-up). A settled run's checkpoint,
     `run_events` and `run_jobs` row are removed this many days after it settled; `parked` runs
     are never swept at any age. RUN-path, because the worker loop is what carries the periodic
     sweep (os-ui runs one at boot in inline mode). Unset ⇒ the code default (30 days);
     `"0"` ⇒ keep everything. */}}
{{- if $u.agentRunsRetentionDays }}
- name: AGENT_RUNS_RETENTION_DAYS
  value: {{ $u.agentRunsRetentionDays | quote }}
{{- end }}
{{- /* WP-53: agent systems on their native LangGraph module (graph.mjs). RUN-path: os-ui and the
     worker decide a run's engine with the same two values. Off by default. `domains` is a YAML
     list or a comma-separated string; an EMPTY list means NO domain, so `enabled: true` with no
     domains refuses to render — every domain must be asked for explicitly with "*". */}}
{{- $m := $u.agentGraphModule | default dict }}
{{- $d := $m.domains }}
{{- $ds := "" }}
{{- if kindIs "slice" $d }}{{ $ds = join "," $d }}{{ else if $d }}{{ $ds = toString $d }}{{ end }}
{{- $ds = regexReplaceAll "\\s*,\\s*" (trim $ds) "," | trimAll "," }}
{{- if and $m.enabled (not $ds) }}
{{- fail "osUI.agentGraphModule.enabled=true needs osUI.agentGraphModule.domains: list the domains (e.g. [test]), or \"*\" for every domain" }}
{{- end }}
- name: AGENT_GRAPH_MODULE
  value: {{ ternary "true" "false" (default false $m.enabled) | quote }}
{{- if $ds }}
- name: AGENT_GRAPH_MODULE_DOMAINS
  value: {{ $ds | quote }}
{{- end }}
{{- /* WP-52 — native dashboards (dbt saved queries + Vega-Lite). Unset when off: the code reads
     unset as off, so the default render is unchanged. */}}
{{- if $u.dashboardsNative }}
- name: DASHBOARDS_NATIVE
  value: "true"
{{- end }}
{{- /* X9 (engine rebuild Part D) — the agent engine's guardrails on EVERY tool call. Both are
     RUN-path, so the worker gets them too. Unset ⇒ the code defaults (20 000 chars / 60 s). */}}
{{- with $u.agentToolResultMaxChars }}
- name: AGENT_TOOL_RESULT_MAX_CHARS
  value: {{ . | quote }}
{{- end }}
{{- with $u.agentToolCallTimeoutMs }}
- name: AGENT_TOOL_CALL_TIMEOUT_MS
  value: {{ . | quote }}
{{- end }}
- name: LITELLM_URL
  value: {{ $u.litellmUrl | quote }}
{{- /* Provider flow (Models & Providers): the hosts the egress proxy lets out (the SAME list as its
       filter, soa.egressHosts) so a provider host is refused before anything is stored, and the
       access group the shared agent key holds, which every admin-registered model joins. */}}
- name: LLM_EGRESS_ALLOWLIST
  value: {{ include "soa.egressHosts" . | fromJsonArray | join "," | quote }}
- name: LLM_NO_PROXY
  value: {{ include "soa.litellmNoProxy" . | quote }}
- name: LLM_LOCAL_MODELS
  value: {{ (.Values.llmProviders | default dict).localModels | default list | join "," | quote }}
- name: LLM_ACCESS_GROUP
  value: {{ (.Values.llmProviders | default dict).accessGroup | default "" | quote }}
- name: OPA_URL
  value: {{ $u.opaUrl | quote }}
{{- /* The chart-seeded governance principals (the same block the OPA seed reads). os-ui's runtime governance writes merge into them and never drop a seeded clearance. */}}
- name: OS_OPA_SEED_PRINCIPALS
  value: {{ ((.Values.opa.governance | default dict).principals | default dict) | toJson | quote }}
{{- $odb := (.Values.opa.dataBundle | default dict) }}
{{- if $odb.enabled }}
# WP-11: OPA loads its data as bundles from this process (/api/opa/bundles/*); nothing is pushed.
- name: OS_OPA_DATA_BUNDLE
  value: "1"
# The chart seed, rendered by the SAME helper as OPA's data.json + governance.json.
- name: OS_OPA_SEED
  value: {{ include "soa.opaSeed" . | quote }}
- name: OS_ABAC_ATTRIBUTES
  value: {{ join "," ($odb.abacAttributes | default list) | quote }}
- name: OS_OPA_INSTANCES
  value: "opa"
{{- if (.Values.opa.guardrailsData | default dict).enabled }}
# WP-30: guardrails are committed OPA data in the os-data bundle (no runtime policy upload).
- name: OS_GUARDRAILS_DATA
  value: "1"
{{- end }}
{{- $g := (.Values.postgres.governance | default dict) }}
{{- if and .Values.postgres.enabled $g.enabled }}
# The os-grants bundle reads run grants from os_governance as the runtime (DML-only) login.
- name: OS_GOVERNANCE_DB_USERNAME
  valueFrom:
    secretKeyRef: { name: {{ $g.runtime.secretName }}, key: username }
- name: OS_GOVERNANCE_DB_PASSWORD
  valueFrom:
    secretKeyRef: { name: {{ $g.runtime.secretName }}, key: password }
- name: OS_GOVERNANCE_DATABASE_URL
  value: postgresql://$(OS_GOVERNANCE_DB_USERNAME):$(OS_GOVERNANCE_DB_PASSWORD)@pg-rw/{{ $g.database }}
{{- end }}
{{- end }}
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
{{- $ac := .Values.trino.accessControl | default dict -}}
{{- $odb := (.Values.opa.dataBundle | default dict) -}}
{{- if $odb.enabled }}
# WP-11: the dedicated bearer OPA presents on /api/opa/bundles/* and /api/opa/status. Web process
# only (this list): the run worker and the Dagster pods never hold it.
- name: OS_OPA_BUNDLE_TOKEN
  valueFrom:
    secretKeyRef: { name: opa-bundle-token, key: token }
- name: OS_OPA_MAX_DROP_PERCENT
  value: {{ $odb.maxDropPercent | default 10 | quote }}
{{ end -}}
# The Langfuse console login the embedded /tools/langfuse proxy uses (tool-sso-langfuse.ts):
# the admin user Langfuse was initialised with, read from the same Secret as the project keys.
# os-ui has no built-in default for either in production and refuses to boot without them.
- name: LANGFUSE_SSO_EMAIL
  valueFrom:
    secretKeyRef:
      name: {{ $u.langfuseSecret.name | quote }}
      key: LANGFUSE_INIT_USER_EMAIL
- name: LANGFUSE_SSO_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ $u.langfuseSecret.name | quote }}
      key: LANGFUSE_INIT_USER_PASSWORD
{{- if $dpg.enabled }}
# Data products AND agent systems in git (engine rebuild B1, Part D): every dataset
# change regenerates the domain's dbt project, and every agent-system definition
# change regenerates that domain's `agents/` subtree, each committed to
# /repos/<domain>.git (the os-repos PVC).
#
# ADMIN-side on purpose (merge of A4-review-M-4 with B1, and the DECISION of Part D
# review H-3): the readers are `instrumentation.ts`'s commit-hook install,
# `tabs/data/**`, `tabs/agents/lib/git/**` and the routes above them. The
# `os-ui-worker` pod mounts NO `os-repos` volume and gets neither variable, because
# the PVC is ReadWriteOnce (templates/base/os-ui/os-repos.yaml): os-ui and the worker
# are separate Deployments the scheduler may place on different nodes, and an RWO
# volume attaches to one node at a time — mounting it in both would either fail to
# start the worker or pin it to os-ui's node, and two processes writing one bare repo
# is exactly what the git store's IN-PROCESS lock cannot protect.
#
# (WP-53e: with agent modules on, the worker mounts os-repos READ-ONLY, co-scheduled onto os-ui's
# node — it loads committed graph.mjs files and never writes; see os-ui-worker.yaml.)
#
# So the worker does not write repos, and it does not pretend to: `worker/agent-runs.ts`
# marks the process, and an agent-system DEFINITION write there fails closed with a
# typed `SystemWriteUnavailableError` instead of landing in the mirror uncommitted.
# Run and build bookkeeping (the activity marker, the run checkpoint, the last-run
# report) is unaffected — it is deliberately not a commit.
- name: DATA_PROJECT_GIT
  value: "true"
- name: OS_REPOS_DIR
  value: /repos
{{- if ($dpg.gitHttp | default dict).enabled }}
# The authenticated git-http door is rendered (os-git-http.yaml), so the OS publishes the
# `git clone https://<os>/git/<repo>.git` URL in its engineering views (WP-51).
- name: OS_GIT_HTTP
  value: "true"
{{- end }}
{{- /* Repository layout (component design 12). `layout.migration`: off (default) | dry-run |
  apply. `apply` renames each domain repo to domain-<domain>.git (old name kept as an alias),
  moves it to the v2 layout in ONE commit (`OS-Reason: layout-migration`) at boot, moves personal
  agent lanes to user-<token> repos, and creates NEW repos in v2. `dry-run` only logs the plan.
  `dbtProjectDir` is the ONE dbt project dir setting; it is written into each repo's
  os/layout.yml, which is where the Dagster image reads it. */}}
{{- $lay := (.Values.osUI.dataProjectGit | default dict).layout | default dict }}
{{- $mig := $lay.migration | default "off" | toString }}
{{- if not (has $mig (list "off" "dry-run" "apply")) }}{{ fail (printf "osUI.dataProjectGit.layout.migration must be off, dry-run or apply (got %q)" $mig) }}{{ end }}
{{- /* DEPLOY ORDER, enforced (WP-55 verifier F9): `apply` renders only when the Dagster code
  location AND its repo-sync sidecar run an image that reads os/layout.yml (>= layout.dagsterMinVersion).
  An older image cannot load a migrated repo, and after a pod restart its schedules would vanish. */}}
{{- if eq $mig "apply" }}
{{- $min := $lay.dagsterMinVersion | default "0.3.3" | toString }}
{{- $dep := index ((index (.Values.dagster | default dict) "dagster-user-deployments") | default dict).deployments 0 }}
{{- $codeTag := (($dep.image | default dict).tag | default "0.0.0") | toString }}
{{- $sidecarTag := "0.0.0" }}
{{- range ($dep.sidecarContainers | default list) }}{{- if eq .name "repo-sync" }}{{- $sidecarTag = (regexReplaceAll "@.*$" (regexReplaceAll "^.*:" (regexReplaceAll "@sha256:.*$" .image "") "") "") }}{{- end }}{{- end }}
{{- range $t := (list $codeTag $sidecarTag) }}
{{- if not (semverCompare (printf ">=%s" $min) $t) }}{{ fail (printf "osUI.dataProjectGit.layout.migration=apply needs the Dagster code location and its repo-sync sidecar at >= %s (they read os/layout.yml); found code location %s and repo-sync %s — deploy that Dagster image first" $min $codeTag $sidecarTag) }}{{ end }}
{{- end }}
{{- /* A tag can be moved; a digest cannot. The DIGESTS of the images built with the layout-aware
  loader are recorded in layout.dagsterLayoutDigests when they are built, and BOTH the code
  location and repo-sync must run one of them. */}}
{{- $codeDigest := (($dep.image | default dict).digest | default "") | toString }}
{{- $sidecarDigest := "" }}
{{- range ($dep.sidecarContainers | default list) }}{{- if eq .name "repo-sync" }}{{- $sidecarDigest = (regexFind "sha256:[0-9a-f]{64}" .image) }}{{- end }}{{- end }}
{{- $known := $lay.dagsterLayoutDigests | default list }}
{{- if not (and (has $codeDigest $known) (has $sidecarDigest $known)) }}{{ fail (printf "osUI.dataProjectGit.layout.migration=apply needs the Dagster code location and its repo-sync sidecar pinned to a digest listed in layout.dagsterLayoutDigests (an image built with the layout-aware loader); found code location %q and repo-sync %q" $codeDigest $sidecarDigest) }}{{ end }}
{{- end }}
- name: OS_REPO_LAYOUT_MIGRATION
  value: {{ $mig | quote }}
- name: OS_REPO_LAYOUT_V2
  value: {{ eq $mig "apply" | toString | quote }}
- name: OS_DBT_PROJECT_DIR
  value: {{ $lay.dbtProjectDir | default "data/dbt" | quote }}
{{- end }}
{{- /*
  Trino FILE-BASED ACCESS CONTROL (engine rebuild B3, fixed in B3-review-H-1/L-5). With this on,
  os-ui reconciles the `trino-access-rules` ConfigMap from real domain membership — at boot, on a
  directory change, and every `reconcileIntervalMinutes` — deciding who the dbt service user may
  act as and which principals own which Iceberg schema. Off ⇒ only the chart's bootstrap file
  applies (impersonation bounded by the id shape, ownership unchanged).

  The gate is EXACTLY the gate the ConfigMap renders under (`trino.yaml` `$acOn` =
  `and $ac.enabled $t.opa.enabled`, inside `if .Values.trino.enabled`) — NOT `dataProjectGit`,
  which defaults false while `trino.accessControl.enabled` defaults true: that combination used to
  ship the permissive bootstrap permanently with nothing ever reconciling it. Aligning the two
  gates also means os-ui never logs "ConfigMap does not exist" on a boot where the file is absent
  by design.
*/}}
{{- if and .Values.trino.enabled $ac.enabled .Values.trino.opa.enabled }}
- name: TRINO_ACCESS_RULES
  value: "true"
- name: TRINO_DBT_USER
  value: {{ $ac.serviceUser | default "dbt-runner" | quote }}
{{- /* The post-install seed Jobs and the ONE schema each creates and fills (core/infra/trino-rules.ts
       `seedWriters`): without them a fresh install's boot-time rules deny their CREATE SCHEMA. */}}
{{- $writers := list }}
{{- if and .Values.dbt .Values.dbt.enabled }}{{ $writers = append $writers (printf "%s:%s" .Values.dbt.trino.user .Values.dbt.trino.schema) }}{{ end }}
{{- if and .Values.marts .Values.marts.enabled }}{{ $writers = append $writers (printf "%s:%s" .Values.marts.trino.user .Values.marts.schema) }}{{ end }}
{{- if $writers }}
- name: TRINO_SEED_WRITERS
  value: {{ join "," (uniq $writers) | quote }}
{{- end }}
- name: TRINO_ACCESS_RULES_INTERVAL_MINUTES
  value: {{ $ac.reconcileIntervalMinutes | default 10 | quote }}
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
# (/api/mcp). Its OWN key in os-ui-session, so rotating OS_SESSION_SECRET
# (browser sessions) leaves issued MCP tokens valid, and vice versa. An
# ExternalSecret that owns os-ui-session must supply this key too.
- name: OS_MCP_TOKEN_SECRET
  valueFrom:
    secretKeyRef:
      name: os-ui-session
      key: OS_MCP_TOKEN_SECRET
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
{{- /* PER-SYSTEM KEY CAPS (`osUI.agentSystemKey` → os-ui/core/kernel/config.ts `agentSystemKey`).
     Build mints one LiteLLM key per agent system and reconciles it to these on every Rebuild.
     ADMIN env, not run env: only the Build path (os-ui, which holds the master key below) reads
     them — the worker that executes runs never mints or updates a key. Each is rendered only
     when set, so an absent block (`--reuse-values` from an older release) leaves the code
     defaults in force. `toString` because helm parses 1000000 as a float (1e+06). */}}
{{- with $u.agentSystemKey }}
{{- if .maxBudget }}
- name: AGENT_SYSTEM_KEY_MAX_BUDGET
  value: {{ .maxBudget | toString | quote }}
{{- end }}
{{- if .budgetDuration }}
- name: AGENT_SYSTEM_KEY_BUDGET_DURATION
  value: {{ .budgetDuration | quote }}
{{- end }}
{{- if .rpmLimit }}
- name: AGENT_SYSTEM_KEY_RPM_LIMIT
  value: {{ .rpmLimit | int64 | quote }}
{{- end }}
{{- if .tpmLimit }}
- name: AGENT_SYSTEM_KEY_TPM_LIMIT
  value: {{ .tpmLimit | int64 | quote }}
{{- end }}
{{- if .maxParallelRequests }}
- name: AGENT_SYSTEM_KEY_MAX_PARALLEL_REQUESTS
  value: {{ .maxParallelRequests | int64 | quote }}
{{- end }}
{{- end }}
{{- /* THE GATEWAY'S FALLBACKS, for the per-system key's model allowlist. LiteLLM authorises a key
     against the model it falls back TO, so a system key without the fallback target answers 403
     exactly when the primary model is failing. Build therefore adds every fallback target of a
     model on the key. READ from the gateway's own router settings (all four fallback maps) so
     the two cannot drift; nothing here changes the gateway. ADMIN env: only Build reads it. */}}
{{- $rs := (((.Values.litellm | default dict).proxy_config | default dict).router_settings | default dict) }}
{{- $fb := dict }}
{{- range $key := list "fallbacks" "context_window_fallbacks" "content_policy_fallbacks" }}
{{- range $entry := (index $rs $key | default list) }}
{{- range $from, $targets := $entry }}
{{- $_ := set $fb $from (concat (index $fb $from | default list) ($targets | default list) | uniq) }}
{{- end }}
{{- end }}
{{- end }}
- name: AGENT_SYSTEM_KEY_FALLBACKS_JSON
  value: {{ dict "fallbacks" $fb "default" ($rs.default_fallbacks | default list) | toJson | quote }}
# LiteLLM master key — from a Secret so it never sits in plaintext.
# Override the name/key per environment.
- name: LITELLM_MASTER_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $u.litellmSecret.name | quote }}
      key: {{ $u.litellmSecret.key | quote }}
{{- end }}

# ---------------------------------------------------------------------------
# THE APP-BUILDING HARNESS (stream H). Additive; the default value "spec" keeps
# the Software Build stage byte-identical to today. SOFTWARE_BUILDER=agentic
# routes Build to the bounded planner -> coder -> build -> reviewer loop.
# LITELLM_CODER_MODEL is optional: empty means the `coder` model role resolves
# to the reasoning tier.
- name: SOFTWARE_BUILDER
  value: {{ (.Values.softwareBuilder | default dict).mode | default "spec" | quote }}
- name: LITELLM_CODER_MODEL
  value: {{ (.Values.softwareBuilder | default dict).coderModel | default "" | quote }}
