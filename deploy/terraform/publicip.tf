# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Reserved ingress public IP.
#
# The ingress-nginx LoadBalancer Service is pinned to this address via the
# Service annotation `lb.stackit.cloud/external-address: <ip>` (STACKIT managed
# LB / yawol). That annotation converts the IP from LoadBalancer-managed to
# user-managed WITHOUT the address changing, so the Service can be deleted and
# recreated (or the whole SKE cluster replaced with `tofu apply -replace`) and
# still come back on the SAME public IP — no DNS change, no cert re-issue.
#
# This resource was IMPORTED from the IP that yawol originally auto-allocated
# (193.148.171.38) rather than created fresh, precisely to keep that address.
# Tracking it in Terraform means a cluster -replace never garbage-collects it,
# and it is documented/owned here.
#
#   Import id format: "<project_id>,<region>,<public_ip_id>"
#   Imported: 7a62eb0d-6e9f-4731-9569-652d26f260c8,eu01,c1ce987f-4a64-42b8-9397-20932cbb144f
#
# network_interface_id is owned by the managed LB and rotates whenever the
# Service/cluster is recreated; labels are managed by the LB controller. Both
# are ignored so Terraform never fights the LB over them (per the provider's
# Kubernetes-LB guidance).
resource "stackit_public_ip" "ingress" {
  project_id = var.project_id

  lifecycle {
    ignore_changes = [network_interface_id, labels]
  }
}
