# Velero

Upstream, unmodified. Nothing in this folder is ours — see `components/README.md`.

- **Licence:** Apache-2.0
- **Source:** https://github.com/vmware-tanzu/velero
- **Pinned as:** Helm chart `velero` 8.1.0 (https://vmware-tanzu.github.io/helm-charts), as in
  `deploy/velero/values.yaml` and `deploy/argocd/apps/05-velero.yaml`; plugin
  `velero/velero-plugin-for-aws:v1.11.0`; kopia file-system backup.
- **Docs used (WP-56 monthly restore drill):**
  - Restore reference — `--namespace-mappings`, `--include-resources`, `--selector`:
    https://velero.io/docs/v1.15/restore-reference/
  - Restore resource modifiers (JSON patch on restored objects, Velero >= 1.12):
    https://velero.io/docs/v1.15/restore-resource-modifiers/
  - File-system backup and restore (PodVolumeRestore, restore helper init container):
    https://velero.io/docs/v1.15/file-system-backup/

**Why the OS ships it:** the daily off-cluster file-level backup of the namespace's volumes
(deploy/velero/), and the monthly drill that proves one restores
(`charts/sovereign-agentic-os/templates/extensions/backup/velero-drill-cronjob.yaml`).
