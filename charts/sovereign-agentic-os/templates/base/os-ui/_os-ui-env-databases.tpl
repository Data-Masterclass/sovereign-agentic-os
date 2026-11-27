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
