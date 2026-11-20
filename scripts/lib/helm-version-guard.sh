#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# helm-version-guard.sh — refuse a Helm client below major version 4 (deploy.sh, rollback.sh).
# The Secret deletion guard and the External Secrets handover were proven on Helm 4 (verifier,
# helm v4.2.2: Helm reads helm.sh/resource-policy on the live object). FAIL CLOSED: a version that
# cannot be read refuses too. Prints the version on success.
set -uo pipefail
v=$(helm version --template '{{.Version}}' 2>/dev/null) || v=""
major=$(printf '%s' "$v" | sed -nE 's/^v?([0-9]+)\..*/\1/p')
if [ -z "$major" ]; then
  echo "HELM_VERSION_REFUSED — cannot read the Helm client version ('${v}'); Helm 4 or newer is required" >&2; exit 1
fi
if [ "$major" -lt 4 ]; then
  echo "HELM_VERSION_REFUSED — Helm $v is below 4; deploys and rollbacks need Helm 4 or newer (docs/ops/external-secrets-migration.md)" >&2; exit 1
fi
echo "   helm $v"
