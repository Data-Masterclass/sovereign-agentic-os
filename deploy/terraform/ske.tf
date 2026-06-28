# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# SKE (STACKIT Kubernetes Engine) cluster + worker node pool.
#
# CNI = Cilium: SKE runs Cilium as its platform CNI by default (FQDN-aware
# egress + default-deny per security.md). The provider exposes NO cni/plugin
# attribute — Cilium is not a Terraform-selectable knob, it is the SKE default.
# The chart's Cilium NetworkPolicies (default-deny egress) ride on top.

resource "stackit_ske_cluster" "this" {
  project_id             = var.project_id
  name                   = var.name_prefix
  kubernetes_version_min = var.kubernetes_version_min

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
}
