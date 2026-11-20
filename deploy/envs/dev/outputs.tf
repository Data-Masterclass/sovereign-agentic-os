# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Outputs of the dev environment. Sensitive ones are read by scripts/dev/*.sh straight into
# files with mode 600 or into the dev cluster; they are never printed.

output "environment" {
  description = "Always \"dev\". scripts/dev/*.sh refuse a state whose environment output is anything else."
  value       = "dev"
}

output "cluster_name" {
  description = "Dev SKE cluster name (= the dev kube context name)."
  value       = stackit_ske_cluster.dev.name
}

output "kubernetes_version" {
  description = "Kubernetes version SKE runs for the dev cluster."
  value       = stackit_ske_cluster.dev.kubernetes_version_used
}

output "kubeconfig" {
  description = "Admin kubeconfig of the dev cluster (7 days). scripts/dev/kubeconfig.sh writes it to ~/.kube/dmagosdev.yaml."
  value       = stackit_ske_kubeconfig.dev.kube_config
  sensitive   = true
}

output "ingress_public_ip" {
  description = "Reserved public IPv4 for the dev ingress LoadBalancer (lb.stackit.cloud/external-address)."
  value       = stackit_public_ip.ingress.ip
}

output "dns_record" {
  description = "The ONE DNS record the owner adds at Cloudflare (DNS only, not proxied)."
  value       = "${var.ingress_subdomains[0] == "" ? var.dns_name : "${var.ingress_subdomains[0]}.${var.dns_name}"}  A  ${stackit_public_ip.ingress.ip}"
}

output "ingress_hostnames" {
  description = "Fully qualified dev hostnames."
  value       = { for s in var.ingress_subdomains : (s == "" ? "apex" : s) => (s == "" ? var.dns_name : "${s}.${var.dns_name}") }
}

output "object_storage_endpoint" {
  description = "S3 endpoint (path-style)."
  value       = local.object_storage_endpoint
}

output "object_storage_bucket" {
  description = "Dev backup bucket."
  value       = stackit_objectstorage_bucket.dev.name
}

output "object_storage_access_key" {
  description = "Dev-only S3 access key (scripts/dev/bootstrap-secrets.sh puts it into the dev cluster)."
  value       = stackit_objectstorage_credential.dev.access_key
  sensitive   = true
}

output "object_storage_secret_key" {
  description = "Dev-only S3 secret key."
  value       = stackit_objectstorage_credential.dev.secret_access_key
  sensitive   = true
}
