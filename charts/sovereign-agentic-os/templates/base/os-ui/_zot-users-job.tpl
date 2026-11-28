{{- /*
  Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
  SPDX-License-Identifier: Apache-2.0

  The `zot-users` reconcile's Job spec, ONE definition for its three users:
    - the `zot-users` CronJob and the install Job (software-registry.yaml);
    - os-ui's on-demand reconcile, a Job created from the CronJob's template (core/adapters/zot/client.ts
      `startReconcile`) — which the release namespace's admission policy (os-ui-workload-admission.yaml) pins to
      exactly this image, command, env and volume, so os-ui's `create jobs` cannot run anything else as the
      zot-users ServiceAccount.
  Renders YAML (use with `fromYaml`). Only meaningful where software-registry.yaml renders (registry mode zot).
*/}}
{{- define "soa.zotUsers.jobSpec" -}}
{{- $r := include "soa.appBuilder.registry" . | fromYaml }}
{{- $e := .Values.softwareRunner.environments }}
{{- $platform := .Release.Namespace }}
{{- $tk := ((.Values.osUI.software | default dict).tekton | default dict) }}
{{- $buildNs := $tk.namespace | default "agentic-build" }}
{{- $users := $r.users | default dict }}
{{- $envNs := list ($e.devNamespace | default "apps-dev") ($e.prodNamespace | default "apps-prod") }}
{{- $job := dict
  "backoffLimit" 2
  "ttlSecondsAfterFinished" 3600
  "template" (dict
    "metadata" (dict "labels" (dict "app.kubernetes.io/component" "zot-users"))
    "spec" (dict
      "serviceAccountName" "zot-users"
      "restartPolicy" "Never"
      "priorityClassName" ($e.build.priorityClass | default dict).name
      "securityContext" (dict "runAsNonRoot" true "runAsUser" 65532 "runAsGroup" 65532 "seccompProfile" (dict "type" "RuntimeDefault"))
      "containers" (list (dict
        "name" "zot-users"
        "image" (include "soa.appBuilder.builderImage" .)
        "command" (list "/usr/local/bin/zot-users")
        "env" (list
          (dict "name" "PUSH_NAMESPACE" "value" $buildNs)
          (dict "name" "ZOT_NAMESPACE" "value" $platform)
          (dict "name" "PULL_NAMESPACES" "value" (join "," $envNs))
          (dict "name" "APPS_DEV_NAMESPACE" "value" (index $envNs 0))
          (dict "name" "APPS_PROD_NAMESPACE" "value" (index $envNs 1))
          (dict "name" "REGISTRY_PULL_HOST" "value" (include "soa.appBuilder.registryPullHost" .))
          (dict "name" "REGISTRY_HOST" "value" (include "soa.appBuilder.registryHost" .))
          (dict "name" "SCAN_PULL_NAMESPACE" "value" $buildNs))
        "securityContext" (dict "allowPrivilegeEscalation" false "readOnlyRootFilesystem" true "capabilities" (dict "drop" (list "ALL")))
        "resources" ($users.resources | default (dict "requests" (dict "cpu" "10m" "memory" "32Mi")))
        "volumeMounts" (list (dict "name" "template" "mountPath" "/etc/zot-template" "readOnly" true))))
      "volumes" (list (dict "name" "template" "configMap" (dict "name" "zot-config-template")))))
}}
{{- toYaml $job }}
{{- end }}
