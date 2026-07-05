# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Backup target — ONE STACKIT Object Storage bucket + its own credential for
# Velero (deploy/velero/). Deliberately UNGATED by enable_managed_backends:
# Mode A keeps every *workload* backend bundled in-cluster, but the BACKUPS of
# that in-cluster state must live OFF-CLUSTER or they die with the cluster.
# This is additive-only — a targeted apply creates exactly these three
# resources and touches nothing else:
#
#   tofu -chdir=deploy/terraform apply \
#     -var enable_managed_backends=false \
#     -target=stackit_objectstorage_bucket.backup \
#     -target=stackit_objectstorage_credentials_group.backup \
#     -target=stackit_objectstorage_credential.backup
#
# Credentials are a SEPARATE group from the (Mode B) app credentials group so
# workload keys and backup keys can be rotated/revoked independently.
# NOTE: STACKIT Object Storage credentials are project-scoped (any credential
# can reach any bucket in the project) — acceptable here; the isolation win is
# independent rotation, not bucket scoping.

resource "stackit_objectstorage_bucket" "backup" {
  project_id = var.project_id
  name       = "${var.name_prefix}-velero-backups"
}

resource "stackit_objectstorage_credentials_group" "backup" {
  project_id = var.project_id
  name       = "${var.name_prefix}-backup"
}

resource "stackit_objectstorage_credential" "backup" {
  project_id           = var.project_id
  credentials_group_id = stackit_objectstorage_credentials_group.backup.credentials_group_id
  # Rotate before expiry; 1 year matches the app credential's policy.
  expiration_timestamp = timeadd(timestamp(), "8760h")

  lifecycle {
    # `timestamp()` changes every plan; don't churn the credential on every apply.
    ignore_changes = [expiration_timestamp]
  }
}

output "backup_bucket_name" {
  description = "Velero backup bucket (deploy/velero/install.sh reads this)."
  value       = stackit_objectstorage_bucket.backup.name
}

output "backup_s3_endpoint" {
  description = "S3 endpoint for the backup bucket (path-style)."
  value       = local.object_storage_endpoint
}

output "backup_access_key" {
  description = "Backup-only S3 access key (velero-credentials Secret)."
  value       = stackit_objectstorage_credential.backup.access_key
  sensitive   = true
}

output "backup_secret_key" {
  description = "Backup-only S3 secret key (velero-credentials Secret)."
  value       = stackit_objectstorage_credential.backup.secret_access_key
  sensitive   = true
}
