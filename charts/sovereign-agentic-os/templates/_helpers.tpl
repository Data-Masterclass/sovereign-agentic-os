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

{{/* Shared env for the query tool + its bootstrap (catalog DB + object storage). */}}
{{- define "soa.queryToolEnv" -}}
- name: PGHOST
  value: pg-rw
- name: PGDATABASE
  value: polaris
- name: PGUSER
  valueFrom: { secretKeyRef: { name: postgres-polaris-credentials, key: username } }
- name: PGPASSWORD
  valueFrom: { secretKeyRef: { name: postgres-polaris-credentials, key: password } }
- name: S3_ENDPOINT
  value: "http://minio:9000"
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
