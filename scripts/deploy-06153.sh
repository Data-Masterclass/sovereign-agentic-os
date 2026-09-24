#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# One-shot guarded deploy of os-ui 0.6.153 — four-fix bundle on top of 0.6.152:
#  (1) AGENT-RUN SCOPING (security/UX): the run system prompt no longer dumps each granted tab's
#      full CONTEXT.md tool catalog + golden paths — a grant-scoped tool brief replaces it, so an
#      agent granted only {query_data} is never TOLD to call build_gold_join/run_quality_checks/
#      create_software/index_knowledge or ungranted data. Execution gates untouched (defense-in-depth).
#  (2) DATA: "Suggest quality rules" now returns structured, editable rule CARDS (was prose) +
#      AUTO-ADVANCE on upload — after Bronze, Silver→Gold→docs→DQ-rules build automatically
#      (best-effort, Bronze stays raw, all override-able).
#  (3) SOFTWARE: a "Reconnect git" heal action now shows for offline apps (repair after Forgejo
#      recovers); the app assistant falls back to the saved spec when the on-screen draft is invalid.
#  (4) carries 0.6.152 (agent-build reach-END fix + autonomous-agents gate) + query-tool 0.6.2 pin.
# Full tsc clean + 2357 tests green across data/agents/software/assistant.

# Registry: ghcr.io/aborek/sovereign-os/os-ui (private). Release: agentic-os / ns agentic-os.
set -euo pipefail
cd "$(dirname "$0")/.."
export KUBECONFIG="${KUBECONFIG:-deploy/kubeconfig.yaml}"
IMG=ghcr.io/aborek/sovereign-os/os-ui:0.6.153

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

echo "==> helm upgrade (pinned to 0.6.153@$DIGEST)"
# No release-wide --wait: pre-existing broken resources (mail, wireguard,
# sample-sklearn) would trip it. We verify os-ui specifically below.
helm -n agentic-os upgrade agentic-os charts/sovereign-agentic-os \
  --reuse-values --force-conflicts \
  --set osUI.image.tag="0.6.153@$DIGEST"

echo "==> force the pod to actually cycle (helm --reuse-values has left a stale pod before)"
kubectl -n agentic-os rollout restart deploy/os-ui

echo "==> os-ui rollout status (targeted)"
kubectl -n agentic-os rollout status deploy/os-ui --timeout=6m
echo "==> ACTUAL running image (config digest, not just the spec):"
kubectl -n agentic-os get pods -l app=os-ui -o jsonpath='{range .items[*]}{.metadata.name}{"  "}{.status.containerStatuses[0].imageID}{"  started="}{.status.startTime}{"\n"}{end}'
kubectl -n agentic-os get deploy os-ui -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
echo "DEPLOY_06153_OK"
