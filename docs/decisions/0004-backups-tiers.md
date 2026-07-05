<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# ADR 0004 — Three-tier backups (pg_dump · Velero · pre-upgrade gate)

**Status:** Accepted · **Source:** `docs/backups.md`, `deploy/pre-upgrade-backup.sh`, `deploy/velero/`, chart `backup.pgDump`

## Context

Durable is not backed up: a PVC still dies with its disk, and a file-level copy
of a running Postgres is not a valid backup. The platform's state spans
Postgres (nine DBs), MinIO (Iceberg lakehouse + uploads + dumps), OpenSearch
(mirrors + knowledge indices), Forgejo repos and Harbor — each with different
consistency needs.

## Decision

Three chained tiers:

- **Tier 0** — nightly `pg-dump` CronJob: logical dump of every DB + globals to
  `s3://lakehouse/backups/pg/`, 14-day retention. The **only** consistent
  Postgres path; Velero deliberately skips live PGDATA.
- **Tier 1** — nightly Velero + kopia: file-level backup of all `agentic-os`
  pod volumes **off-cluster** to a dedicated STACKIT bucket, 30-day retention.
  Crash-consistent for MinIO/OpenSearch/ClickHouse; model weights excluded
  (re-downloadable).
- **Tier 2** — `deploy/pre-upgrade-backup.sh` before **every** helm upgrade or
  stateful roll: fresh dump + ad-hoc Velero backup, awaited before any change.

## Consequences

- RPO ≤ 24 h nightly, minutes around upgrades; restore is proven only by
  drills (`docs/runbooks/restore-drill.md`), not assumed.
- Known unprotected (documented, accepted for now): un-mirrored in-process
  writes, Terraform state and operator-side secrets, scratch namespaces, and
  the backup bucket itself has no second copy.
