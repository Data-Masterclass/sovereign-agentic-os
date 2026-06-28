# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# STACKIT AI Model Serving — managed, sovereign, OpenAI-compatible inference.
# LiteLLM routes to it (llm.provider=stackit in the overlay). The provider
# manages the AUTH TOKEN; the inference endpoint itself is a fixed base URL (not
# a TF resource). The token is written to Secrets Manager by push-secrets.sh and
# surfaced to LiteLLM via External Secrets (llm.secretRef).

# Mode A (var.enable_managed_backends=false): NOT created — LiteLLM routes to the
# bundled local mock model in the self-contained chart (no managed inference).
resource "stackit_modelserving_token" "litellm" {
  count        = var.enable_managed_backends ? 1 : 0
  project_id   = var.project_id
  name         = "${var.name_prefix}-litellm"
  description  = "LiteLLM -> STACKIT AI Model Serving"
  ttl_duration = var.model_serving_token_ttl
}

locals {
  # Fixed OpenAI-compatible base URL for STACKIT AI Model Serving (eu01).
  model_serving_base_url = "https://api.openai-compat.model-serving.${var.region}.onstackit.cloud/v1"
}
