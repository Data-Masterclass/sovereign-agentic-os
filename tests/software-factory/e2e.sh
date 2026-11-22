#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Software Factory end-to-end proof on a throwaway kind cluster (own kubeconfig, never ~/.kube/config):
# an app instantiated from templates/nextjs-web passes its gates in the sandbox Job, is built from its own
# Dockerfile, and is deployed to `agentic-apps` by the OS runner. Reuses tests/app-eject/up.sh.
#   FACTORY_E2E_KUBECONFIG=<own file> bash tests/software-factory/e2e.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
: "${FACTORY_E2E_KUBECONFIG:?set FACTORY_E2E_KUBECONFIG to a file of its own}"
export APP_EJECT_CLUSTER="${FACTORY_E2E_CLUSTER:-sf-e2e}"
export APP_EJECT_KUBECONFIG="$FACTORY_E2E_KUBECONFIG"
export APP_EJECT_REGISTRY_PORT="${FACTORY_E2E_REGISTRY_PORT:-5002}"
export FACTORY_E2E_REGISTRY_PORT="$APP_EJECT_REGISTRY_PORT"
cleanup() { bash "$here/../app-eject/down.sh" || true; }
trap cleanup EXIT
bash "$here/../app-eject/up.sh"
cd "$here/../../os-ui"
node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test --test-concurrency=1 --test-timeout=1500000 tabs/software/lib/golden-path.kind.test.ts
