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
{{/*
The env every OpenSearch client in the chart gets (os-ui, os-ui-worker, the
wait-for-opensearch initContainer, the maintenance Jobs): the URL and, when
`opensearchClient.credentialsSecret` is set (WP-22), basic-auth credentials from
that Secret's `username` / `password` keys. Credentials are added HERE only.
*/}}
{{- define "soa.opensearchClientEnv" -}}
- name: OPENSEARCH_URL
  value: {{ include "soa.opensearchUrl" . | quote }}
{{- with (.Values.opensearchClient | default dict).credentialsSecret }}
- name: OPENSEARCH_USERNAME
  valueFrom: { secretKeyRef: { name: {{ . | quote }}, key: username } }
- name: OPENSEARCH_PASSWORD
  valueFrom: { secretKeyRef: { name: {{ . | quote }}, key: password } }
{{- end }}
{{- end -}}

{{- define "soa.pgHost" -}}
{{- if .Values.postgres.enabled -}}
pg-rw
{{- else -}}
{{ required "postgres.external.host is required when postgres.enabled=false" .Values.postgres.external.host }}
{{- end -}}
{{- end -}}

{{/* OpenSearch base URL: the bundled Service with the subchart's own `protocol`
     (`http` while the security plugin is off; `https` once WP-22 turns TLS on), or the
     managed endpoint. The ONE place the chart builds this URL. */}}
{{- define "soa.opensearchUrl" -}}
{{- if .Values.opensearch.enabled -}}
{{ .Values.opensearch.protocol | default "http" }}://{{ .Values.opensearch.masterService | default "opensearch" }}:{{ .Values.opensearch.httpPort | default 9200 }}
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
{{- /* A RESTRICTED console (soa.restrictedHosts) has a public URL only when its route is
       actually rendered. A hostname left in the values without the opt-in must give "" here,
       or every "open in Langfuse" link in the OS would point at a host that no longer answers. */ -}}
{{- if and $host (has .key (include "soa.restrictedHosts" . | fromJsonArray)) -}}
{{- if ne (include "soa.restrictedExposed" (dict "ctx" .ctx "key" .key)) "true" -}}{{- $host = "" -}}{{- end -}}
{{- end -}}
{{- if $host -}}https://{{ $host }}{{- end -}}
{{- else -}}
{{- .fallback -}}
{{- end -}}
{{- end -}}

{{/*
The consoles that get NO public route unless an operator opts in AND protects the route:
  litellm  — the model gateway: provider credentials and an admin API;
  langfuse — every prompt, completion and tool result of every run, behind one login.
Neither needs to be called from outside the cluster (os-ui, the worker, the gateway and the Jobs
use the in-cluster Services). `scripts/check-consoles-not-public.mjs` holds this list too.
*/}}
{{- define "soa.restrictedHosts" -}}
["litellm","langfuse"]
{{- end -}}

{{/*
"true" when a restricted console is deliberately published: `ingress.restricted.<key>.expose`
is true. Fails the render when the opt-in carries no protection annotation — a public route to
one of these consoles with nothing in front of it is the state this chart exists to prevent.
Args: dict "ctx" $ "key" "<litellm|langfuse>"
*/}}
{{- define "soa.restrictedExposed" -}}
{{- $r := index ((.ctx.Values.ingress | default dict).restricted | default dict) .key | default dict -}}
{{- if eq (toString $r.expose) "true" -}}
{{- $a := $r.annotations | default dict -}}
{{- $allow := index $a "nginx.ingress.kubernetes.io/whitelist-source-range" | default "" -}}
{{- $authUrl := index $a "nginx.ingress.kubernetes.io/auth-url" | default "" -}}
{{- $basic := and (index $a "nginx.ingress.kubernetes.io/auth-type" | default "") (index $a "nginx.ingress.kubernetes.io/auth-secret" | default "") -}}
{{- $mtls := eq (index $a "nginx.ingress.kubernetes.io/auth-tls-verify-client" | default "") "on" -}}
{{- if not (or $allow $authUrl $basic $mtls) -}}
{{- fail (printf "ingress.restricted.%s.expose is true but ingress.restricted.%s.annotations sets no protection. Add one of: nginx.ingress.kubernetes.io/whitelist-source-range, nginx.ingress.kubernetes.io/auth-url, auth-type + auth-secret, or auth-tls-verify-client: \"on\". See docs/components/litellm.md \"Not reachable from the internet\"." .key .key) -}}
{{- end -}}
{{- if or (contains "0.0.0.0/0" $allow) (contains "::/0" $allow) -}}
{{- fail (printf "ingress.restricted.%s.annotations: whitelist-source-range contains 0.0.0.0/0 or ::/0, which is no allowlist at all." .key) -}}
{{- end -}}
true
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
{{- /* READ BUDGET (B4-review-E-1). Both are needed: QUERY_MAX_RUN_TIME becomes Trino's
       `query_max_run_time` session property (so TRINO abandons a runaway read, instead of it
       outliving the os-ui client that stopped waiting at 8 s), and QUERY_MAX_ROWS bounds what the
       query-tool buffers and returns, reporting `truncated` rather than clipping silently.
       EXECUTE_MAX_RUN_TIME is deliberately NOT set: a full-refresh sync legitimately runs for
       minutes, so the write ceiling stays opt-in. */}}
- name: QUERY_MAX_RUN_TIME
  value: {{ (.Values.queryTool.budget | default dict).maxRunTime | default "60s" | quote }}
- name: QUERY_MAX_ROWS
  value: {{ (.Values.queryTool.budget | default dict).maxRows | default 10000 | quote }}
{{- if ((.Values.queryTool.budget | default dict).executeMaxRunTime) }}
- name: EXECUTE_MAX_RUN_TIME
  value: {{ .Values.queryTool.budget.executeMaxRunTime | quote }}
{{- end }}
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
priorityClassName line for a tier (critical, infra, app, observability; see values.yaml
`priorityClasses` for the ladder), gated by
`priorityClasses.enabled`. Renders nothing when disabled so local-kind installs
that don't create the PriorityClass objects still admit every pod. Place under a
pod `spec:`. Args: dict "ctx" $ "tier" "<critical|infra|app|observability>".
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

{{/*
Name of the Secret holding docling-serve's API key (key `apiKey`): the operator's
`docling.apiKey.existingSecret` (e.g. an ExternalSecret target) or the chart's `docling-api-key`.
Used by the docling Deployment and by os-ui / os-ui-worker, so the key checked is the key sent.
*/}}
{{- define "soa.doclingApiKeySecret" -}}
{{- .Values.docling.apiKey.existingSecret | default "docling-api-key" -}}
{{- end -}}

{{/*
The data-runner image reference: `repository:tag@digest` (the digest is required and chart-owned),
or `repository:tag` only with `dataRunner.image.localBuild` (kind; refused in production by
templates/extensions/lakehouse/data-runner.yaml). One definition for every pod that runs it.
*/}}
{{- define "soa.dataRunnerImage" -}}
{{- $i := .Values.dataRunner.image -}}
{{- if $i.localBuild -}}
{{ $i.repository }}:{{ $i.tag }}
{{- else -}}
{{ $i.repository }}:{{ $i.tag }}@{{ required "dataRunner.image.digest must be set: the digest build-images.yml printed for this tag" $i.digest }}
{{- end -}}
{{- end -}}
