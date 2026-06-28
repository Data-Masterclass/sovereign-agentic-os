# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Input variables for the STACKIT stack. DEFAULTS now target the VERIFIED
# single-node path: a plain `tofu apply` yields one `g2i.8` worker in a single
# AZ (eu01-1), node pool pinned min=1/max=1, Kubernetes 1.34. This is the only
# end-to-end-verified topology — multi-node and Mode-B managed backends remain
# available via explicit tfvars overrides but are BLOCKED today by broken
# cross-node pod networking on SKE-in-an-SNA (see ske.tf + the deployment guide).
# No secrets here — credentials are provider-generated outputs (see outputs.tf).

# --- Identity / region -------------------------------------------------------

variable "project_id" {
  description = "STACKIT project ID that owns all resources (the Sovereign Agentic OS project)."
  type        = string
}

variable "region" {
  description = "STACKIT region. EU01 / Deutschland Süd per stackit.md §0."
  type        = string
  default     = "eu01"
}

variable "service_account_key_path" {
  description = <<-EOT
    Path to the provisioning-scoped service-account key JSON (gitignored).
    Leave null to use the STACKIT_SERVICE_ACCOUNT_KEY_PATH env var / STACKIT CLI
    credentials instead. NEVER commit the key.
  EOT
  type        = string
  default     = null
}

variable "name_prefix" {
  description = "Prefix for all created resource names."
  type        = string
  default     = "dm-agentic-os"
}

# --- Deploy mode (managed vs self-hosted backends) ---------------------------

variable "enable_managed_backends" {
  description = <<-EOT
    Mode toggle for the stateful backends.

      true  (DEFAULT) = Mode B — provision the STACKIT MANAGED services
                        (PostgreSQL Flex, OpenSearch, Object Storage, Secrets
                        Manager, AI Model Serving). The chart points at them via
                        values.stackit-managed.yaml. Managed services bill 24/7.

      false           = Mode A — provision ONLY the SKE cluster + DNS. Every
                        backend (Postgres/OpenSearch/ClickHouse/Valkey/MinIO) runs
                        IN the cluster from the self-contained chart, so the whole
                        deployment pauses with the node pool (`stackit off` / `make
                        sleep`) — NO 24/7 managed-service billing. The chart uses
                        values.selfcontained.yaml + values.stackit-selfhosted.yaml.

    ske.tf (cluster + kubeconfig) and dns.tf (zone + records) are ALWAYS created;
    only the managed-service resources are gated on this flag.
  EOT
  type        = bool
  default     = true
}

# --- Kubernetes (SKE) --------------------------------------------------------

variable "kubernetes_version_min" {
  description = "Minimum SKE Kubernetes version (SKE picks the patch)."
  type        = string
  default     = "1.34"
}

variable "node_machine_type" {
  description = <<-EOT
    SKE node-pool machine flavor. Confirm the exact flavor name in the STACKIT
    machine-type catalog for the project — availability is project/region
    dependent. `c1.4` (4 vCPU) is a verified compute flavor.

    Mode B (enable_managed_backends=true): OpenSearch JVM heaps + Postgres live in
    managed services, so ~4 vCPU / 32 GB nodes suffice.

    Mode A (enable_managed_backends=false): the full self-contained L1–L3 stack runs
    in-cluster — budget ~40–64 GB schedulable RAM across the pool (a ~16–32 GB
    memory flavor × 2–3 nodes). See deploy/terraform/terraform.tfvars.example.
  EOT
  type        = string
  default     = "g2i.8"
}

variable "node_pool_min" {
  description = <<-EOT
    Node-pool minimum (cluster-autoscaler floor; `make sleep` scales here to 0).
    DEFAULT 1 = the verified single-node path. Raising this past 1 puts the
    cluster on the multi-node topology, which is currently BLOCKED on STACKIT:
    cross-node pod networking on SKE-in-an-SNA is broken (see ske.tf / the
    deployment guide Cautions). Keep at 1 unless you have a STACKIT resolution.
  EOT
  type        = number
  default     = 1
}

