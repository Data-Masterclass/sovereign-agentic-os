{{- /*
  Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
  SPDX-License-Identifier: Apache-2.0

  WHICH platform workloads os-ui may change, and how — the names its Role (os-ui.yaml) grants by
  `resourceNames` and its admission policy (os-ui-workload-admission.yaml) re-checks. One list each,
  so the two cannot drift. Each list is JSON (use with `fromJsonArray`).

  Before 2026-11-28 os-ui held `patch` + `update` on EVERY Deployment and StatefulSet of the release
  namespace: a compromised os-ui could set any platform workload's image, ServiceAccount, env or
  volumes and so run code as any identity here, with every Secret it mounts. What it really does:
    - the Platform page's on/off toggle PATCHes `/scale` of the components marked `toggle: true` in
      os-ui/tabs/admin/lib/platform.ts REGISTRY — nothing else of those objects;
    - the live warehouse registration (Connections, external connectors on) strategic-merge-PATCHes
      the `trino` Deployment: secretKeyRef env entries for the provider's credential variables and a
      rollout annotation (os-ui/tabs/connections/lib/warehouse/k8s-registration.ts).
  os-ui/tabs/admin/lib/platform-rbac.test.ts and k8s-registration.test.ts fail when the code and these
  lists disagree; scripts/check-os-ui-workload-rbac-chart.mjs fails when a render grants more.
*/}}

{{- /* Deployments the Platform toggle scales 0<->1 (REGISTRY: kind deploy, toggle true). */}}
{{- define "soa.osUI.toggleDeployments" -}}
["minio","valkey","clickhouse","agentic-os-langfuse-web","agentic-os-litellm","mock-model","opa","agentic-os-dagster-webserver","docling","polaris","data-runner","query-tool","egress-proxy","web-fetch"]
{{- end }}

{{- /* StatefulSets the Platform toggle scales 0<->1 (REGISTRY: kind sts, toggle true). */}}
{{- define "soa.osUI.toggleStatefulSets" -}}
["opensearch-master","victoria-metrics","victoria-logs"]
{{- end }}

{{- /* The credential env variables a warehouse provider's catalog reads (`${ENV:VAR}`; each provider's
       `secretMaterial.envVars` under os-ui/tabs/connections/lib/warehouse/providers/). The ONLY env names
       os-ui may add to (or drop from) the trino container, each as a secretKeyRef to `trino-ext-*`. */}}
{{- define "soa.osUI.trinoSecretEnv" -}}
["DATABRICKS_TOKEN","AZURE_CLIENT_ID","AZURE_CLIENT_SECRET","AZURE_TENANT_ID","SNOWFLAKE_PRIVATE_KEY","MYSQL_PASSWORD","POSTGRESQL_PASSWORD","SQLSERVER_PASSWORD","MONGODB_CONNECTION_URL"]
{{- end }}

{{- /* Pod-template annotations os-ui may set on a workload it patches: the rollout trigger of the warehouse
       registration, and `kubectl rollout restart`'s own key. Every other annotation stays as it is. */}}
{{- define "soa.osUI.rolloutAnnotations" -}}
["soa.dev/catalog-registered","kubectl.kubernetes.io/restartedAt"]
{{- end }}
