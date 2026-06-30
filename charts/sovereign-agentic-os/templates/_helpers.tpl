{{/*
Common helpers for the Sovereign Agentic OS umbrella chart.
*/}}

{{/* Chart name+version label value. */}}
{{- define "soa.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Common labels applied to every bespoke resource. */}}
{{- define "soa.labels" -}}
helm.sh/chart: {{ include "soa.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: sovereign-agentic-os
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{/*
Per-component selector labels. Usage:
  {{- include "soa.selectorLabels" (dict "ctx" . "component" "object-storage") }}
*/}}
{{- define "soa.selectorLabels" -}}
app.kubernetes.io/name: {{ .component }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
Secure-by-default pod securityContext for bespoke workloads (security.md:
non-root, drop caps, seccomp). Override per-component only when an image needs it.
*/}}
{{- define "soa.podSecurityContext" -}}
runAsNonRoot: {{ .Values.global.podSecurity.runAsNonRoot }}
seccompProfile:
  type: {{ .Values.global.podSecurity.seccompProfile }}
{{- end -}}

{{- define "soa.containerSecurityContext" -}}
allowPrivilegeEscalation: false
capabilities:
  drop:
    - ALL
{{- end -}}

{{/*
Backend-host indirection (Mode A bundled <-> Mode B external/STACKIT-managed).
These return the in-cluster Service when the backend is bundled and the external
managed endpoint when its bundled deployment is disabled. Mode A is byte-for-byte
unchanged: when `enabled` is true the helper yields the same literal as before.
Per-app credential Secrets are referenced by name (unchanged across modes); only
the host/endpoint is indirected — see values.stackit-managed.yaml.
*/}}

{{/* Postgres host: in-cluster `pg-rw` (plain StatefulSet or CNPG), or the managed host. */}}
{{- define "soa.pgHost" -}}
{{- if .Values.postgres.enabled -}}
pg-rw
{{- else -}}
{{ required "postgres.external.host is required when postgres.enabled=false" .Values.postgres.external.host }}
{{- end -}}
{{- end -}}

{{/* OpenSearch base URL: bundled `http://opensearch:9200`, or the managed endpoint. */}}
{{- define "soa.opensearchUrl" -}}
{{- if .Values.opensearch.enabled -}}
http://opensearch:9200
{{- else -}}
{{- $os := .Values.opensearch.external -}}
{{ $os.protocol | default "https" }}://{{ required "opensearch.external.host is required when opensearch.enabled=false" $os.host }}:{{ $os.port | default "9200" }}
{{- end -}}
{{- end -}}

{{/*
Browser-reachable console URL for a tool, derived so DEPLOYED links never point
at localhost. When ingress is enabled (Mode A self-hosted / Mode B managed), the
public URL is the tool's ingress host as `https://<host>` — the same host the
ingress template routes — so the OS UI links resolve through the real LB/DNS. If
ingress is enabled but the tool has NO public host (e.g. dagster/cube, kept
internal), this returns "" and the UI hides that tool's "Open" link rather than
linking to an unreachable localhost. When ingress is disabled (local-kind), it
falls back to the per-tool port-forward default.
Args: dict "ctx" $ "key" "<ingress host key>" "fallback" "<local url>"
*/}}
{{- define "soa.consoleUrl" -}}
{{- $ing := .ctx.Values.ingress | default dict -}}
{{- if $ing.enabled -}}
{{- $host := index ($ing.hosts | default dict) .key | default "" -}}
{{- if $host -}}https://{{ $host }}{{- end -}}
{{- else -}}
{{- .fallback -}}
{{- end -}}
{{- end -}}

{{/* S3/object-storage endpoint: bundled `http://minio:9000`, or the managed endpoint. */}}
{{- define "soa.s3Endpoint" -}}
{{- if or (not .Values.objectStorage.enabled) (eq (.Values.objectStorage.mode | default "") "external") -}}
{{ required "objectStorage.external.endpoint is required when objectStorage is external" .Values.objectStorage.external.endpoint }}
{{- else -}}
http://minio:9000
{{- end -}}
{{- end -}}

{{/* Shared env for the governed Trino `query` tool (reads marts THROUGH Trino). */}}
{{- define "soa.queryToolEnv" -}}
- name: TRINO_HOST
  value: {{ .Values.queryTool.trino.host | quote }}
- name: TRINO_PORT
  value: {{ .Values.queryTool.trino.port | quote }}
- name: TRINO_USER
  value: {{ .Values.queryTool.trino.user | quote }}
- name: TRINO_CATALOG
  value: {{ .Values.queryTool.trino.catalog | quote }}
- name: TRINO_SCHEMA
  value: {{ .Values.queryTool.trino.schema | quote }}
{{- end -}}

{{/* StorageClass helper: "" => cluster default. */}}
{{- define "soa.storageClass" -}}
{{- if .Values.global.storageClass }}storageClassName: {{ .Values.global.storageClass | quote }}{{- end -}}
{{- end -}}

{{/*
Orchestrated, memory-safe startup (see values.yaml `startup` + `priorityClasses`).
-----------------------------------------------------------------------------
Argo CD sync-wave annotation for a startup tier. Waves stage the rollout so the
node's memory ramps gradually instead of ~30 pods booting at once (which spiked
> 32 GB and OOMKilled litellm / errored openmetadata). Tiers:
  infra      -> wave 0 (Postgres/CNPG, OpenSearch, ClickHouse, Valkey, MinIO)
  middleware -> wave 1 (LiteLLM, Langfuse, mock-model, egress)
  apps       -> wave 2 (Superset, Dagster, OpenMetadata, Forgejo, Argo, OS UI, agents)
Inert without Argo CD (e.g. local `helm install`), where the resource `requests`
provide the memory backpressure instead. Args: dict "ctx" $ "tier" "<tier>".
*/}}
{{- define "soa.syncWaveAnno" -}}
argocd.argoproj.io/sync-wave: {{ index .ctx.Values.startup.syncWaves .tier | quote }}
{{- end -}}

{{/*
priorityClassName line for a tier ("infra" high / "app" low), gated by
`priorityClasses.enabled`. Renders nothing when disabled so local-kind installs
that don't create the PriorityClass objects still admit every pod. Place under a
pod `spec:`. Args: dict "ctx" $ "tier" "<infra|app>".
*/}}
{{- define "soa.priorityClassName" -}}
{{- if .ctx.Values.priorityClasses.enabled -}}
priorityClassName: {{ index .ctx.Values.priorityClasses .tier "name" }}
{{- end -}}
{{- end -}}

{{/*
OVERRIDE of the Forgejo/gitea subchart's `gitea.images.pullSecrets` helper.
Templates share one namespace across parent + subcharts, and a parent-chart
definition wins, so this normalises the subchart's pull-secret rendering.

WHY: the upstream gitea helper assumes `global.imagePullSecrets` entries are
plain STRINGS and wraps each as `(dict "name" .)`. This umbrella sets
`global.imagePullSecrets: [{name: registry-pull-secret}]` (map form — the
convention every other consumer here expects), so the upstream helper double-
wraps it into `{name: {name: registry-pull-secret}}` → an invalid pod spec that
kept the Forgejo pod from starting. This version accepts BOTH a string and a
`{name: ...}` map, so the map form renders correctly as `- name: <secret>`.
(Forgejo's image is public, so the secret is harmless-but-valid; the fix is just
to stop emitting a malformed reference.) Keep in sync with the upstream helper's
output shape on any `forgejo` subchart bump.
*/}}
{{- define "gitea.images.pullSecrets" -}}
{{- $pullSecrets := .Values.imagePullSecrets -}}
{{- range .Values.global.imagePullSecrets -}}
  {{- if kindIs "string" . -}}
    {{- $pullSecrets = append $pullSecrets (dict "name" .) -}}
  {{- else -}}
    {{- $pullSecrets = append $pullSecrets . -}}
  {{- end -}}
{{- end -}}
{{- if (not (empty $pullSecrets)) }}
imagePullSecrets:
{{ toYaml $pullSecrets }}
{{- end }}
{{- end -}}
