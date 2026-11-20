{{- /*
  WP-10 — which platform Secrets External Secrets owns (design 00 §3.2, S2).

  soa.eso.owned (list $ "<secret name>")  → "true" when ESO writes that Secret
    (externalSecrets.enabled and the name is in externalSecrets.managed). Every chart template that
    renders a Secret of the catalog skips it then, so Helm and ESO never both write one Secret.
  soa.eso.keep (list $ "<secret name>")   → the `helm.sh/resource-policy: keep` annotation line
    when the name is in externalSecrets.handover (or managed): the handover release. Helm then
    leaves the Secret in place when a later release stops rendering it, and ESO takes it over
    (creationPolicy Orphan) without the Secret ever disappearing.
*/}}
{{- define "soa.eso.owned" -}}
{{- $ctx := index . 0 -}}{{- $name := index . 1 -}}
{{- $e := $ctx.Values.externalSecrets | default dict -}}
{{- if and $e.enabled (has $name ($e.managed | default list)) -}}true{{- end -}}
{{- end -}}

{{- define "soa.eso.keep" -}}
{{- $ctx := index . 0 -}}{{- $name := index . 1 -}}
{{- $e := $ctx.Values.externalSecrets | default dict -}}
{{- if or (has $name ($e.handover | default list)) (has $name ($e.managed | default list)) -}}
"helm.sh/resource-policy": keep
{{- end -}}
{{- end -}}
