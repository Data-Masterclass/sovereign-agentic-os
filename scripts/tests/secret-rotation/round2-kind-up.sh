#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# round2-kind-up.sh — the kind cluster for the round-2 rehearsal (rehearse-round2.sh).
#   DOCKER_CONTEXT=<a docker with ~7 GB free> bash scripts/tests/secret-rotation/round2-kind-up.sh
#   (CLUSTER=rotation2 by default; DOCKER_CONTEXT is only read from the environment — the shared
#   docker context is never switched)
# A kind cluster (kindnet: the rehearsal does not test NetworkPolicies), the chart's pinned images
# pulled by the node (only local builds and tag-only images are loaded), the chart installed with values.local.yaml + values.round2.kind.yaml: the
# chart's published default secrets, as production has them today.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
CLUSTER=${CLUSTER:-rotation2}; CHART=$REPO/charts/sovereign-agentic-os
. "$REPO/tests/e2e/kind/versions.env"
CTX=kind-$CLUSTER
# Its OWN kubeconfig: kind would otherwise add the cluster to ~/.kube/config and switch the shared
# current-context. rehearse-round2.sh reads the same file.
W=${REHEARSAL_WORKDIR:-$HOME/.cache/secret-rotation-round2}; mkdir -p "$W"; chmod 700 "$W"
export KUBECONFIG=$W/kubeconfig
kind get clusters 2>/dev/null | grep -qx "$CLUSTER" || kind create cluster --name "$CLUSTER" --image "$KIND_NODE_IMAGE" --kubeconfig "$KUBECONFIG" --wait 120s
kind export kubeconfig --name "$CLUSTER" --kubeconfig "$KUBECONFIG" >/dev/null; chmod 600 "$KUBECONFIG"
# RESET=1: start again from the chart defaults — the rehearsal namespace (data volumes included)
# is removed from THIS kind cluster first. Never points anywhere else: the context is kind-$CLUSTER.
if [ -n "${RESET:-}" ]; then
  [ "$(kubectl config current-context)" = "$CTX" ] || { echo "refusing RESET: current context is not $CTX"; exit 1; }
  kubectl --context "$CTX" delete namespace agentic-os --wait=true --timeout=10m >/dev/null 2>&1 || true
  if [ -d "$W/secrets/overlays" ]; then mv "$W/secrets/overlays" "$W/secrets/overlays.$(date +%s)"; fi
  if [ -f "$W/round1.values.yaml" ]; then mv "$W/round1.values.yaml" "$W/round1.values.$(date +%s).yaml"; fi
fi
# The round-1 secrets, as production has them since round 1: the install's own (random, this
# cluster only, mode 600), with a salt key. Round 2's credentials stay the chart defaults.
R1=$W/round1.values.yaml
if [ ! -f "$R1" ]; then
  ( umask 077; python3 - "$R1" <<'PY'
import secrets, sys, yaml
h = secrets.token_hex
v = {"litellmMasterKey": "sk-" + h(32), "litellmSaltKey": {"value": "sk-salt-" + h(32)},
     "litellmUI": {"password": h(16)}, "agentRuntime": {"token": h(32)},
     "langfuseInit": {"publicKey": "pk-lf-" + h(16), "secretKey": "sk-lf-" + h(32), "userPassword": h(16),
                      "salt": h(32), "nextauthSecret": h(32), "encryptionKey": h(32)}}
with open(sys.argv[1], "w") as f:
    f.write("# rehearsal only (kind): round-1 secrets, random per cluster. Never commit.\n"); yaml.safe_dump(v, f)
PY
  )
fi
helm dependency build "$CHART" >/dev/null 2>&1 || helm dependency update "$CHART" >/dev/null
R=$(mktemp); trap 'rm -f "$R"' EXIT
helm template agentic-os "$CHART" -n agentic-os --skip-schema-validation -f "$REPO/values.local.yaml" -f "$HERE/values.round2.kind.yaml" -f "$R1" > "$R" 2>/dev/null
# The OS's own images, built from this checkout (the e2e harness's list, tests/e2e/kind/up.sh).
docker build -q -t sovereign-os/mock-model:0.1.1 "$REPO/images/base/mock-model" >/dev/null
docker build -q -t sovereign-os/os-ui:0.1.0 -f "$REPO/images/base/os-ui/Dockerfile" "$REPO" >/dev/null
kind load docker-image sovereign-os/os-ui:0.1.0 --name "$CLUSTER" >/dev/null
# Only the locally built image is loaded. A digest reference must be pulled by the node itself:
# `kind load` of one leaves an `import-<date>@sha256` record that containerd's CRI then fails to
# resolve ("failed to check if this is a checkpoint image").
kind load docker-image sovereign-os/mock-model:0.1.1 --name "$CLUSTER" >/dev/null
# Tag-only references (Langfuse's) load fine when they are on the host already.
for img in $(sed -nE "s/^ *image: ['\"]?([^'\"@ ]+)['\"]?$/\1/p" "$R" | sort -u); do
  case $img in sovereign-os/*) continue ;; esac
  docker image inspect "$img" >/dev/null 2>&1 && kind load docker-image "$img" --name "$CLUSTER" >/dev/null 2>&1 || true
done
helm --kube-context "$CTX" upgrade --install agentic-os "$CHART" -n agentic-os --create-namespace --skip-schema-validation \
  -f "$REPO/values.local.yaml" -f "$HERE/values.round2.kind.yaml" -f "$R1" --wait --timeout 20m
kubectl --context "$CTX" -n agentic-os get pods
echo ROUND2_KIND_UP