variable "node_pool_max" {
  description = <<-EOT
    Node-pool maximum (cluster-autoscaler ceiling = the structural cost cap).
    DEFAULT 1 = single node. >1 enables multi-node scheduling, which is BLOCKED
    on STACKIT today (broken cross-node pod overlay — see node_pool_min).
  EOT
  type        = number
  default     = 1
}

variable "node_volume_size_gb" {
  description = "Per-node root/data volume size in GB."
  type        = number
  default     = 50
}

variable "node_volume_type" {
  description = "SKE node volume type (verified: storage_premium_perf1)."
  type        = string
  default     = "storage_premium_perf1"
}

variable "availability_zones" {
  description = <<-EOT
    EU01 availability zones for the node pool (eu01-1/-2/-3). DEFAULT is a SINGLE
    AZ (`["eu01-1"]`) to match the verified single-node path — a 1-node pool
    cannot span AZs (SKE requires node_pool_max ≥ #AZs). Multi-AZ implies
    multi-node, which is currently BLOCKED on STACKIT (broken cross-node pod
    overlay on SKE-in-an-SNA — see node_pool_min / the deployment guide).
  EOT
  type        = list(string)
  default     = ["eu01-1"]
}

# --- PostgreSQL Flex ---------------------------------------------------------

variable "postgres_version" {
  description = "Managed PostgreSQL Flex major version."
  type        = string
  default     = "16"
}

variable "postgres_flavor" {
  description = "PostgreSQL Flex compute flavor (cpu/ram)."
  type        = object({ cpu = number, ram = number })
  default     = { cpu = 2, ram = 8 }
}

variable "postgres_replicas" {
  description = "PostgreSQL Flex replicas (1 = single, 3 = HA). Production wants 3."
  type        = number
  default     = 1
}

variable "postgres_storage" {
  description = "PostgreSQL Flex storage class + size (GB)."
  type        = object({ class = string, size = number })
  default     = { class = "premium-perf2-stackit", size = 20 }
}

variable "postgres_acl" {
  description = "CIDR allowlist for PostgreSQL Flex. Default open to the SKE egress range; tighten to the cluster egress CIDR at go-live."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "postgres_backup_schedule" {
  description = "PostgreSQL Flex backup cron schedule."
  type        = string
  default     = "00 02 * * *"
}

# --- OpenSearch --------------------------------------------------------------

variable "opensearch_plan_name" {
  description = <<-EOT
    OpenSearch (Data Services) plan name. Smallest viable single-node for the
    demo; scale up for production retrieval load. Confirm exact plan names with
    `stackit opensearch plans` — they are catalog-driven.
  EOT
  type        = string
  default     = "stackit-opensearch-single-small"
}

variable "opensearch_version" {
  description = "Managed OpenSearch version."
  type        = string
  default     = "2"
}

# --- DNS ---------------------------------------------------------------------

variable "dns_name" {
  description = "Apex DNS name for the deployment (e.g. agentic-os.example.com). The OS UI + tool consoles get subdomains."
  type        = string
}

variable "dns_contact_email" {
  description = "Contact email for the DNS zone SOA."
  type        = string
  default     = "contact@datamasterclass.com"
}

variable "ingress_subdomains" {
  description = "Hostnames (relative to dns_name) that resolve to the ingress load balancer."
  type        = list(string)
  default     = ["os", "litellm", "langfuse", "openmetadata", "superset", "forgejo", "argocd"]
}

# --- Container Registry (provider has no resource — see registry.tf) ----------

variable "container_registry_url" {
  description = <<-EOT
    STACKIT Container Registry base URL for the bespoke images. The provider has
    NO container-registry resource (verified 2026-06), so the registry is created
    once out-of-band (portal/CLI) and its URL passed in here. Mode B references
    images by digest under this host. Example: registry.eu01.onstackit.cloud/<ns>.
  EOT
  type        = string
  default     = "REPLACE-registry-host/agentic-os"
}

# --- AI Model Serving --------------------------------------------------------

variable "model_serving_token_ttl" {
  description = "TTL for the AI Model Serving auth token (rotate before expiry)."
  type        = string
  default     = "720h" # 30 days
}
