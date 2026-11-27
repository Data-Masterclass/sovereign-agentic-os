#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Install Tekton Pipelines and Triggers exactly as upstream documents it (`kubectl apply -f release.yaml`),
# from the pins in versions.env, each manifest verified by sha256. Nothing of ours is mixed into the
# upstream manifests; the two settings we change (`set-security-context`, so step pods fit Pod Security
# `restricted`; `coschedule: disabled`, so the App Builder's build pod can run on a dedicated build pool) are
# documented feature flags, applied as a ConfigMap patch.
#   KUBECONFIG=<file> bash scripts/tekton/install.sh        (or: --kubeconfig <file> / --context <ctx>)
# Idempotent. Never touches a kubeconfig's current-context: pass the context you mean.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$here/versions.env"
kc=(kubectl)
while [ $# -gt 0 ]; do
  case "$1" in
    --kubeconfig) kc+=(--kubeconfig "$2"); shift 2 ;;
    --context) kc+=(--context "$2"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
sha() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d' ' -f1; }
fetch() { # name url expected-sha
  curl -fsSL --retry 3 "$2" -o "$tmp/$1.yaml"
  got="$(sha "$tmp/$1.yaml")"
  [ "$got" = "$3" ] || { echo "tekton: $1 manifest sha256 $got != pinned $3 (refusing to apply)" >&2; exit 1; }
}
fetch pipelines "$TEKTON_PIPELINES_URL" "$TEKTON_PIPELINES_SHA256"
fetch triggers "$TEKTON_TRIGGERS_URL" "$TEKTON_TRIGGERS_SHA256"
fetch interceptors "$TEKTON_INTERCEPTORS_URL" "$TEKTON_INTERCEPTORS_SHA256"

echo "tekton: Pipelines $TEKTON_PIPELINES_VERSION"
"${kc[@]}" apply -f "$tmp/pipelines.yaml" >/dev/null
"${kc[@]}" -n tekton-pipelines rollout status deployment/tekton-pipelines-controller --timeout=300s
"${kc[@]}" -n tekton-pipelines rollout status deployment/tekton-pipelines-webhook --timeout=300s
"${kc[@]}" -n tekton-pipelines-resolvers rollout status deployment/tekton-pipelines-remote-resolvers --timeout=300s
# Pod Security `restricted` for step pods: https://tekton.dev/docs/pipelines/additional-configs/#customizing-the-pipelines-controller-behavior
"${kc[@]}" -n tekton-pipelines patch configmap feature-flags --type merge -p '{"data":{"set-security-context":"true"}}' >/dev/null
# Affinity Assistant OFF (`coschedule: disabled`): https://tekton.dev/docs/pipelines/affinityassistants/
# With the default (`workspaces`) every pod of a PipelineRun that shares the PVC workspace gets pod affinity to ONE
# node, the assistant's, and the assistant takes its nodeSelector/tolerations from the run's default podTemplate. The
# App Builder's build-image pod must run on the DEDICATED build pool (its own nodeSelector) while gates/push run on the
# platform nodes, so with the assistant on it could never be scheduled, and a cluster autoscaler would never add a
# build node for it. Off, the ReadWriteOnce workspace simply moves between nodes as the tasks run one after another
# (same zone required). On a single-node cluster this only drops the assistant pod per run.
"${kc[@]}" -n tekton-pipelines patch configmap feature-flags --type merge -p '{"data":{"coschedule":"disabled"}}' >/dev/null

echo "tekton: Triggers $TEKTON_TRIGGERS_VERSION"
"${kc[@]}" apply -f "$tmp/triggers.yaml" >/dev/null
"${kc[@]}" -n tekton-pipelines rollout status deployment/tekton-triggers-controller --timeout=300s
"${kc[@]}" -n tekton-pipelines rollout status deployment/tekton-triggers-webhook --timeout=300s
"${kc[@]}" apply -f "$tmp/interceptors.yaml" >/dev/null
"${kc[@]}" -n tekton-pipelines rollout status deployment/tekton-triggers-core-interceptors --timeout=300s
echo "tekton: ready"
