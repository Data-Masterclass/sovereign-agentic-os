{{- /*
  APP BUILDER: the app databases for os-ui (owner: workstream D; spec section 7). Renders NOTHING while
  `softwareRunner.environments.enabled` is false (spec 2a: no env change, no os-ui pod restart). With the switch on it
  renders SOFTWARE_APP_DATABASES_MODE (`cnpg` | `external` | "" = none; read by core/kernel/config.ts, which treats
  anything else as "") and SOFTWARE_APP_DATABASES_CLUSTER (the CNPG Cluster name in each env namespace). Included by
  soa.osUI.runEnv. The helpers below are shared with software-app-databases.yaml and software-app-databases-rbac.yaml.
*/}}
{{- define "soa.appDatabases.values" -}}
{{- (((.Values.osUI | default dict).software | default dict).databases | default dict) | toYaml }}
{{- end }}

{{- /* The CNPG mode is on: the switch on AND databases.mode == cnpg. `external` is designed, not built: it renders the
       env (os-ui then refuses with that reason) and no Kubernetes object. */}}
{{- define "soa.appDatabases.cnpg" -}}
{{- $db := include "soa.appDatabases.values" . | fromYaml }}
{{- if and (include "soa.appBuilder.enabled" .) (eq ($db.mode | default "") "cnpg") }}true{{- end }}
{{- end }}

{{- define "soa.osUI.env.databases" -}}
{{- if include "soa.appBuilder.enabled" . }}
{{- $db := include "soa.appDatabases.values" . | fromYaml }}
{{- $mode := $db.mode | default "" }}
{{- if not (has $mode (list "" "cnpg" "external")) }}{{ fail (printf "osUI.software.databases.mode must be cnpg, external or empty (got %q)" $mode) }}{{ end }}
# ---- App Builder (D): the app databases. Off renders nothing here. ----
- name: SOFTWARE_APP_DATABASES_MODE
  value: {{ $mode | quote }}
- name: SOFTWARE_APP_DATABASES_CLUSTER
  value: {{ $db.cluster | default "apps-pg" | quote }}
{{- end }}
{{- end }}

{{- /* The .spec property names of a CNPG kind (files/cnpg/<kind>-spec-fields.txt), comments dropped, as JSON. */}}
{{- define "soa.appDatabases.specFields" -}}
{{- $out := list }}
{{- range (.ctx.Files.Get (printf "files/cnpg/%s-spec-fields.txt" .kind) | splitList "\n") }}{{ $l := trim . }}{{ if and $l (not (hasPrefix "#" $l)) }}{{ $out = append $out $l }}{{ end }}{{ end }}
{{- $out | toJson }}
{{- end }}

{{- /* CEL: every Cluster .spec property except `managed` is unchanged by this update (in both and equal, or in neither).
       Generated from the field list so no property is forgotten by hand. */}}
{{- define "soa.appDatabases.clusterSpecUnchanged" -}}
{{- $parts := list }}
{{- range (include "soa.appDatabases.specFields" (dict "ctx" . "kind" "cluster") | fromJsonArray) }}
{{- if ne . "managed" }}
{{- $parts = append $parts (printf "(has(object.spec.%s) == has(oldObject.spec.%s) && (!has(object.spec.%s) || object.spec.%s == oldObject.spec.%s))" . . . . .) }}
{{- end }}
{{- end }}
{{- join " && " $parts }}
{{- end }}

{{- /* CEL: a Database sets none of the .spec properties outside name, owner, cluster, ensure, databaseReclaimPolicy. */}}
{{- define "soa.appDatabases.databaseSpecClosed" -}}
{{- $parts := list }}
{{- range (include "soa.appDatabases.specFields" (dict "ctx" . "kind" "database") | fromJsonArray) }}
{{- if not (has . (list "name" "owner" "cluster" "ensure" "databaseReclaimPolicy")) }}
{{- $parts = append $parts (printf "!has(object.spec.%s)" .) }}
{{- end }}
{{- end }}
{{- join " && " $parts }}
{{- end }}

