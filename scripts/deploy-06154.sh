#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# One-shot guarded deploy of os-ui 0.6.154 — AGENTS-TAB BUILDER REDESIGN (on top of 0.6.153):
#  New five-stage flow Define · Grant · Design · Build&Run · Evaluate —
#   • Define = the outcome only (name + deliverable + "where the results go").
#   • Grant = "what your team can use", rebuilt on a shared ChooseContextShell primitive so it
#     matches the Software tab's Choose-Context UX (Software refactored onto the SAME primitive,
#     zero behavior change); agents keep late-binding folder grants + access caps + medallion toggle.
#   • Design = team canvas + AUTO-SUGGESTED TEAM proposed on entry from the deliverable + grants
#     (grounded ONLY in granted context; user confirms via the one governed commit path).
#   • Build & Run merged into one stage (trigger relocated next to Run).
#   • A per-stage AI assistant is mounted in every stage (chat + apply-suggestion cards).
#  Backward-compatible: saved systems load with no yaml migration; legacy {instruction} scaffold,
#  /schedule, Developer mode + the Software assistant mounts all unchanged. Carries all of 0.6.153.
# Full tsc clean + entire suite 5477 tests green.

# Registry: ghcr.io/aborek/sovereign-os/os-ui (private). Release: agentic-os / ns agentic-os.
set -euo pipefail
cd "$(dirname "$0")/.."
export KUBECONFIG="${KUBECONFIG:-deploy/kubeconfig.yaml}"
IMG=ghcr.io/aborek/sovereign-os/os-ui:0.6.154

echo "==> building $IMG for linux/amd64 (nodes are amd64; Colima defaults to arm64)"
# --platform pins the node arch; --provenance=false avoids a buildx attestation
# manifest list that containerd can't resolve ("no match for platform").
docker build --platform linux/amd64 --provenance=false -t "$IMG" -f images/os-ui/Dockerfile .

echo "==> pushing $IMG (classic, up to 5 tries — ghcr resets mid-upload intermittently)"
pushed=""
for i in 1 2 3 4 5; do
  if docker push "$IMG"; then pushed=1; break; fi
  echo "   push attempt $i failed (network reset); resuming in 10s…"; sleep 10
done
[ -n "$pushed" ] || { echo "PUSH_FAILED after 5 attempts"; exit 1; }

DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "$IMG" | sed -E 's/.*@(sha256:.*)/\1/')
if [ -z "$DIGEST" ] || [ "$DIGEST" = "sha256:" ]; then
  echo "DIGEST_EMPTY_ABORT — refusing to helm-upgrade with an empty digest"; exit 1
fi
echo "==> digest: $DIGEST"

echo "==> helm upgrade (pinned to 0.6.154@$DIGEST)"
# No release-wide --wait: pre-existing broken resources (mail, wireguard,
# sample-sklearn) would trip it. We verify os-ui specifically below.
helm -n agentic-os upgrade agentic-os charts/sovereign-agentic-os \
  --reuse-values --force-conflicts \
  --set osUI.image.tag="0.6.154@$DIGEST"

echo "==> force the pod to actually cycle (helm --reuse-values has left a stale pod before)"
kubectl -n agentic-os rollout restart deploy/os-ui

echo "==> os-ui rollout status (targeted)"
kubectl -n agentic-os rollout status deploy/os-ui --timeout=6m
echo "==> ACTUAL running image (config digest, not just the spec):"
kubectl -n agentic-os get pods -l app=os-ui -o jsonpath='{range .items[*]}{.metadata.name}{"  "}{.status.containerStatuses[0].imageID}{"  started="}{.status.startTime}{"\n"}{end}'
kubectl -n agentic-os get deploy os-ui -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
echo "DEPLOY_06154_OK"
