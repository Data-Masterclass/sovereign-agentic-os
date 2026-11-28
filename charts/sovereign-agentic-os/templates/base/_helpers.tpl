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
{{- $lfBase := ternary (include "soa.langfuseBasePath" .ctx) "" (eq .key "langfuse") -}}
{{- if $host -}}https://{{ $host }}{{ $lfBase }}{{- end -}}
{{- else -}}
{{- if eq .key "langfuse" -}}{{- printf "%s%s" (.fallback | toString | trimSuffix "/") (include "soa.langfuseBasePath" .ctx) -}}{{- else -}}{{- .fallback -}}{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Langfuse's base path: "/tools/langfuse" for the langfuse-oss web image, which is BUILT with
NEXT_PUBLIC_BASE_PATH=/tools/langfuse (images/extensions/langfuse-oss) and serves every page and API
there; "" for an image served at the site root (deploy/overlays/langfuse-upstream-image.yaml).
docs/components/langfuse-oss.md "Base path".
*/}}
{{- define "soa.langfuseBasePath" -}}
{{- $b := .Values.langfuseBasePath | default "" | toString | trimSuffix "/" -}}
{{- if and $b (not (hasPrefix "/" $b)) -}}{{- fail (printf "langfuseBasePath must start with / (got %q)" $b) -}}{{- end -}}
{{- $b -}}
{{- end -}}

{{/*
The in-cluster address every OS component calls Langfuse at: the web Service's origin
(`langfuseInit.host`) plus the base path. os-ui (LANGFUSE_URL), LiteLLM (LANGFUSE_HOST) and the OTel
collector's Langfuse exporter all use it.
*/}}
{{- define "soa.langfuseUrl" -}}
{{- printf "%s%s" (.Values.langfuseInit.host | default "http://agentic-os-langfuse-web:3000" | toString | trimSuffix "/") (include "soa.langfuseBasePath" .) -}}
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
is true, or `ingress.restricted.<key>.operatorIngress.enabled` (the operators' basic-auth route,
which needs a non-empty `basicAuthSecret`). Fails the render when the opt-in carries no protection annotation — a public route to
one of these consoles with nothing in front of it is the state this chart exists to prevent.
Args: dict "ctx" $ "key" "<litellm|langfuse>"
*/}}
{{- define "soa.restrictedExposed" -}}
{{- $r := index ((.ctx.Values.ingress | default dict).restricted | default dict) .key | default dict -}}
{{- $op := $r.operatorIngress | default dict -}}
{{- if eq (toString $op.enabled) "true" -}}
{{- /* The operator route carries its own protection (basic auth, added in ingress.yaml). */ -}}
{{- if not $op.basicAuthSecret -}}
{{- fail (printf "ingress.restricted.%s.operatorIngress.enabled is true but operatorIngress.basicAuthSecret is empty: name the htpasswd Secret (key `auth`) that protects the route." .key) -}}
{{- end -}}
true
{{- else if eq (toString $r.expose) "true" -}}
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
{{- $ta := .Values.trino.auth | default dict }}
{{- $tls := and $ta.enabled ($ta.clients | default dict).queryTool }}
- name: TRINO_HOST
  value: {{ .Values.queryTool.trino.host | quote }}
- name: TRINO_PORT
  value: {{ ternary $ta.httpsPort .Values.queryTool.trino.port $tls | quote }}
{{- if $tls }}
{{- /* WP-14: log in to Trino's TLS port as svc-os-ui and impersonate the principal
       (images/extensions/query-tool/trino_login.py); passwords and CA from the mounts. */}}
- name: TRINO_HTTP_SCHEME
  value: https
- name: TRINO_AUTH_USER
  value: svc-os-ui
- name: TRINO_PASSWORD_DIR
  value: /etc/trino-users
- name: TRINO_CA_FILE
  value: /etc/trino-ca/ca.crt
{{- end }}
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

