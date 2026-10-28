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
ingress is enabled but the tool has NO public host (e.g. dagster, kept
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

{{/*
Shared service-bearer env (defense-in-depth for the os-ui -> query-tool /
os-ui -> data-runner data-plane calls). Emits SERVICE_BEARER_TOKEN from the
`service-bearer-token` Secret ONLY when serviceBearer.enabled is true. Nil-safe:
when the key is absent/false this renders NOTHING, so query-tool, data-runner and
os-ui all run exactly as before (no env => services skip the check, os-ui sends no
header). Mounted identically in all three so the token compared is the token sent.
*/}}
{{- define "soa.serviceBearerEnv" -}}
{{- if (.Values.serviceBearer).enabled }}
- name: SERVICE_BEARER_TOKEN
  valueFrom:
    secretKeyRef:
      name: service-bearer-token
      key: SERVICE_BEARER_TOKEN
{{- end }}
{{- end -}}

{{/* StorageClass helper: "" => cluster default. */}}
{{- define "soa.storageClass" -}}
{{- if .Values.global.storageClass }}storageClassName: {{ .Values.global.storageClass | quote }}{{- end -}}
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
=============================================================================
soa.cloudCatalogProps — KEYLESS managed Iceberg catalog `.properties` per cloud.
=============================================================================
Emits the body of ONE managed lakehouse catalog for the DEFAULT-off opt-in
toggle `trino.cloudCatalog` (set only by the cloud overlays; empty on
STACKIT/local, so nothing renders there). This is the Helm mirror of the keyless
prop-generation in os-ui/lib/connections/warehouse/providers/{bigquery,glue,fabric}.ts
— NO static keys: the Trino pod authenticates via its ServiceAccount identity
(Workload Identity / Pod Identity / Entra WI). Apache Polaris (REST) is the
DEFAULT catalog on all three clouds (rendered by trino.yaml's `iceberg.properties`);
this adds the provider-native catalog only when a customer toggles it on.

`trino.cloudCatalog`:
  provider: biglake | glue | s3tables | adls   (which native catalog)
  region:   cloud region (glue/s3tables)
  <provider-specific>: see per-provider block below
Args: the ROOT context ($). Reads $.Values.trino.cloudCatalog.
*/}}
{{- define "soa.cloudCatalogProps" -}}
{{- $cc := $.Values.trino.cloudCatalog | default dict -}}
{{- $p := $cc.provider | default "" -}}
{{- if eq $p "biglake" -}}
{{- /* GKE — BigLake managed Iceberg REST catalog. Keyless: security=GOOGLE means
       Trino uses Application Default Credentials from Workload Identity (no OAuth2
       client secret). GCS filesystem also uses ADC. */ -}}
connector.name=iceberg
iceberg.catalog.type=rest
iceberg.rest-catalog.uri={{ required "trino.cloudCatalog.restUri required for biglake" $cc.restUri }}
iceberg.rest-catalog.warehouse={{ required "trino.cloudCatalog.warehouse required for biglake" $cc.warehouse }}
iceberg.rest-catalog.security=GOOGLE
fs.native-gcs.enabled=true
{{- else if eq $p "glue" -}}
{{- /* EKS — AWS Glue Data Catalog. Keyless via the pod's IAM role (Pod Identity /
       IRSA); region only, no access/secret key. Mirrors glue.ts (iceberg format). */ -}}
connector.name=iceberg
iceberg.catalog.type=glue
hive.metastore.glue.region={{ required "trino.cloudCatalog.region required for glue" $cc.region }}
{{- if $cc.glueCatalogId }}
hive.metastore.glue.catalogid={{ $cc.glueCatalogId }}
{{- end }}
fs.native-s3.enabled=true
s3.region={{ $cc.region }}
{{- else if eq $p "s3tables" -}}
{{- /* EKS — Amazon S3 Tables managed Iceberg REST catalog. Keyless via SIGV4 signed
       with the pod IAM role (no OAuth2 credential). Warehouse = the S3 Tables bucket
       ARN. */ -}}
connector.name=iceberg
iceberg.catalog.type=rest
iceberg.rest-catalog.uri={{ required "trino.cloudCatalog.restUri required for s3tables" $cc.restUri }}
iceberg.rest-catalog.warehouse={{ required "trino.cloudCatalog.warehouse (S3 Tables bucket ARN) required" $cc.warehouse }}
iceberg.rest-catalog.security=SIGV4
iceberg.rest-catalog.signing-name=s3tables
iceberg.rest-catalog.sigv4-enabled=true
fs.native-s3.enabled=true
s3.region={{ required "trino.cloudCatalog.region required for s3tables" $cc.region }}
{{- else if eq $p "adls" -}}
{{- /* AKS — ADLS Gen2 native, keyless. azure.auth-type=DEFAULT => DefaultAzureCredential
       resolves the pod's user-assigned managed identity (Entra Workload ID). Uses a
       Hadoop-catalog-style Iceberg over the ADLS filesystem root (no external REST
       metastore); differs from fabric.ts's OAuth-secret path — here the identity is
       ambient. */ -}}
connector.name=iceberg
iceberg.catalog.type=hadoop
iceberg.catalog.warehouse={{ required "trino.cloudCatalog.warehouse (abfss:// root) required for adls" $cc.warehouse }}
fs.native-azure.enabled=true
azure.auth-type=DEFAULT
{{- if $cc.clientId }}
{{- /* AKS footgun (report §2): with more than one identity on the node, DEFAULT
       must be pinned to the intended MI client-id or it picks the wrong one. */ -}}
azure.user-assigned-managed-identity-client-id={{ $cc.clientId }}
{{- end }}
{{- else -}}
{{- fail (printf "trino.cloudCatalog.provider must be one of biglake|glue|s3tables|adls, got %q" $p) -}}
{{- end -}}
{{- end -}}
