#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Software Factory CI end-to-end proof (replaces the sandbox-Job proof): on a throwaway kind cluster with Calico
# (an enforcing CNI), a REAL `git push` to the OS git server runs the app's own Tekton pipeline on that exact
# commit; a failing test blocks, a superseded run is cancelled, a deploy without a green record is refused, the
# NetworkPolicies hold and another domain's app is untouched. Own kubeconfig, never ~/.kube/config.
#   SF_KUBECONFIG=<own file> bash tests/software-factory/e2e.sh
# KEEP=1 leaves the cluster up (for debugging); tests/software-factory/tekton-down.sh deletes it.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
: "${SF_KUBECONFIG:?set SF_KUBECONFIG to a file of its own}"
export SF_KUBECONFIG
# The repositories directory is mounted into the kind node, so it must live where the container runtime can mount it
# (under $HOME on macOS with colima / Docker Desktop; anywhere on Linux).
export SF_REPOS_DIR="${SF_REPOS_DIR:-$(mktemp -d "${SF_REPOS_PARENT:-$HOME}/.sf-tekton-repos.XXXXXX")}"
cleanup() {
  if [ "${KEEP:-}" != "1" ]; then
    bash "$here/tekton-down.sh" || true
    # Only the scratch directory this run created (or was given), never anything else.
    [ -d "$SF_REPOS_DIR" ] && find "$SF_REPOS_DIR" -mindepth 1 -delete 2>/dev/null && rmdir "$SF_REPOS_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT
bash "$here/tekton-up.sh"
cd "$here/../../os-ui"
node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test --test-concurrency=1 --test-timeout=2400000 tabs/software/lib/tekton-checks.kind.test.ts
