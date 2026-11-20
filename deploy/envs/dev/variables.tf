# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Inputs of the dev environment. No secrets: credentials are provider-generated outputs.

variable "project_id" {
  description = <<-EOT
    STACKIT project that owns every dev resource. It MUST be a project of its own, not the
    production project: STACKIT Object Storage credentials are project-scoped, and projects in
    one STACKIT Network Area are connected to each other. A separate project that is not in the
    production SNA gives dev its own network, router and credentials, with no route to prod.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.project_id))
    error_message = "project_id must be a STACKIT project UUID."
  }
  validation {
    # The production project (deploy/terraform/publicip.tf records it in its import id).
    condition     = var.project_id != "7a62eb0d-6e9f-4731-9569-652d26f260c8"
    error_message = "DEV_IN_PROD_PROJECT: project_id is the production project. Dev must live in its own STACKIT project."
  }
}

variable "region" {
  description = "STACKIT region (same as production)."
  type        = string
  default     = "eu01"
}

variable "service_account_key_path" {
  description = <<-EOT
    Path to a service-account key of the DEV project only (gitignored). REQUIRED, with no
    fallback to STACKIT_SERVICE_ACCOUNT_KEY_PATH: on an operator machine that variable may hold the
    production key, and a key of the dev project is the real separation (it cannot act on prod).
  EOT
  type        = string

  validation {
    condition     = length(var.service_account_key_path) > 0 && !can(regex("prod", var.service_account_key_path))
    error_message = "service_account_key_path must name the DEV project's key file (and not a prod one)."
  }
}

variable "name_prefix" {
  description = "Prefix of every dev resource name. Must contain \"dev\" so a dev resource is never mistaken for a production one."
  type        = string
  default     = "dm-agentic-os-dev"

  validation {
    condition     = can(regex("dev", var.name_prefix))
    error_message = "name_prefix must contain \"dev\"."
  }
}

variable "cluster_name" {
  description = "SKE cluster name (SKE allows at most 11 characters). It is also the kube context name the deploy scripts expect (DEV_KUBE_CONTEXT, default dmagosdev)."
  type        = string
  default     = "dmagosdev"

  validation {
    condition     = length(var.cluster_name) <= 11 && can(regex("dev", var.cluster_name)) && var.cluster_name != "dmagenticos"
    error_message = "cluster_name must be at most 11 characters, contain \"dev\" and differ from the production cluster (dmagenticos)."
  }
}

variable "kubernetes_version_min" {
  description = <<-EOT
    The SAME Kubernetes minor as production. Production runs v1.35.9 (read 2026-11-20 with
    `kubectl --context dmagenticos version`); SKE lists 1.35, 1.36 and 1.37 as offered and 1.34
    as deprecated (docs.stackit.cloud/products/runtime/kubernetes-engine/release-notes/).
    Maintenance updates are on, as in production, so the patch level follows SKE.
  EOT
  type        = string
  default     = "1.35"
}

variable "node_machine_type" {
  description = <<-EOT
    The ONE dev worker. g2i.8 = 8 vCPU / 32 GB, EUR 0.409165/h = EUR 294.60/month (STACKIT price
    list 1.0.45, 2026-11-03). The smallest flavour that passes the capacity gate with
    values.dev.yaml: charts/sovereign-agentic-os/capacity.dev.yaml. The 4-vCPU flavours
    (g2i.4, m3i.4) fail it on CPU requests; see docs/ops/dev-environment.md "Sizing".
  EOT
  type        = string
  default     = "g2i.8"
}

variable "node_volume_size_gb" {
  description = "Node disk for container images (production uses 200; dev pulls the same images, so 100 GB is the floor with headroom for image churn)."
  type        = number
  default     = 100
}

variable "node_volume_type" {
  description = "Node volume type (same as production)."
  type        = string
  default     = "storage_premium_perf1"
}

variable "availability_zone" {
  description = "The single AZ of the one-node pool."
  type        = string
  default     = "eu01-1"
}

variable "dns_name" {
  description = <<-EOT
    The dev name suffix. The public zone is at Cloudflare, not in Terraform (main.tf "DNS"), so
    this only names the hostnames; the owner adds the record shown by `tofu output dns_record`.
  EOT
  type        = string
  default     = "dev.agentic.datamasterclass.com"

  validation {
    condition     = startswith(var.dns_name, "dev.")
    error_message = "dns_name must start with \"dev.\"."
  }
}

variable "ingress_subdomains" {
  description = "Hostnames under dns_name that point at the dev ingress IP. No litellm, no langfuse (restricted consoles, as in production)."
  type        = list(string)
  default     = ["os"]
}
