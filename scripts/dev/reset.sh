#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# reset.sh — wipe the dev environment's workloads and data, then reseed it.
# =============================================================================
#   scripts/dev/reset.sh --yes-wipe-dev [<image tag, default: main-<origin/main sha>>]
#
#   1. guard: the dev cluster, marked dev (never production);
#   2. helm uninstall + delete the namespaces agentic-os and agentic-apps (every PVC with them);
#      the cluster, the platform add-ons, the marker and the dev bucket stay;
#   3. new random secrets (bootstrap-secrets.sh --rotate: the old databases are gone);
#   4. deploy the image again (scripts/deploy.sh --env dev), then scripts/dev/seed.sh.
# Takes about 30 minutes. Dev holds synthetic data only, so nothing is backed up first.
. "$(dirname "$0")/lib.sh"
[ "${1:-}" = --yes-wipe-dev ] || die "this deletes every workload and all data on dev; pass --yes-wipe-dev"
TAG=${2:-main-$(git -C "$REPO_ROOT" rev-parse origin/main)}
require_marked_dev

say "wiping $REL and the namespaces $NS, agentic-apps on $CTX"
helm --kube-context "$CTX" uninstall "$REL" -n "$NS" --wait --timeout 15m || true
k delete ns "$NS" agentic-apps --ignore-not-found --wait --timeout=15m

say "new secrets"
"$REPO_ROOT/scripts/dev/bootstrap-secrets.sh" --rotate

say "deploy $TAG"
DEV_KUBE_CONTEXT=$CTX "$REPO_ROOT/scripts/deploy.sh" --env dev --from-registry "$TAG"

say "reseed"
"$REPO_ROOT/scripts/dev/seed.sh"
echo "RESET_OK context=$CTX tag=$TAG"
