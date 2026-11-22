#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
set -euo pipefail
H=${ACCESS_WORK:-${TMPDIR:-/tmp}/own-access-work}
KUBECONFIG="$H/kubeconfig" kind delete cluster --name "${ACCESS_KIND:-own-access}" --kubeconfig "$H/kubeconfig" >/dev/null 2>&1 || true
rm -rf "$H"
