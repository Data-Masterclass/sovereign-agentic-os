# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# STACKIT Container Registry — the bespoke-image registry (deploy/scripts/
# publish-images.sh pushes here; the chart references images by digest).
#
# IMPORTANT (verified 2026-06): the stackitcloud/stackit provider has NO
# container-registry resource. The registry is therefore the ONE manual step:
# create it once in the STACKIT portal/CLI and pass its host via
# var.container_registry_url. This file only surfaces the URL as an output and a
# documented gap — it provisions nothing. (If/when the provider gains a
# `stackit_container_registry` resource, replace this with the real resource.)

locals {
  container_registry_url = var.container_registry_url
}
