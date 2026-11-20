{{/*
The policy and data files every OPA instance loads, in order: the `opa` Deployment and the Trino
pod's OPA sidecar (WP-14) load exactly the same set from the `opa-policy` ConfigMap. Explicit
files, not the directory: ConfigMap volumes add `..data` symlinks that make a recursive load see
each file several times.
*/}}
{{- define "soa.opaPolicyFiles" -}}
- "/policies/authz.rego"
- "/policies/data.json"
- "/policies/trino.rego"
- "/policies/trino_impersonation.rego"
- "/policies/governance.json"
- "/policies/connections.rego"
- "/policies/system-log.rego"
{{- end -}}
