{{- /*
  SPDX-License-Identifier: Apache-2.0
  Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)

  WP-05 — backup FAILURE alerts in Monitoring, each read from its own source:
    - the nightly CronJobs' newest finished Job (pg-dump, opensearch-snapshot): Kubernetes
      batch/v1 Job condition `Failed`;
    - the Velero Schedule's newest finished Backup: `backups.velero.io` status.phase;
    - each OpenSearch snapshot repository's newest finished snapshot: `_cat/snapshots` status.
  A failure is a critical alert; an unreadable source is a warning. Nothing here alerts on an age.
  `soa.backupAlerts.cronJobs` / `.snapshotRepos` list only what this release really runs.
*/}}
{{- define "soa.backupAlerts.cronJobs" -}}
{{- $l := list -}}
{{- if and .Values.backup.pgDump.enabled .Values.postgres.enabled }}{{ $l = append $l "pg-dump" }}{{ end -}}
{{- $snap := .Values.opensearchSnapshots -}}
{{- if and .Values.opensearch.enabled $snap.enabled $snap.cronJob.enabled }}{{ $l = append $l "opensearch-snapshot" }}{{ end -}}
{{- join " " $l -}}
{{- end }}

{{- define "soa.backupAlerts.snapshotRepos" -}}
{{- $l := list -}}
{{- $snap := .Values.opensearchSnapshots -}}
{{- if .Values.opensearch.enabled -}}
{{- if $snap.enabled }}{{ $l = append $l ($snap.repositoryName | default "sovereign-fs") }}{{ end -}}
{{- $s3 := $snap.s3 | default dict -}}
{{- if $s3.enabled }}{{ $l = append $l ($s3.repositoryName | default "stackit-s3") }}{{ end -}}
{{- end -}}
{{- join " " $l -}}
{{- end }}

{{- define "soa.backupAlerts.env" -}}
{{- $a := (.Values.observability | default dict).backupAlerts | default dict -}}
{{- if $a.enabled }}
{{- $v := $a.velero | default dict }}
- name: SOA_BACKUP_ALERT_CRONJOBS
  value: {{ include "soa.backupAlerts.cronJobs" . | quote }}
- name: SOA_BACKUP_ALERT_SNAPSHOT_REPOS
  value: {{ include "soa.backupAlerts.snapshotRepos" . | quote }}
- name: SOA_BACKUP_ALERT_VELERO_NAMESPACE
  value: {{ $v.namespace | default "" | quote }}
- name: SOA_BACKUP_ALERT_VELERO_SCHEDULE
  value: {{ $v.scheduleName | default "" | quote }}
{{- end }}
{{- end }}
