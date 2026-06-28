# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Provider + Terraform version pins for the Sovereign Agentic OS — STACKIT Mode B
# (full managed stack). Pinned per build-deploy-stackit.md "Pin Terraform provider".

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    stackit = {
      source = "stackitcloud/stackit"
      # Pin to the 0.99 line (0.99.0 published 2026-06-16). Bump deliberately.
      version = "~> 0.99"
    }
  }

  # ---------------------------------------------------------------------------
  # State guidance (build-deploy-stackit.md "state guidance per the brief").
  #
  # LOCAL VALIDATION: this build is validated with
  #     terraform -chdir=deploy/terraform init -backend=false && terraform validate
  # so NO backend is touched and no real STACKIT call is made.
  #
  # GO-LIVE: store state remotely in STACKIT Object Storage (S3-compatible),
  # NOT in git — tfstate carries secrets. Uncomment and fill the block below at
  # go-live: create a dedicated `tfstate` bucket + credential first, then
  # `terraform init -migrate-state`. Use credentials separate from the workloads.
  #
  # backend "s3" {
  #   bucket                      = "sovereign-os-tfstate"
  #   key                         = "mode-b/terraform.tfstate"
  #   region                      = "eu01"
  #   endpoints                   = { s3 = "https://object.storage.eu01.onstackit.cloud" }
  #   skip_credentials_validation = true
  #   skip_region_validation      = true
  #   skip_requesting_account_id  = true
  #   skip_metadata_api_check     = true
  #   use_path_style              = true
  #   # AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY = the Object Storage credential.
  # }
}

# Authentication (build-deploy-stackit.md: provisioning-scoped SA key, gitignored).
# The provider reads the service-account key from STACKIT_SERVICE_ACCOUNT_KEY_PATH
# or the path below; never commit the key. `default_region` drives regional services.
provider "stackit" {
  default_region           = var.region
  service_account_key_path = var.service_account_key_path
}
