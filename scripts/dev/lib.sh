#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# lib.sh — shared by scripts/dev/*.sh. Source it; do not run it.
#
# Every dev script works on ONE cluster: the one in deploy/envs/dev's state. It is named by
# DEV_KUBE_CONTEXT (default dmagosdev) and reached with an explicit --context, never through the
# kubeconfig's current-context. The private files live in $DEV_PRIVATE_DIR (outside git, mode 700).
set -euo pipefail
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
DEV_TF_DIR=$REPO_ROOT/deploy/envs/dev
DEV_PRIVATE_DIR=${DEV_PRIVATE_DIR:-$HOME/.sovereign-os-secrets/dev}
CTX=${DEV_KUBE_CONTEXT:-dmagosdev}
PROD_CTX=${PROD_KUBE_CONTEXT:-dmagenticos}
NS=${NS:-agentic-os}
REL=${REL:-agentic-os}
TF=${TF:-$(command -v tofu || command -v terraform || true)}

die()  { echo "FATAL: $*" >&2; exit 1; }
say()  { printf '\n==> %s\n' "$*"; }
k()    { kubectl --context "$CTX" "$@"; }

private_dir() { (umask 077; mkdir -p "$DEV_PRIVATE_DIR"); chmod 700 "$DEV_PRIVATE_DIR"; }

# tf_out <name> — one output of the DEV state, raw. Never echoed by the callers for sensitive ones.
tf_out() {
  [ -n "$TF" ] || die "tofu (or terraform) not on PATH"
  "$TF" -chdir="$DEV_TF_DIR" output -raw "$1"
}

server_of() {
  local cluster
  cluster=$(kubectl config view -o jsonpath="{.contexts[?(@.name==\"$1\")].context.cluster}" 2>/dev/null || true)
  [ -n "$cluster" ] || return 0
  kubectl config view -o jsonpath="{.clusters[?(@.name==\"$cluster\")].cluster.server}" 2>/dev/null || true
}

# require_dev_cluster — the context is the cluster that deploy/envs/dev created, before the
# environment marker exists (bootstrap writes it). Three independent facts must agree:
#   the dev state says environment=dev; the context is not the production one; and the context's
#   API server is the server in the dev state's kubeconfig.
require_dev_cluster() {
  [ "$CTX" != "$PROD_CTX" ] || die "DEV_KUBE_CONTEXT is the production context ($PROD_CTX)"
  [ "$(tf_out environment 2>/dev/null)" = dev ] || die "deploy/envs/dev has no dev state (tofu output environment != dev)"
  local want here
  want=$(tf_out kubeconfig | python3 -c 'import sys, yaml; print(yaml.safe_load(sys.stdin)["clusters"][0]["cluster"]["server"])') \
    || die "cannot read the dev kubeconfig from the dev state"
  here=$(server_of "$CTX")
  [ -n "$here" ] || die "context $CTX is not in the kubeconfig (scripts/dev/kubeconfig.sh writes it)"
  [ "$here" = "$want" ] || die "context $CTX is not the cluster in the dev state (API server differs)"
  local prod; prod=$(server_of "$PROD_CTX")
  [ -z "$prod" ] || [ "$prod" != "$here" ] || die "context $CTX points at the production API server"
}

# require_marked_dev — the full guard (marker included), for everything after bootstrap.
require_marked_dev() {
  bash "$REPO_ROOT/scripts/lib/env-guard.sh" --env dev --context "$CTX" >/dev/null || \
    die "$(bash "$REPO_ROOT/scripts/lib/env-guard.sh" --env dev --context "$CTX" 2>/dev/null | tail -1)"
}