{{/*
soa.egressHosts — the ONE list the egress proxy filters on, as a JSON array (fromJsonArray it).
The chart allowlist, plus each feature's own host joining with the feature that needs it:
  * the OpenSearch snapshot object-storage host (WP-21);
  * the git-bundle bucket host when bundles or a restore drill are on (WP-56);
  * LLM provider hosts: `llmProviders.allowHosts` (operators), `llmProviders.platformHosts` (the chart's
    own, e.g. Lyceum), and the STACKIT model-serving host when
    `stackitPremium.enabled` (its gateway route goes through the proxy like every other provider).
os-ui receives the SAME list as LLM_EGRESS_ALLOWLIST, so the provider flow refuses exactly what the
proxy would block, before anything is stored.
*/}}
{{- define "soa.egressHosts" -}}
{{- $hosts := .Values.egressProxy.allowlist | default list }}
{{- $s3 := (.Values.opensearchSnapshots | default dict).s3 | default dict }}
{{- if and .Values.opensearch.enabled $s3.enabled $s3.endpointHost }}
{{- $hosts = append $hosts $s3.endpointHost }}
{{- end }}
{{- /* WP-56: the git-bundle bucket's host, with the feature that needs it. */}}
{{- $gb := (.Values.backup | default dict).gitBundles | default dict }}
{{- if and (or (include "soa.gitBundlesOn" .) .Values.backup.drill.enabled .Values.backup.veleroDrill.enabled) $gb.endpointHost }}
{{- $hosts = append $hosts $gb.endpointHost }}
{{- end }}
{{- $llm := .Values.llmProviders | default dict }}
{{- range ($llm.allowHosts | default list) }}{{- $hosts = append $hosts . }}{{- end }}
{{- /* The platform's own provider hosts (chart values, git), JOINED to the operator's allowHosts. */}}
{{- range ($llm.platformHosts | default list) }}{{- $hosts = append $hosts . }}{{- end }}
{{- if and (.Values.stackitPremium | default dict).enabled .Values.stackitPremium.apiBaseUrl }}
{{- $hosts = append $hosts (regexReplaceAll ":[0-9]+$" (urlParse .Values.stackitPremium.apiBaseUrl).host "") }}
{{- end }}
{{- /* Software Factory CI: the npm registry (and any other host the checks need) is reached by the app's
       code ONLY through this proxy, so it joins the allowlist with the feature that needs it. */}}
{{- $tkc := ((.Values.osUI.software | default dict).tekton | default dict) }}
{{- if $tkc.enabled }}
{{- range ($tkc.egressHosts | default list) }}{{- $hosts = append $hosts . }}{{- end }}
{{- end }}
{{- $hosts | uniq | toJson }}
{{- end }}

{{/*
soa.litellmNoProxy — the in-cluster names the model gateway reaches WITHOUT the egress proxy
(comma-joined): loopback, every `*.svc` / `*.cluster.local` name, the OS services it calls (Langfuse
OTLP, mock-model, the MCP query tool, …) and `llmProviders.noProxy` (e.g. a bare Service name such as
`ollama`). HTTP clients match NO_PROXY by exact name or domain suffix, never by "any dotless name", so a
bare name must be listed. os-ui gets the same list (LLM_NO_PROXY) to tell in-cluster from external.
*/}}
{{- define "soa.litellmNoProxy" -}}
{{- $lf := regexReplaceAll ":[0-9]+$" (urlParse (.Values.langfuseInit.host | default "http://langfuse-web")).host "" }}
{{- $names := list "localhost" "127.0.0.1" ".svc" ".cluster.local" $lf (printf "%s-langfuse-web" .Release.Name) "mock-model" "query-tool" "valkey" "pg-rw" "opensearch" "os-ui" }}
{{- range ((.Values.llmProviders | default dict).noProxy | default list) }}{{ $names = append $names . }}{{- end }}
{{- range ((.Values.llmProviders | default dict).localModels | default list) }}{{ $names = append $names . }}{{- end }}
{{- $names | compact | uniq | join "," }}
{{- end }}

{{/*
soa.litellmViaProxy — "true" when the model gateway's outbound calls go through the egress proxy
(egressProxy.enabled and llmProviders.viaEgressProxy not false), else "". One definition for the
proxy env (litellm/egress-env.yaml), the gateway's own egress NetworkPolicy and its exclusion from
the any-443 policy, so the three can never disagree.
*/}}
{{- define "soa.litellmViaProxy" -}}
{{- $llm := .Values.llmProviders | default dict -}}
{{- if and .Values.egressProxy.enabled (ne ($llm.viaEgressProxy | toString) "false") }}true{{ end -}}
{{- end }}

{{/*
The Iceberg REST (Polaris) catalog properties Trino uses, with the OAuth2 credential as an
argument: `iceberg.properties` passes `${ENV:POLARIS_OAUTH_CREDENTIAL}`; the delete-domain purge
catalog (polaris-purge Job) passes its own principal's credential.
*/}}
{{- define "soa.icebergRestCatalogProps" -}}
{{- $t := .ctx.Values.trino -}}
{{- $ice := $t.catalog.iceberg -}}
connector.name=iceberg
iceberg.catalog.type=rest
iceberg.rest-catalog.uri={{ $ice.restUri }}
iceberg.rest-catalog.warehouse={{ $ice.warehouse }}
iceberg.rest-catalog.security=OAUTH2
iceberg.rest-catalog.oauth2.credential={{ .credential }}
iceberg.rest-catalog.oauth2.scope={{ $ice.oauth2Scope }}
iceberg.rest-catalog.vended-credentials-enabled={{ $ice.vendedCredentials }}
{{- with $ice.expireSnapshotsMinRetention }}
iceberg.expire-snapshots.min-retention={{ . }}
{{- end }}
fs.native-s3.enabled=true
s3.endpoint={{ include "soa.s3Endpoint" .ctx }}
s3.region={{ $t.s3.region }}
s3.path-style-access={{ $t.s3.pathStyleAccess }}
{{- if not $ice.vendedCredentials }}
s3.aws-access-key=${ENV:AWS_ACCESS_KEY_ID}
s3.aws-secret-key=${ENV:AWS_SECRET_ACCESS_KEY}
{{- end }}
{{- end -}}


