#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# env-guard.sh — refuse a deploy whose kube context does not belong to its environment.
# =============================================================================
#   bash scripts/lib/env-guard.sh --env dev|prod --context <kube context>
#   bash scripts/lib/env-guard.sh --env dev|prod --print-default-context
#
# THE ONE PLACE that maps an environment to a cluster. scripts/deploy.sh, scripts/release.sh,
# scripts/smoke-test.sh (through them), scripts/rollback.sh and scripts/dev/*.sh call it before
# they touch a cluster. Every kubectl/helm call after it passes `--context` explicitly; nothing
# here or there reads or changes the kubeconfig's current-context.
#
# Rules (any failure: exit 1, last line `ENV_GUARD_REFUSED: <reason>`):
#   1. --env is dev or prod; --context is not empty.
#   2. dev:  the context is not the production context name (PROD_KUBE_CONTEXT, dmagenticos),
#            its API server is not the production context's API server (when that context is in
#            the kubeconfig), and the cluster CARRIES the marker ConfigMap
#            kube-public/sovereign-os-environment with data.environment=dev (written by
#            scripts/dev/bootstrap-secrets.sh). A cluster without the marker is not dev.
#   3. prod: the context is not the dev context name (DEV_KUBE_CONTEXT, dmagosdev), its API
#            server is not the dev context's API server (when that context is known), and the
#            marker, IF the cluster has one, says prod. (Production has no marker yet; adding one
#            is documented in docs/ops/dev-environment.md and makes rule 3 stricter, not looser.)
# Success: exit 0, last line `ENV_GUARD_OK env=<env> context=<ctx>`.
#
# Reads only: `kubectl config view` (names and server URLs, never credentials) and one
# ConfigMap. Prints no secret.
set -euo pipefail

PROD_CTX=${PROD_KUBE_CONTEXT:-dmagenticos}
DEV_CTX=${DEV_KUBE_CONTEXT:-dmagosdev}
MARKER_NS=kube-public
MARKER_NAME=sovereign-os-environment
ENV_NAME='' CTX='' PRINT_DEFAULT=''

refuse() { echo "ENV_GUARD_REFUSED: $*" >&2; echo "ENV_GUARD_REFUSED: $*"; exit 1; }
while [ $# -gt 0 ]; do
  case $1 in
    --env)                   ENV_NAME=${2:-}; shift ;;
    --context)               CTX=${2:-}; shift ;;
    --print-default-context) PRINT_DEFAULT=1 ;;
    *) echo "env-guard.sh: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

case $ENV_NAME in
  dev|prod) ;;
  *) refuse "--env must be dev or prod (got '${ENV_NAME}')" ;;
esac
if [ -n "$PRINT_DEFAULT" ]; then
  if [ "$ENV_NAME" = dev ]; then echo "$DEV_CTX"; else echo "$PROD_CTX"; fi
  exit 0
fi
[ -n "$CTX" ] || refuse "no kube context given for env $ENV_NAME (the shared current-context is never used)"

# A DEV_KUBE_CONTEXT set to the production name is caught by the name rules below; the default
# names themselves must differ.
[ "${PROD_KUBE_CONTEXT:-dmagenticos}" != "${DEV_KUBE_CONTEXT:-dmagosdev}" ] || [ "$ENV_NAME" = dev ] \
  || refuse "PROD_KUBE_CONTEXT and DEV_KUBE_CONTEXT are both '$PROD_CTX'"

# server_of <context> — the API server URL of a kubeconfig context, empty when unknown.
server_of() {
  local cluster
  cluster=$(kubectl config view -o jsonpath="{.contexts[?(@.name==\"$1\")].context.cluster}" 2>/dev/null || true)
  [ -n "$cluster" ] || return 0
  kubectl config view -o jsonpath="{.clusters[?(@.name==\"$cluster\")].cluster.server}" 2>/dev/null || true
}

marker_of() {
  kubectl --context "$1" -n "$MARKER_NS" get configmap "$MARKER_NAME" \
    -o jsonpath='{.data.environment}' 2>/dev/null || true
}

here=$(server_of "$CTX")
if [ "$ENV_NAME" = dev ]; then
  [ "$CTX" != "$PROD_CTX" ] || refuse "env dev with the production context '$CTX' — dev can never deploy to production"
  prod_server=$(server_of "$PROD_CTX")
  if [ -n "$here" ] && [ -n "$prod_server" ] && [ "$here" = "$prod_server" ]; then
    refuse "env dev: context '$CTX' points at the production API server"
  fi
  marker=$(marker_of "$CTX")
  [ "$marker" = dev ] || refuse "env dev: cluster of context '$CTX' has no ${MARKER_NS}/${MARKER_NAME} environment=dev marker (found '${marker:-none}'); run scripts/dev/bootstrap-secrets.sh on the dev cluster first"
else
  [ "$CTX" != "$DEV_CTX" ] || refuse "env prod with the dev context '$CTX'"
  dev_server=$(server_of "$DEV_CTX")
  if [ -n "$here" ] && [ -n "$dev_server" ] && [ "$here" = "$dev_server" ]; then
    refuse "env prod: context '$CTX' points at the dev API server"
  fi
  marker=$(marker_of "$CTX")
  case $marker in
    ''|prod) ;;
    *) refuse "env prod: cluster of context '$CTX' is marked environment=$marker" ;;
  esac
fi
echo "ENV_GUARD_OK env=$ENV_NAME context=$CTX"
