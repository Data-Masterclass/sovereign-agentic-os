# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# SKE (STACKIT Kubernetes Engine) cluster + worker node pool.
#
# CNI = Cilium: SKE runs Cilium as its platform CNI by default (FQDN-aware
# egress + default-deny per security.md). The provider exposes NO cni/plugin
# attribute — Cilium is not a Terraform-selectable knob, it is the SKE default.
# The chart's Cilium NetworkPolicies (default-deny egress) ride on top.
#
# ⚠ VERIFIED LIMITATION — cross-node pod networking is BROKEN on SKE inside a
# STACKIT Network Area (SNA). Pods scheduled on a node WITHOUT a CoreDNS replica
# cannot reach DNS or pods on other nodes (verified: same-node traffic works,
# cross-node is 100% loss / "no servers could be reached"). This took down the
# Postgres-backed components on the first multi-node deploy: CloudNativePG's init
# pod landed on the bad node, could not resolve, and cascaded. A SINGLE node
# sidesteps it entirely (no cross-node traffic) — hence the node pool below
# defaults to min=1/max=1 in a single AZ. Do NOT scale past one node until
# STACKIT confirms cross-node overlay works for SKE-in-an-SNA.

resource "stackit_ske_cluster" "this" {
  project_id             = var.project_id
  name                   = substr(replace(var.name_prefix, "-", ""), 0, 11)
  kubernetes_version_min = var.kubernetes_version_min

  network = {
    id = stackit_network.this.network_id
  }

  node_pools = [
    {
      name         = "workers"
      machine_type = var.node_machine_type
      # Cluster-autoscaler bounds = the structural cost ceiling (stackit.md §5).
      # `make sleep` scales `minimum` to 0 for the 08:00–20:00 window.
      minimum            = var.node_pool_min
      maximum            = var.node_pool_max
      availability_zones = var.availability_zones
      volume_size        = var.node_volume_size_gb
      volume_type        = var.node_volume_type
      os_name            = "flatcar"
    }
  ]

  maintenance = {
    enable_kubernetes_version_updates    = true
    enable_machine_image_version_updates = true
    start                                = "02:00:00Z"
    end                                  = "04:00:00Z"
  }
}

# Short-lived admin kubeconfig (sensitive). Consumed by the Makefile to write
# ./kubeconfig.yaml (gitignored) for Argo CD bootstrap.
resource "stackit_ske_kubeconfig" "this" {
  project_id   = var.project_id
  cluster_name = stackit_ske_cluster.this.name
  # Refresh on apply so the bootstrap always has a valid credential.
  refresh = true
  # Long-lived admin kubeconfig (default is ~1h, which expires mid-deploy). 30 days.
  expiration = 2592000
}
