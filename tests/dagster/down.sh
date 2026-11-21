#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# Stop the WP-15 harness: the Dagster container, the kind cluster (own kubeconfig), the lakehouse.
set -uo pipefail
cd "$(dirname "$0")/../.."
export LH_PROJECT=${LH_PROJECT:-soa-wp15}
WORK=$(cat "${TMPDIR:-/tmp}/${LH_PROJECT}.work" 2>/dev/null || true)
docker rm -f wp15-dagster >/dev/null 2>&1
if [ -n "$WORK" ] && [ -f "$WORK/wp15/kubeconfig" ]; then
  kind delete cluster --name "${WP15_KIND:-wp15}" --kubeconfig "$WORK/wp15/kubeconfig" >/dev/null 2>&1
fi
bash tests/lakehouse/down.sh
