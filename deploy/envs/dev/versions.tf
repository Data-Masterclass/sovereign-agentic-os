# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# The DEV environment of the Sovereign Agentic OS — its own Terraform root, so its state can
# never be the production state.
#
#   - This directory is a separate root module. `tofu -chdir=deploy/envs/dev ...` reads and
#     writes ONLY `deploy/envs/dev/dev.tfstate` (gitignored). Production lives in
#     `deploy/terraform/` with its own state; nothing here references it.
#   - The resources live in a SEPARATE STACKIT project (var.project_id), refused when it equals
#     the production project (variables.tf validation), so a credential, a bucket or a network
#     of dev cannot be a production one.
#   - Apply ONLY with -target (docs/ops/dev-environment.md "Create"). Never a plain apply.
terraform {
  required_version = ">= 1.6.0"

  required_providers {
    stackit = {
      source = "stackitcloud/stackit"
      # Same line as production (deploy/terraform/versions.tf). Bump both together.
      version = "~> 0.99"
    }
  }

  # Local state, in THIS directory, under a name production never uses. tfstate carries the
  # kubeconfig and the object-storage keys: it is gitignored (deploy/envs/dev/.gitignore).
  # To move it to object storage later, use a bucket IN THE DEV PROJECT and a key that
  # contains "dev", then `tofu init -migrate-state`.
  backend "local" {
    path = "dev.tfstate"
  }
}

provider "stackit" {
  default_region           = var.region
  service_account_key_path = var.service_account_key_path
}
