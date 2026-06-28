# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# STACKIT Secrets Manager — the secrets backend (security.md). STACKIT Secrets
# Manager is HashiCorp-Vault-API compatible (KV v2); External Secrets Operator
# reads from it via its `vault` provider (ClusterSecretStore in
# deploy/argocd/apps). Terraform provisions the INSTANCE + a writer USER; the
# actual secret VALUES are written in a separate step (deploy/scripts/
# push-secrets.sh) because the provider has no per-secret resource.
#
# Flow at go-live:
#   1. terraform apply         -> instance + writer user (this file)
#   2. scripts/push-secrets.sh -> writes credential VALUES into Secrets Manager
#                                 (object storage, postgres, opensearch, AI token,
#                                 registry pull-secret) using the user below
#   3. External Secrets        -> syncs them into the cluster as k8s Secrets

# Mode A (var.enable_managed_backends=false): NOT created — the self-contained
# chart carries its own in-cluster secrets; External Secrets / Secrets Manager
# are a Mode B concern only.
resource "stackit_secretsmanager_instance" "this" {
  count      = var.enable_managed_backends ? 1 : 0
  project_id = var.project_id
  name       = "${var.name_prefix}-secrets"
  # Tighten to the SKE egress CIDR at go-live (default open for first bring-up).
  acls = var.postgres_acl
}

# Writer user used by scripts/push-secrets.sh to populate secret values.
resource "stackit_secretsmanager_user" "writer" {
  count         = var.enable_managed_backends ? 1 : 0
  project_id    = var.project_id
  instance_id   = stackit_secretsmanager_instance.this[0].instance_id
  description   = "sovereign-os terraform writer (push-secrets.sh)"
  write_enabled = true
}

# Reader user for External Secrets Operator (read-only).
resource "stackit_secretsmanager_user" "eso" {
  count         = var.enable_managed_backends ? 1 : 0
  project_id    = var.project_id
  instance_id   = stackit_secretsmanager_instance.this[0].instance_id
  description   = "external-secrets-operator reader"
  write_enabled = false
}
