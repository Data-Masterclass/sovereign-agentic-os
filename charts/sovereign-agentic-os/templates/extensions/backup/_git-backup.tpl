{{- /*
  SPDX-License-Identifier: Apache-2.0
  Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)

  WP-56 helpers. os-ui.yaml includes the three os-ui pieces (env, sidecar, volumes) so the
  shared template carries one line each; everything else lives in this folder.
*/}}

{{- /* Digest-pinned, always: the default digest is empty, so a feature switched on without the
       owner's pushed digest refuses to render. */}}
{{- define "soa.backupToolsImage" -}}
{{- $i := .Values.backup.gitBundles.image -}}
{{ $i.repository }}:{{ $i.tag }}@{{ required "backup.gitBundles.image.digest is required when git bundles or a restore drill are enabled (run build-images.yml for backup-tools and set the pushed digest)" $i.digest }}
{{- end -}}

{{- define "soa.gitBundlesOn" -}}
{{- $dpg := .Values.osUI.dataProjectGit | default dict -}}
{{- if and .Values.backup.gitBundles.enabled $dpg.enabled -}}true{{- end -}}
{{- end -}}

{{- /* S3 env for the git-bundle bucket (owner-created Secret). */}}
{{- define "soa.gitBundleS3Env" -}}
{{- $g := .Values.backup.gitBundles -}}
- name: S3_ENDPOINT
  value: {{ $g.endpoint | quote }}
- name: S3_BUCKET
  value: {{ required "backup.gitBundles.bucket is required when git bundles or the restore drill are enabled" $g.bucket | quote }}
- name: AWS_DEFAULT_REGION
  value: {{ $g.region | quote }}
- name: AWS_ACCESS_KEY_ID
  valueFrom: { secretKeyRef: { name: {{ $g.secretName }}, key: AWS_ACCESS_KEY_ID } }
- name: AWS_SECRET_ACCESS_KEY
  valueFrom: { secretKeyRef: { name: {{ $g.secretName }}, key: AWS_SECRET_ACCESS_KEY } }
- name: BUNDLE_PREFIX
  value: {{ $g.prefix | quote }}
- name: OBJECT_LOCK_MODE
  value: {{ $g.objectLock.mode | default "" | quote }}
- name: OBJECT_LOCK_DAYS
  value: {{ $g.objectLock.days | default 0 | quote }}
- name: HOME
  value: /tmp
{{- if .Values.egressProxy.enabled }}
# STACKIT Object Storage is outside the cluster: through the egress proxy (allowlisted host).
- name: HTTPS_PROXY
  value: http://egress-proxy:3128
- name: NO_PROXY
  value: "localhost,127.0.0.1,os-ui,minio,opensearch,kubernetes.default.svc,.svc,.cluster.local"
{{- end }}
{{- end -}}

{{- /* os-ui container env: where the sidecar's status is, and which drills are on (Monitoring). */}}
{{- define "soa.gitBackupOsUiEnv" -}}
{{- $b := .Values.backup -}}
{{- if include "soa.gitBundlesOn" . }}
- name: GIT_BACKUP_QUEUE_DIR
  value: /backup-queue/queue
- name: GIT_BACKUP_STATUS_FILE
  value: /backup-queue/status.json
- name: GIT_BACKUP_RESCAN_SECONDS
  value: {{ $b.gitBundles.rescanSeconds | quote }}
- name: GIT_BACKUP_REFS_RECORD_SECONDS
  value: {{ $b.gitBundles.refsRecordSeconds | quote }}
{{- end }}
{{- if or $b.drill.enabled $b.veleroDrill.enabled }}
- name: RESTORE_DRILL_ENABLED
  value: {{ $b.drill.enabled | quote }}
- name: VELERO_DRILL_ENABLED
  value: {{ $b.veleroDrill.enabled | quote }}
- name: RESTORE_DRILL_STATUS_CONFIGMAP
  value: {{ $b.drill.statusConfigMap | quote }}
{{- end }}
{{- end -}}

{{- define "soa.gitBackupOsUiMounts" -}}
{{- if include "soa.gitBundlesOn" . }}
- name: backup-queue
  mountPath: /backup-queue
{{- end }}
{{- end -}}

{{- /* The `git-backup` sidecar: repos READ-ONLY, the queue shared with os-ui. */}}
{{- define "soa.gitBackupSidecar" -}}
{{- if include "soa.gitBundlesOn" . }}
{{- $g := .Values.backup.gitBundles }}
- name: git-backup
  image: {{ include "soa.backupToolsImage" . | quote }}
  imagePullPolicy: {{ .Values.global.imagePullPolicy }}
  securityContext:
    {{- include "soa.containerSecurityContext" . | nindent 4 }}
    readOnlyRootFilesystem: true
  command: ["/bin/sh", "/opt/soa/backup/git-bundler.sh"]
  env:
    {{- include "soa.gitBundleS3Env" . | nindent 4 }}
    - { name: REPOS_DIR, value: /repos }
    - { name: QUEUE_DIR, value: /backup-queue/queue }
    - { name: STATUS_FILE, value: /backup-queue/status.json }
    - { name: BACKUP_WORK, value: /tmp }
    - { name: REFS_PREFIX, value: {{ $g.refsPrefix | quote }} }
    - { name: POLL_SECONDS, value: {{ $g.pollSeconds | quote }} }
    - { name: RESCAN_SECONDS, value: {{ $g.rescanSeconds | quote }} }
    - { name: REFS_RECORD_SECONDS, value: {{ $g.refsRecordSeconds | quote }} }
    - { name: BUNDLE_TMP_BUDGET_MB, value: {{ $g.tmpBudgetMi | quote }} }
  resources:
    {{- toYaml $g.resources | nindent 4 }}
  volumeMounts:
    - { name: os-repos, mountPath: /repos, readOnly: true }
    - { name: backup-queue, mountPath: /backup-queue }
    - { name: backup-scripts, mountPath: /opt/soa/backup, readOnly: true }
    - { name: git-backup-tmp, mountPath: /tmp }
{{- end }}
{{- end -}}

{{- define "soa.gitBackupVolumes" -}}
{{- if include "soa.gitBundlesOn" . }}
- name: backup-queue
  emptyDir: { sizeLimit: 16Mi }
- name: git-backup-tmp
  # Above the bundle budget (tmpBudgetMi, enforced by git-bundle.sh) so it is never reached:
  # an emptyDir over its sizeLimit evicts the WHOLE os-ui pod.
  emptyDir: { sizeLimit: {{ .Values.backup.gitBundles.tmpSizeLimit | quote }} }
- name: backup-scripts
  configMap:
    name: backup-scripts
    defaultMode: 0555
{{- end }}
{{- end -}}
