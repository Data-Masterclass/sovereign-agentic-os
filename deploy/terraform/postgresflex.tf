# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# STACKIT PostgreSQL Flex — the Mode B infra-Postgres backend (Langfuse, Cube,
# OpenMetadata, LiteLLM, Dagster, warehouse). Replaces the in-cluster
# CloudNativePG cluster (postgres.enabled=false in the overlay). One owner user
# is provisioned; per-service databases/roles are created on first use or via a
# bootstrap Job. Credentials feed the chart via External Secrets
# (postgres.external.secretName).

resource "stackit_postgresflex_instance" "this" {
  project_id      = var.project_id
  name            = "${var.name_prefix}-pg"
  version         = var.postgres_version
  replicas        = var.postgres_replicas
  flavor          = var.postgres_flavor
  storage         = var.postgres_storage
  acl             = var.postgres_acl
  backup_schedule = var.postgres_backup_schedule
}

resource "stackit_postgresflex_user" "app" {
  project_id  = var.project_id
  instance_id = stackit_postgresflex_instance.this.instance_id
  username    = "agentic_os"
  # Login + create-db so the chart's services can own their databases.
  roles = ["login", "createdb"]
}
