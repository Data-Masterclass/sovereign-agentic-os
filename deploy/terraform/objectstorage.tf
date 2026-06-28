# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# STACKIT Object Storage (S3-compatible) — the Mode B blob backend for the
# Iceberg lake, Langfuse blobs, MLflow artifacts, and Velero backups
# (stackit.md managed-services table). One credentials group + access key feed
# the chart via External Secrets (objectStorage.external.secretName).

locals {
  # Buckets the chart expects (values.yaml objectStorage.buckets) + Velero.
  object_storage_buckets = ["langfuse", "lakehouse", "mlflow", "velero"]

  # Fixed EU01 S3 endpoint (path-style). Confirmed regional endpoint host.
  object_storage_endpoint = "https://object.storage.${var.region}.onstackit.cloud"
}

# Mode A (var.enable_managed_backends=false): NO managed buckets — blob storage
# is bundled MinIO in-cluster from the self-contained chart, so for_each collapses
# to an empty set and the credentials group/key are not created.
resource "stackit_objectstorage_bucket" "buckets" {
  for_each   = var.enable_managed_backends ? toset(local.object_storage_buckets) : toset([])
  project_id = var.project_id
  name       = "${var.name_prefix}-${each.key}"
}

resource "stackit_objectstorage_credentials_group" "app" {
  count      = var.enable_managed_backends ? 1 : 0
  project_id = var.project_id
  name       = "${var.name_prefix}-app"
}

resource "stackit_objectstorage_credential" "app" {
  count                = var.enable_managed_backends ? 1 : 0
  project_id           = var.project_id
  credentials_group_id = stackit_objectstorage_credentials_group.app[0].credentials_group_id
  # Rotate before this; 1 year keeps the demo from expiring mid-cohort.
  expiration_timestamp = timeadd(timestamp(), "8760h")

  lifecycle {
    # `timestamp()` changes every plan; don't churn the credential on every apply.
    ignore_changes = [expiration_timestamp]
  }
}
