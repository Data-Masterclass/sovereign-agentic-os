#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# Deletes only what up.sh created: the kind cluster and its registry container.
set -uo pipefail
: "${APP_EJECT_CLUSTER:=app-eject}"
: "${APP_EJECT_KUBECONFIG:?set APP_EJECT_KUBECONFIG}"
kind delete cluster --name "$APP_EJECT_CLUSTER" --kubeconfig "$APP_EJECT_KUBECONFIG"
docker rm -f "${APP_EJECT_CLUSTER}-registry" >/dev/null 2>&1 || true
