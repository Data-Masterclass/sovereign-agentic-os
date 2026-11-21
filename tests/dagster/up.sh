#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# WP-15 harness: everything run-identity.int.test.ts needs, all real:
#   1. a kind cluster (its OWN kubeconfig, never ~/.kube/config) whose API server answers the
#      TokenReviews: ServiceAccounts dagster-run, dagster-code, os-ui (+ system:auth-delegator) and
#      their tokens (audience os-ui for the Dagster ones);
#   2. the WP-14 lakehouse (Trino 476, TLS + PASSWORD, the chart's OPA sidecar) whose sidecar also
#      downloads the long-polled os-grants bundle from os-ui's route handlers on the host and
#      reports its revision to os-ui's status route (10 F3);
#   3. the Dagster image built from this checkout (unless WP15_DAGSTER_IMAGE names one).
#
#   bash tests/dagster/up.sh && (cd os-ui && node … --test ../tests/dagster/run-identity.int.test.ts)
#   bash tests/dagster/down.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
export LH_PROJECT=${LH_PROJECT:-soa-wp15}
export LH_TRINO_PORT=${LH_TRINO_PORT:-28080} LH_TRINO_TLS_PORT=${LH_TRINO_TLS_PORT:-28443} LH_OPA_PORT=${LH_OPA_PORT:-28181} LH_RUNNER_PORT=${LH_RUNNER_PORT:-28000}
SERVER_PORT=${WP15_SERVER_PORT:-28290}
KIND_NAME=${WP15_KIND:-wp15}
IMAGE=${WP15_DAGSTER_IMAGE:-sovereign-os/dagster:wp15}
rand() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }

TOKEN="wp15-$(rand 16)"
BUNDLES=$(cat <<JSON
{"services":{"osui":{"url":"http://host.docker.internal:${SERVER_PORT}/api/opa","credentials":{"bearer":{"token":"${TOKEN}"}}}},
 "bundles":{"os-grants":{"service":"osui","resource":"bundles/os-grants.tar.gz","polling":{"min_delay_seconds":1,"max_delay_seconds":2,"long_polling_timeout_seconds":10}}},
 "status":{"service":"osui"}}
JSON
)
bash tests/lakehouse/up.sh --set-json "trino.opa.sidecar.bundles=$(echo "$BUNDLES" | tr -d '\n')"
WORK=$(cat "${TMPDIR:-/tmp}/${LH_PROJECT}.work")
H="$WORK/wp15"; mkdir -p "$H/k8s-sa" "$H/tokens"

# 1. kind: its own kubeconfig, in the work dir.
export KUBECONFIG="$H/kubeconfig"
kind get clusters 2>/dev/null | grep -qx "$KIND_NAME" || kind create cluster --name "$KIND_NAME" --kubeconfig "$KUBECONFIG" --wait 120s >/dev/null
kubectl --kubeconfig "$KUBECONFIG" create namespace agentic-os --dry-run=client -o yaml | kubectl --kubeconfig "$KUBECONFIG" apply -f - >/dev/null
for sa in dagster-run dagster-code os-ui; do
  kubectl --kubeconfig "$KUBECONFIG" -n agentic-os create serviceaccount "$sa" --dry-run=client -o yaml | kubectl --kubeconfig "$KUBECONFIG" apply -f - >/dev/null
done
# The chart's binding (templates/extensions/dagster/run-identity.yaml), rendered and applied as is.
helm template agentic-os charts/sovereign-agentic-os -n agentic-os -f values.dagster-run-identity.yaml \
  --set postgres.governance.adminSecretName=wp15-it --show-only templates/extensions/dagster/run-identity.yaml \
  | kubectl --kubeconfig "$KUBECONFIG" apply -f - >/dev/null
( umask 077
  kubectl --kubeconfig "$KUBECONFIG" -n agentic-os create token os-ui --duration 2h > "$H/k8s-sa/token"
  kubectl --kubeconfig "$KUBECONFIG" -n agentic-os create token dagster-run --audience os-ui --duration 2h > "$H/tokens/run"
  kubectl --kubeconfig "$KUBECONFIG" -n agentic-os create token dagster-code --audience os-ui --duration 2h > "$H/tokens/code"
  kubectl --kubeconfig "$KUBECONFIG" config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d > "$H/k8s-sa/ca.crt"
  kubectl --kubeconfig "$KUBECONFIG" config view --raw --minify -o jsonpath='{.clusters[0].cluster.server}' > "$H/k8s-api"
  printf '%s' "$TOKEN" > "$H/bundle-token"
)

# 3. The Dagster image under test.
if [ -z "${WP15_DAGSTER_IMAGE:-}" ]; then
  docker build -q -f images/extensions/dagster/Dockerfile -t "$IMAGE" images/extensions >/dev/null
fi
printf '%s\n' "$IMAGE" > "$H/image"
printf '%s\n' "$SERVER_PORT" > "$H/server-port"
echo "up.sh (wp15): lakehouse $LH_PROJECT, kind $KIND_NAME, image $IMAGE, work $H"
