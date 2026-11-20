#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# down.sh — delete the harness's kind cluster (default wp02). Never touches any other context.
set -euo pipefail
CLUSTER=${E2E_CLUSTER:-wp02}
kind delete cluster --name "$CLUSTER"
