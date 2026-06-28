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

{{/* Postgres host: in-cluster CloudNativePG `pg-rw`, or the managed host. */}}
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

{{/* Shared env for the query tool + its bootstrap (catalog DB + object storage). */}}
{{- define "soa.queryToolEnv" -}}
- name: PGHOST
  value: {{ include "soa.pgHost" . }}
- name: PGDATABASE
  value: polaris
- name: PGUSER
  valueFrom: { secretKeyRef: { name: postgres-polaris-credentials, key: username } }
- name: PGPASSWORD
  valueFrom: { secretKeyRef: { name: postgres-polaris-credentials, key: password } }
- name: S3_ENDPOINT
  value: {{ include "soa.s3Endpoint" . | quote }}
- name: BASE_LOCATION
  value: {{ .Values.queryTool.baseLocation | quote }}
- name: NAMESPACE
  value: {{ .Values.queryTool.namespace | quote }}
- name: AWS_ACCESS_KEY_ID
  valueFrom: { secretKeyRef: { name: {{ .Values.objectStorage.secretName }}, key: AWS_ACCESS_KEY_ID } }
- name: AWS_SECRET_ACCESS_KEY
  valueFrom: { secretKeyRef: { name: {{ .Values.objectStorage.secretName }}, key: AWS_SECRET_ACCESS_KEY } }
{{- end -}}

{{/* StorageClass helper: "" => cluster default. */}}
{{- define "soa.storageClass" -}}
{{- if .Values.global.storageClass }}storageClassName: {{ .Values.global.storageClass | quote }}{{- end -}}
{{- end -}}
