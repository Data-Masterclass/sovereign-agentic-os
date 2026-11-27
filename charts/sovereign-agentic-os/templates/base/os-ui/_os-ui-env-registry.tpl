{{- /*
  APP BUILDER: the platform registry and env namespaces for os-ui (owner: workstream C1; spec 6.2, 6.4). Renders
  NOTHING while `softwareRunner.environments.enabled` is false (spec 2a: no env change, no pod restart). Keys (read by
  core/kernel/config.ts): SOFTWARE_APPS_DEV_NAMESPACE, SOFTWARE_APPS_PROD_NAMESPACE, SOFTWARE_APP_REGISTRY (the
  in-cluster host the build pushes to and the deploy validates against), SOFTWARE_APP_REGISTRY_PULL (the host nodes
  pull through). Included by soa.osUI.runEnv. The helpers below are shared with software-registry.yaml and
  software-tekton.yaml so every template names the same hosts.
*/}}
{{- define "soa.appBuilder.enabled" -}}
{{- if ((.Values.softwareRunner | default dict).environments | default dict).enabled | default false }}true{{- end }}
{{- end }}

{{- /* The build platform is configured: the switch on, the Software Factory CI on (the build namespace exists) and a
       builder image named. Anything less renders no registry and no build step, and os-ui gets an EMPTY registry
       (config.ts: "Empty = not configured (a deploy refuses, never guesses)"). */}}
{{- define "soa.appBuilder.buildReady" -}}
{{- if and (include "soa.appBuilder.enabled" .) ((((.Values.osUI | default dict).software | default dict).tekton | default dict).enabled) ((((.Values.softwareRunner | default dict).environments | default dict).build | default dict).image) }}true{{- end }}
{{- end }}

{{- /* BUILD ISOLATION (required whenever builds are on; no exception, dev included): untrusted RUN code gets an
       unprivileged user namespace, i.e. kernel attack surface with node-root impact, so it never shares a node's kernel
       with the platform. `dedicated-nodes` = build pods only on a tainted pool (nodeSelector + tolerations);
       `sandbox-runtime` = a RuntimeClass with its own kernel boundary (gVisor, Kata) that supports user namespaces.
       Renders the podTemplate fields as YAML; fails the render on anything else. docs/components/app-builder-build.md */}}
{{- define "soa.appBuilder.buildIsolation" -}}
{{- $b := ((.Values.softwareRunner | default dict).environments | default dict).build | default dict }}
{{- $iso := $b.isolation | default "" }}
{{- if eq $iso "dedicated-nodes" }}
{{- $d := $b.dedicatedNodes | default dict }}
{{- if not $d.nodeSelector }}{{ fail "softwareRunner.environments.build.dedicatedNodes.nodeSelector is required with isolation dedicated-nodes" }}{{ end }}
{{- if not $d.tolerations }}{{ fail "softwareRunner.environments.build.dedicatedNodes.tolerations is required with isolation dedicated-nodes (the build pool is tainted so nothing else lands there)" }}{{ end }}
{{- dict "nodeSelector" $d.nodeSelector "tolerations" $d.tolerations | toYaml }}
{{- else if eq $iso "sandbox-runtime" }}
{{- $s := $b.sandboxRuntime | default dict }}
{{- dict "runtimeClassName" (required "softwareRunner.environments.build.sandboxRuntime.runtimeClassName is required with isolation sandbox-runtime" $s.runtimeClassName) | toYaml }}
{{- else }}
{{- fail (printf "softwareRunner.environments.build.isolation must be dedicated-nodes or sandbox-runtime when builds are enabled (got %q): untrusted build code never shares a node kernel with the platform" $iso) }}
{{- end }}
{{- end }}

{{- /* The builder image: by digest, and the digest must be on files/builder-digests.txt - the list of digests the gated
       build (build-images.yml, image=builder: licence gate + SBOM) produced, added by a reviewed PR. Anything else
       (a hand-built or test image) fails the render. */}}
{{- define "soa.appBuilder.builderImage" -}}
{{- $img := (((.Values.softwareRunner | default dict).environments | default dict).build | default dict).image | default "" }}
{{- if not (regexMatch "^[^@\\s]+@sha256:[0-9a-f]{64}$" $img) }}{{ fail (printf "softwareRunner.environments.build.image must be <repository>@sha256:<digest> (got %q)" $img) }}{{ end }}
{{- $digest := regexReplaceAll "^.*@" $img "" }}
{{- $allowed := list }}
{{- range (.Files.Get "files/builder-digests.txt" | splitList "\n") }}{{ $l := trim . }}{{ if and $l (not (hasPrefix "#" $l)) }}{{ $allowed = append $allowed (index (splitList " " $l) 0) }}{{ end }}{{ end }}
{{- if not (has $digest $allowed) }}{{ fail (printf "softwareRunner.environments.build.image %s is not on files/builder-digests.txt (only digests produced by the gated builder build may run)" $digest) }}{{ end }}
{{- $img }}
{{- end }}

{{- define "soa.appBuilder.registry" -}}
{{- (((.Values.osUI | default dict).software | default dict).registry | default dict) | toYaml }}
{{- end }}

{{- /* The in-cluster registry host: Zot's ClusterIP Service, or the external registry. */}}
{{- define "soa.appBuilder.registryHost" -}}
{{- $r := include "soa.appBuilder.registry" . | fromYaml }}
{{- if eq ($r.mode | default "zot") "external" -}}
{{- required "osUI.software.registry.externalUrl is required with mode external" $r.externalUrl | trimPrefix "https://" | trimPrefix "http://" | trimSuffix "/" }}
{{- else -}}
zot.{{ .Release.Namespace }}.svc.cluster.local:5000
{{- end }}
{{- end }}

{{- /* The node-facing host (exposure ingress-restricted / internal-lb), or the external registry. */}}
{{- define "soa.appBuilder.registryPullHost" -}}
{{- $r := include "soa.appBuilder.registry" . | fromYaml }}
{{- if eq ($r.mode | default "zot") "external" -}}
{{- include "soa.appBuilder.registryHost" . }}
{{- else if eq ($r.exposure | default "ingress-restricted") "external" -}}
{{- else -}}
{{- required "osUI.software.registry.host (the node-facing registry host) is required when the App Builder is on" $r.host }}
{{- end }}
{{- end }}

{{- define "soa.osUI.env.registry" -}}
{{- if include "soa.appBuilder.enabled" . }}
{{- $e := .Values.softwareRunner.environments }}
# ---- App Builder (C1): env namespaces and the platform registry. Off renders nothing here. ----
- name: SOFTWARE_APPS_DEV_NAMESPACE
  value: {{ $e.devNamespace | default "apps-dev" | quote }}
- name: SOFTWARE_APPS_PROD_NAMESPACE
  value: {{ $e.prodNamespace | default "apps-prod" | quote }}
{{- if include "soa.appBuilder.buildReady" . }}
- name: SOFTWARE_APP_REGISTRY
  value: {{ include "soa.appBuilder.registryHost" . | quote }}
- name: SOFTWARE_APP_REGISTRY_PULL
  value: {{ include "soa.appBuilder.registryPullHost" . | quote }}
{{- else }}
# The build platform is not configured (CI off or no builder image): an empty registry makes every deploy refuse.
- name: SOFTWARE_APP_REGISTRY
  value: ""
- name: SOFTWARE_APP_REGISTRY_PULL
  value: ""
{{- end }}
{{- end }}
{{- end }}
