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

output "object_storage_access_key" {
  description = "S3 access key -> Secrets Manager (object-storage-credentials)."
  value       = stackit_objectstorage_credential.app.access_key
  sensitive   = true
}

output "object_storage_secret_key" {
  description = "S3 secret key -> Secrets Manager (object-storage-credentials)."
  value       = stackit_objectstorage_credential.app.secret_access_key
  sensitive   = true
}

# --- PostgreSQL Flex ---------------------------------------------------------

output "postgres_host" {
  description = "Postgres Flex host -> postgres.external.host."
  value       = stackit_postgresflex_user.app.host
}

output "postgres_port" {
  description = "Postgres Flex port."
  value       = stackit_postgresflex_user.app.port
}

output "postgres_username" {
  description = "Postgres app user -> Secrets Manager (postgres-credentials)."
  value       = stackit_postgresflex_user.app.username
  sensitive   = true
}

output "postgres_password" {
  description = "Postgres app password -> Secrets Manager (postgres-credentials)."
  value       = stackit_postgresflex_user.app.password
  sensitive   = true
}

# --- OpenSearch --------------------------------------------------------------

output "opensearch_host" {
  description = "OpenSearch host -> opensearch.external.host."
  value       = stackit_opensearch_credential.app.host
}

output "opensearch_port" {
  description = "OpenSearch port."
  value       = stackit_opensearch_credential.app.port
}

output "opensearch_username" {
  description = "OpenSearch user -> Secrets Manager (opensearch-credentials)."
  value       = stackit_opensearch_credential.app.username
  sensitive   = true
}

output "opensearch_password" {
  description = "OpenSearch password -> Secrets Manager (opensearch-credentials)."
  value       = stackit_opensearch_credential.app.password
  sensitive   = true
}

# --- AI Model Serving --------------------------------------------------------

output "model_serving_base_url" {
  description = "OpenAI-compatible base URL -> LiteLLM api_base."
  value       = local.model_serving_base_url
}

output "model_serving_token" {
  description = "AI Model Serving auth token -> Secrets Manager (stackit-ai-model-serving-key)."
  value       = stackit_modelserving_token.litellm.token
  sensitive   = true
}

# --- Secrets Manager (for External Secrets ClusterSecretStore + push-secrets) -

output "secretsmanager_instance_id" {
  description = "Secrets Manager instance ID (ESO ClusterSecretStore path)."
  value       = stackit_secretsmanager_instance.this.instance_id
}

output "secretsmanager_writer_username" {
  description = "Writer user for push-secrets.sh."
  value       = stackit_secretsmanager_user.writer.username
  sensitive   = true
}

output "secretsmanager_writer_password" {
  description = "Writer password for push-secrets.sh."
  value       = stackit_secretsmanager_user.writer.password
  sensitive   = true
}

output "secretsmanager_eso_username" {
  description = "Reader user for External Secrets Operator."
  value       = stackit_secretsmanager_user.eso.username
  sensitive   = true
}

output "secretsmanager_eso_password" {
  description = "Reader password for External Secrets Operator."
  value       = stackit_secretsmanager_user.eso.password
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
