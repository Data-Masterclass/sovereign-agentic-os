<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Backups — what is protected, by what, and what is not

Three tiers protect the self-hosted (Mode A) STACKIT deploy. Everything below
assumes the OpenSearch PVC migration (`deploy/opensearch-pvc-migration.sh`) has
run and Velero (`deploy/velero/install.sh`) is installed.

## The three tiers

| Tier | Mechanism | Schedule | Retention | Target |
|---|---|---|---|---|
| 0 | `pg-dump` CronJob (chart, `backup.pgDump`) — logical dump of **every** Postgres DB + globals | 02:30 UTC nightly | 14 days (job-enforced) | `s3://lakehouse/backups/pg/<stamp>/` (bundled MinIO) |
| 1 | Velero + kopia node-agent — file-level backup of **all pod volumes** in `agentic-os` (opt-out) | 03:00 UTC nightly | 30 days (`ttl: 720h`) | STACKIT Object Storage bucket `<prefix>-velero-backups` (off-cluster) |
| 2 | `deploy/pre-upgrade-backup.sh` — fresh pg dump **and** ad-hoc Velero backup, waits for both | before **every** helm upgrade / stateful roll | 10 days (`ttl: 240h`) | same as above |

The tiers chain: the nightly pg dump lands on the `minio-data` PVC, and Velero
carries that PVC off-cluster 30 minutes later — so the newest **off-cluster**
Postgres dump is at most one day old, and at most ~30 minutes stale relative to
that night's Velero backup.

## Per data class

| Data | Where it lives | Protected by | RPO | RTO (est.) |
|---|---|---|---|---|
| Langfuse / Polaris (Iceberg catalog) / Featureform / LiteLLM / Dagster / Superset / OpenMetadata / MLflow / warehouse DBs | `pg` STS, PVC `data-pg-0` | pg_dump (consistent); Velero **skips** live PGDATA on purpose | ≤ 24 h (minutes if you run `pre-upgrade-backup.sh` first) | ~30 min (restore dumps into a fresh pg) |
| Lakehouse: Iceberg incl. the 150k mart, uploads, MLflow artifacts, **pg dumps** | MinIO, PVC `minio-data` | Velero fs-backup | ≤ 24 h | hours (kopia restore of ~20 Gi) |
| OpenSearch: `os-*` mirrors (approvals, audit, and every artifact store after the mirror-bootstrap deploy), `files`, `knowledge`, `haystack_knowledge` | STS `opensearch-master`, PVC `opensearch-master-opensearch-master-0` (post-migration) | Velero fs-backup | ≤ 24 h | ~1 h |
| Forgejo repos | PVC `gitea-shared-storage` | Velero fs-backup | ≤ 24 h | ~1 h |
| Harbor registry | PVC `harbor-registry-data` | Velero fs-backup (images also rebuildable by CI) | ≤ 24 h | ~1 h |
| CI runner state, JupyterHub DB, poet poems | PVCs `ci-runner-data`, `hub-db-dir`, `poet-poems` | Velero fs-backup | ≤ 24 h | ~1 h |
| ClickHouse (Langfuse analytics) | emptyDir | Velero fs-backup (opt-out covers emptyDirs) — **crash-consistent at best** | ≤ 24 h, best effort | hours |
| Valkey (queue/cache) | emptyDir | fs-backup best-effort; contents are cache — treat as disposable | n/a | n/a |

## Consistency notes (honest)

- **Postgres**: only the pg_dump path is consistent. Velero deliberately
  excludes the live PGDATA volume (annotation on the `pg` pod template) — a
  file-level copy of a running Postgres is not a valid backup.
- **MinIO / OpenSearch / ClickHouse under Velero**: kopia copies files while
  the service runs — *crash-consistent*, not application-consistent. MinIO's
  immutable object layout tolerates this well; OpenSearch usually recovers
  (and the `os-*` indices are re-mirrored by os-ui on next write); ClickHouse
  is best-effort. For a guaranteed-clean cut, run `pre-upgrade-backup.sh`
  during a quiet window.
- **Restore is only proven by drills** — see
  [runbooks/restore-drill.md](runbooks/restore-drill.md). Run one after the
  first Velero backup and after any storage change.

## STILL UNPROTECTED (know the gaps)

- **In-process-only os-ui state**: anything written to an os-ui in-process
  store that has not (yet) mirrored to OpenSearch dies with the os-ui pod.
  After the mirror-bootstrap deploy every store mirrors on write, so the
  exposure is the write-to-mirror race only.
- **Kubernetes objects outside `agentic-os`**: the Velero schedule covers the
  `agentic-os` namespace. `agentic-os-sandbox` / `agentic-os-workbench`
  (scratch lanes), `kserve`, cert-manager/ingress config are re-creatable from
  git (`helm upgrade` + `deploy/`), not backed up.
- **Terraform state** (`deploy/terraform/terraform.tfstate`): local to the
  operator machine — copy it somewhere safe or move to the S3 backend stub in
  `versions.tf`.
- **Secrets not in git**: `deploy/values.stackit-deploy.yaml`, `stackit/sa-key.json`,
  the kubeconfig, registry pull secrets — gitignored by design; keep an
  operator-side copy (password manager / encrypted disk).
- **The backup bucket itself** has no second copy (no cross-region
  replication). Losing the STACKIT project loses cluster + backups together.

## Operations

```bash
# state of the nightly jobs
kubectl -n agentic-os get cronjob pg-dump; kubectl -n agentic-os get jobs | grep pg-dump
kubectl -n velero get schedules,backups

# the standing rule (deploy/README.md): before EVERY upgrade
deploy/pre-upgrade-backup.sh
```