{{- /* Admission validations for a pod spec os-ui writes in an env namespace (review HIGH-2). Arguments: `pod` (CEL path of
       the PodSpec), `meta` (CEL path of the pod metadata), `jobs` ("true" when a Job/CronJob may carry
       soa.dev/role=app-migrate). Needs `variables.own` (the two Secrets the workload may name). */}}
{{- define "soa.appDatabases.podRules" -}}
- expression: >-
    {{ .pod }}.containers.all(c,
    (!has(c.env) || c.env.all(e, !has(e.valueFrom) || !has(e.valueFrom.secretKeyRef) || e.valueFrom.secretKeyRef.name in variables.own)) &&
    (!has(c.envFrom) || c.envFrom.all(f, !has(f.secretRef) || f.secretRef.name in variables.own)))
  message: "app-databases: a container may name only its own app's -db / -env Secret"
  reason: Forbidden
- expression: >-
    !has({{ .pod }}.initContainers) || {{ .pod }}.initContainers.all(c,
    (!has(c.env) || c.env.all(e, !has(e.valueFrom) || !has(e.valueFrom.secretKeyRef) || e.valueFrom.secretKeyRef.name in variables.own)) &&
    (!has(c.envFrom) || c.envFrom.all(f, !has(f.secretRef) || f.secretRef.name in variables.own)))
  message: "app-databases: an init container may name only its own app's -db / -env Secret"
  reason: Forbidden
- expression: '!has({{ .pod }}.ephemeralContainers) || size({{ .pod }}.ephemeralContainers) == 0'
  message: "app-databases: no ephemeral containers"
  reason: Forbidden
- expression: >-
    !has({{ .pod }}.volumes) || {{ .pod }}.volumes.all(v,
    (!has(v.secret) || v.secret.secretName in variables.own) &&
    (!has(v.projected) || !has(v.projected.sources) || v.projected.sources.all(s,
    (!has(s.secret) || s.secret.name in variables.own) && !has(s.serviceAccountToken))))
  message: "app-databases: volumes may mount only the app's own -db / -env Secret, never a service-account token"
  reason: Forbidden
- expression: >-
    has({{ .pod }}.automountServiceAccountToken) && {{ .pod }}.automountServiceAccountToken == false &&
    (!has({{ .pod }}.serviceAccountName) || {{ .pod }}.serviceAccountName == 'default') &&
    (!has({{ .pod }}.serviceAccount) || {{ .pod }}.serviceAccount == 'default') &&
    (!has({{ .pod }}.imagePullSecrets) || size({{ .pod }}.imagePullSecrets) == 0)
  message: "app-databases: automountServiceAccountToken false, the default ServiceAccount, no imagePullSecrets"
  reason: Forbidden
- expression: >-
    !has({{ .meta }}.labels) || {{ .meta }}.labels.all(k, !k.startsWith('cnpg.io/') &&
    (k != 'soa.dev/role' || ({{ .jobs }} && {{ .meta }}.labels[k] == 'app-migrate')))
  message: "app-databases: cnpg.io/* pod labels belong to the database; soa.dev/role only as app-migrate on a Job"
  reason: Forbidden
{{- end }}

{{- /* CEL variables: the workload's base name (`app-<domain>-<slug>-<h8>`: `name` with a closed part suffix removed) and
       the two Secrets it may name. A name not of that shape names no Secret at all. */}}
{{- define "soa.appDatabases.ownVars" -}}
- name: wname
  expression: {{ .name | quote }}
- name: base
  expression: >-
    variables.wname.endsWith('-p1') || variables.wname.endsWith('-p2') ? variables.wname.substring(0, size(variables.wname) - 3) :
    variables.wname.endsWith('-migrate') ? variables.wname.substring(0, size(variables.wname) - 8) :
    variables.wname.endsWith('-revoke') ? variables.wname.substring(0, size(variables.wname) - 7) :
    variables.wname.endsWith('-admission') ? variables.wname.substring(0, size(variables.wname) - 10) : variables.wname
- name: own
  expression: >-
    variables.base.matches('^app-[a-z0-9-]+-[0-9a-f]{8}$') ? [variables.base + '-db', variables.base + '-env'] : []
{{- end }}
