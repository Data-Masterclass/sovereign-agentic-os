#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Install (or upgrade) the upstream External Secrets Operator as its own Helm release, BEFORE the
# platform chart renders any ExternalSecret. Pinned chart + image: components/external-secrets/UPSTREAM.md.
#
#   deploy/external-secrets/install.sh --context <kube context> [--dry-run]
#
# --context is required: this script never relies on the kubeconfig's current context.
# --dry-run renders against the API server (helm --dry-run=server) and changes nothing.
set -euo pipefail
CHART_VERSION=2.15.0
REPO_URL=https://charts.external-secrets.io
CTX="" DRY=""
while [ $# -gt 0 ]; do
  case $1 in
    --context) CTX=$2; shift ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$CTX" ] || { echo "install.sh: --context is required" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd)
args=(upgrade --install external-secrets external-secrets --repo "$REPO_URL" --version "$CHART_VERSION"
  --kube-context "$CTX" --namespace external-secrets --create-namespace -f "$HERE/values.yaml")
if [ -n "$DRY" ]; then
  helm "${args[@]}" --dry-run=server >/dev/null
  echo "external-secrets $CHART_VERSION: server dry run OK on context $CTX (nothing changed)"
else
  helm "${args[@]}" --wait --timeout 5m
  kubectl --context "$CTX" -n external-secrets wait --for=condition=Available deploy --all --timeout=180s
  echo "external-secrets $CHART_VERSION installed on context $CTX"
fi
