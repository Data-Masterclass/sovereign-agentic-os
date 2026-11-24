{{- /*
  The os-ui-worker ServiceAccount as an EXTRA subject of the scoped Roles its agent tools need
  (PR #334 review: the worker loads every MCP tool, so get_monitoring_overview, get_software_status,
  start_preview / decide_deploy / run_app_tests call the same narrow Roles os-ui uses). Included in
  each such RoleBinding right after the os-ui subject, only when the worker is enabled:
    os-ui-backup-status, os-ui-velero-backups, os-ui-apps-runner, os-ui-software-scanner,
    os-ui-software-checks, os-ui-connection-secrets.
  NEVER the main `os-ui` Role, and never a Role that reads Secrets in the release namespace.
  scripts/check-worker-env.mjs maps every Kubernetes call reachable from worker/agent-runs.ts to the
  Role that covers it and fails on an unmapped one.
  Usage:  {{- include "soa.osUI.workerSubject" $ | nindent 2 }}
*/}}
{{- define "soa.osUI.workerSubject" -}}
{{- if and .Values.osUI.worker .Values.osUI.worker.enabled -}}
- { kind: ServiceAccount, name: os-ui-worker, namespace: {{ .Release.Namespace }} }
{{- end -}}
{{- end -}}
