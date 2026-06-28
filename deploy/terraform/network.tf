# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# The project is in a STACKIT Network Area (SNA) -> the SKE cluster must attach to
# a network. Create a routed network (internet egress + LB).
resource "stackit_network" "this" {
  project_id         = var.project_id
  name               = "${substr(replace(var.name_prefix, "-", ""), 0, 11)}-net"
  ipv4_prefix_length = 24
  routed             = true
}
