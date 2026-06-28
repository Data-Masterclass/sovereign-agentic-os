# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# STACKIT managed OpenSearch (Data Services) — the Mode B retrieval backbone
# (vector + lexical). Replaces the in-cluster OpenSearch subchart
# (opensearch.enabled=false in the overlay). The instance has no connection
# details; the credential resource carries host/port/uri/username/password,
# which feed the chart via External Secrets (opensearch.external.secretName).

resource "stackit_opensearch_instance" "this" {
  project_id = var.project_id
  name       = "${var.name_prefix}-opensearch"
  plan_name  = var.opensearch_plan_name
  version    = var.opensearch_version
}

resource "stackit_opensearch_credential" "app" {
  project_id  = var.project_id
  instance_id = stackit_opensearch_instance.this.instance_id
}
