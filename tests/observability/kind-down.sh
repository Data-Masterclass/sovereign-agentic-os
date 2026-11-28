#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# Stop the port-forwards of kind-up.sh and delete its namespace.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
[ -f "$here/.port-forward.pids" ] && xargs kill < "$here/.port-forward.pids" 2>/dev/null
rm -f "$here/.port-forward.pids"
kubectl --context "${KUBE_CONTEXT:-kind-wp05}" delete namespace "${OBS_NS:-obs-it}" --wait=false >/dev/null 2>&1 || true
kubectl --context "${KUBE_CONTEXT:-kind-wp05}" delete namespace "${OBS_NS:-obs-it}-kube-state-metrics" --wait=false >/dev/null 2>&1 || true