{{/*
The query-tool image reference. Outside the local profile (where kind loads a local build) the tag
MUST pin a digest (`<version>@sha256:<64 hex>`): a tag alone can be re-pushed, and a missing image
must fail the render, not the rollout. The org-built image comes from build-images.yml
(`query-tool-v<version>` -> ghcr.io/data-masterclass/sovereign-os/query-tool).
*/}}
{{- define "soa.queryToolImage" -}}
{{- $q := .Values.queryTool.image -}}
{{- if and (ne .Values.global.profile "local") (not (regexMatch "@sha256:[0-9a-f]{64}$" (toString $q.tag))) -}}
{{- fail (printf "queryTool.image.tag %q must pin a digest (<version>@sha256:<digest>) outside the local profile" (toString $q.tag)) -}}
{{- end -}}
{{- printf "%s:%s" $q.repository $q.tag -}}
{{- end -}}

{{/*
soa.kubeStateMetrics.namespace — the dedicated namespace kube-state-metrics runs in (never the release
namespace: os-ui may create Jobs and patch Deployments there, which would let it borrow KSM's
cluster-wide pod read). Default `<release namespace>-kube-state-metrics`.
*/}}
{{- define "soa.kubeStateMetrics.namespace" -}}
{{- $k := (.Values.observability | default dict).kubeStateMetrics | default dict -}}
{{- $ns := $k.namespace | default (printf "%s-kube-state-metrics" .Release.Namespace) -}}
{{- if eq $ns .Release.Namespace -}}
{{- fail "observability.kubeStateMetrics.namespace must NOT be the release namespace: os-ui can create Jobs and patch Deployments there and would inherit kube-state-metrics' cluster-wide pod read" -}}
{{- end -}}
{{- /* Every other namespace someone else has rights in: the platform's reserved list (soa.reservedNamespaces:
       apps runner, App Builder envs, build, connection credentials, cluster namespaces), the scanner's own
       namespace, the restore-drill scratch namespace, Velero's, and anything kube-*. */ -}}
{{- $bk := .Values.backup | default dict -}}
{{- $reserved := include "soa.reservedNamespaces" . | fromJsonArray -}}
{{- $reserved = append $reserved (include "soa.scanner.namespace" .) -}}
{{- $reserved = append $reserved (($bk.veleroDrill | default dict).scratchNamespace | default "agentic-os-restore-drill") -}}
{{- $reserved = append $reserved (($bk.veleroDrill | default dict).veleroNamespace | default "velero") -}}
{{- with ((.Values.observability | default dict).backupAlerts | default dict).velero }}{{ with .namespace }}{{ $reserved = append $reserved . }}{{ end }}{{ end -}}
{{- if or (has $ns $reserved) (hasPrefix "kube-" $ns) -}}
{{- fail (printf "observability.kubeStateMetrics.namespace=%s is reserved (%s, kube-*): kube-state-metrics needs a namespace of its own where nobody else has rights" $ns (join ", " (uniq $reserved))) -}}
{{- end -}}
{{- $ns -}}
{{- end -}}

{{/*
soa.apiserverEgressRule — one NetworkPolicy egress rule to the Kubernetes API server only: the
`networkPolicies.apiserver.cidrs`, else the `kubernetes` EndpointSlice looked up at install/upgrade,
plus `extraCidrs` (the same resolution as `allow-apiserver-egress`, base/network/egress-policies.yaml).
With no address known at render time the rule is ports-only (not narrowed), as there.
*/}}
{{- define "soa.apiserverEgressRule" -}}
{{- $api := (.Values.networkPolicies.apiserver | default dict) }}
{{- $cidrs := $api.cidrs | default list }}
{{- if not $cidrs }}
{{- $slices := lookup "discovery.k8s.io/v1" "EndpointSlice" "default" "" }}
{{- range ($slices.items | default list) }}
{{- if eq (index (.metadata.labels | default dict) "kubernetes.io/service-name") "kubernetes" }}
{{- range (.endpoints | default list) }}
{{- range .addresses }}
{{- $cidrs = append $cidrs (printf "%s/32" .) }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}
{{- if $cidrs }}
{{- $cidrs = concat $cidrs ($api.extraCidrs | default list) }}
{{- end }}
- ports:
    - { protocol: TCP, port: 443 }
    - { protocol: TCP, port: 6443 }
  {{- if $cidrs }}
  to:
    {{- range ($cidrs | uniq) }}
    - ipBlock: { cidr: {{ . | quote }} }
    {{- end }}
  {{- end }}
{{- end -}}
