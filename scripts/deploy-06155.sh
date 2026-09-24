#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# One-shot guarded deploy of os-ui 0.6.155 — AGENTS builder iteration on 0.6.154 (from live testing):
#   • SIX stages now: Define · Grant · Design · Build · Run · Evaluate (Build & Run split back apart).
#   • The trigger (Manual / On schedule / Called from system) moved to DEFINE ("how the team runs"
#     is defined up front), not the run stage.
#   • The per-stage AI assistant moved to the TOP of every stage and auto-suggests on stage entry
#     (proactive, ref-guarded, dismissible) — Define/Grant/Design/Evaluate propose; Build/Run explain.
#   • NEW View vs Edit: a ready+tested system (built && run once) opens in a read-only VIEW
#     (trigger/run · live monitor · results + diagnostics, reusing the Run + Evaluate panels); the
#     six-stage builder is EDIT (✎). Matches the OS-wide Context-tab View/Edit convention.
#  Backward-compatible: saved systems load with no yaml migration; legacy {instruction} scaffold,
#  /schedule, Developer mode + the Software assistant mounts all unchanged. Carries all of 0.6.154.
# Full tsc clean + entire suite 5477 tests green.

# Registry: ghcr.io/aborek/sovereign-os/os-ui (private). Release: agentic-os / ns agentic-os.
set -euo pipefail
cd "$(dirname "$0")/.."
export KUBECONFIG="${KUBECONFIG:-deploy/kubeconfig.yaml}"
IMG=ghcr.io/aborek/sovereign-os/os-ui:0.6.155

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

echo "==> helm upgrade (pinned to 0.6.155@$DIGEST)"
# No release-wide --wait: pre-existing broken resources (mail, wireguard,
# sample-sklearn) would trip it. We verify os-ui specifically below.
helm -n agentic-os upgrade agentic-os charts/sovereign-agentic-os \
  --reuse-values --force-conflicts \
  --set osUI.image.tag="0.6.155@$DIGEST"

echo "==> force the pod to actually cycle (helm --reuse-values has left a stale pod before)"
kubectl -n agentic-os rollout restart deploy/os-ui

echo "==> os-ui rollout status (targeted)"
kubectl -n agentic-os rollout status deploy/os-ui --timeout=6m
echo "==> ACTUAL running image (config digest, not just the spec):"
kubectl -n agentic-os get pods -l app=os-ui -o jsonpath='{range .items[*]}{.metadata.name}{"  "}{.status.containerStatuses[0].imageID}{"  started="}{.status.startTime}{"\n"}{end}'
kubectl -n agentic-os get deploy os-ui -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
echo "DEPLOY_06155_OK"
