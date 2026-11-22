#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# Delete the Software Factory CI harness cluster (own kubeconfig only).
set -euo pipefail
: "${SF_KUBECONFIG:?set SF_KUBECONFIG}"
kind delete cluster --name "${SF_CLUSTER:-sf-tekton}" --kubeconfig "$SF_KUBECONFIG" || true
