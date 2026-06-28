# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Outputs = the contract that wires the chart. Non-sensitive endpoints feed
# values.stackit-managed.yaml (deploy/scripts/render-values.sh); sensitive
# credentials feed Secrets Manager (deploy/scripts/push-secrets.sh), never git.

# --- Cluster access ----------------------------------------------------------

output "kubeconfig" {
  description = "Short-lived admin kubeconfig for Argo CD bootstrap. Written to ./kubeconfig.yaml (gitignored)."
  value       = stackit_ske_kubeconfig.this.kube_config
  sensitive   = true
}

output "cluster_name" {
  description = "SKE cluster name."
  value       = stackit_ske_cluster.this.name
}

# --- Object Storage (endpoint = public; keys = sensitive) --------------------

output "object_storage_endpoint" {
  description = "S3-compatible endpoint -> objectStorage.external.endpoint."
  value       = local.object_storage_endpoint
}

output "object_storage_buckets" {
  description = "Provisioned bucket names (prefixed)."
  value       = { for k, b in stackit_objectstorage_bucket.buckets : k => b.name }
}

# NOTE: every managed-service output below degrades to `null` (or `{}`) in Mode A
# (var.enable_managed_backends=false), where the resource has count/for_each = 0.
# render-values.sh / push-secrets.sh treat empty outputs as "skip", so the Mode A
# self-hosted overlay (bundled backends) needs none of them.

output "object_storage_access_key" {
  description = "S3 access key -> Secrets Manager (object-storage-credentials). null in Mode A."
  value       = try(stackit_objectstorage_credential.app[0].access_key, null)
  sensitive   = true
}

output "object_storage_secret_key" {
  description = "S3 secret key -> Secrets Manager (object-storage-credentials). null in Mode A."
  value       = try(stackit_objectstorage_credential.app[0].secret_access_key, null)
  sensitive   = true
}

# --- PostgreSQL Flex ---------------------------------------------------------

output "postgres_host" {
  description = "Postgres Flex host -> postgres.external.host. null in Mode A (bundled CNPG)."
  value       = try(stackit_postgresflex_user.app[0].host, null)
}

output "postgres_port" {
  description = "Postgres Flex port. null in Mode A."
  value       = try(stackit_postgresflex_user.app[0].port, null)
}

output "postgres_username" {
  description = "Postgres app user -> Secrets Manager (postgres-credentials). null in Mode A."
  value       = try(stackit_postgresflex_user.app[0].username, null)
  sensitive   = true
}

output "postgres_password" {
  description = "Postgres app password -> Secrets Manager (postgres-credentials). null in Mode A."
  value       = try(stackit_postgresflex_user.app[0].password, null)
  sensitive   = true
}

# --- OpenSearch --------------------------------------------------------------

output "opensearch_host" {
  description = "OpenSearch host -> opensearch.external.host. null in Mode A (bundled subchart)."
  value       = try(stackit_opensearch_credential.app[0].host, null)
}

output "opensearch_port" {
  description = "OpenSearch port. null in Mode A."
  value       = try(stackit_opensearch_credential.app[0].port, null)
}

output "opensearch_username" {
  description = "OpenSearch user -> Secrets Manager (opensearch-credentials). null in Mode A."
  value       = try(stackit_opensearch_credential.app[0].username, null)
  sensitive   = true
}

output "opensearch_password" {
  description = "OpenSearch password -> Secrets Manager (opensearch-credentials). null in Mode A."
  value       = try(stackit_opensearch_credential.app[0].password, null)
  sensitive   = true
}

# --- AI Model Serving --------------------------------------------------------

output "model_serving_base_url" {
  description = "OpenAI-compatible base URL -> LiteLLM api_base. null in Mode A (bundled mock)."
  value       = var.enable_managed_backends ? local.model_serving_base_url : null
}

output "model_serving_token" {
  description = "AI Model Serving auth token -> Secrets Manager (stackit-ai-model-serving-key). null in Mode A."
  value       = try(stackit_modelserving_token.litellm[0].token, null)
  sensitive   = true
}

# --- Secrets Manager (for External Secrets ClusterSecretStore + push-secrets) -

output "secretsmanager_instance_id" {
  description = "Secrets Manager instance ID (ESO ClusterSecretStore path). null in Mode A."
  value       = try(stackit_secretsmanager_instance.this[0].instance_id, null)
}

output "secretsmanager_writer_username" {
  description = "Writer user for push-secrets.sh. null in Mode A."
  value       = try(stackit_secretsmanager_user.writer[0].username, null)
  sensitive   = true
}

output "secretsmanager_writer_password" {
  description = "Writer password for push-secrets.sh. null in Mode A."
  value       = try(stackit_secretsmanager_user.writer[0].password, null)
  sensitive   = true
}

output "secretsmanager_eso_username" {
  description = "Reader user for External Secrets Operator. null in Mode A."
  value       = try(stackit_secretsmanager_user.eso[0].username, null)
  sensitive   = true
}

output "secretsmanager_eso_password" {
  description = "Reader password for External Secrets Operator. null in Mode A."
  value       = try(stackit_secretsmanager_user.eso[0].password, null)
  sensitive   = true
}

# --- Registry + DNS ----------------------------------------------------------

output "container_registry_url" {
  description = "Container Registry base URL (manual; see registry.tf) -> image repositories."
  value       = local.container_registry_url
}

output "dns_zone_id" {
  description = "DNS zone ID."
  value       = stackit_dns_zone.this.zone_id
}

output "dns_name" {
  description = "Apex DNS name -> ingress host suffix (render-values.sh)."
  value       = var.dns_name
}

output "ingress_hostnames" {
  description = "Fully-qualified ingress hostnames -> chart ingress hosts."
  value       = { for s in var.ingress_subdomains : s => "${s}.${var.dns_name}" }
}
