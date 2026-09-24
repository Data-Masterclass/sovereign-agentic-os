#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# One-shot guarded deploy of os-ui 0.6.162 — Software apps no longer disappear (cache null-poison fix):
#  The app registry bulk-hydrate did `(await mirror.hydrate(500)) ?? []` — collapsing null (OpenSearch
#  UNREACHABLE) and [] (reachable-but-empty) into one empty list and CACHING it as authoritative, so a
#  transient mirror blip at the first list-after-boot poisoned the app tiles empty for the WHOLE pod
#  lifetime (every app vanished until the next restart). Fix (lib/software/apps.ts getCache): a `hydrated`
#  flag keeps the in-process cache on an outage but re-hydrates from the mirror once it recovers, folding
#  persisted docs back in. writeThrough was already durable (queues + replays). Carries all of 0.6.161.

set -euo pipefail
cd "$(dirname "$0")/.."
export KUBECONFIG="${KUBECONFIG:-deploy/kubeconfig.yaml}"
IMG=ghcr.io/aborek/sovereign-os/os-ui:0.6.162

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

echo "==> helm upgrade (pinned to 0.6.162@$DIGEST)"
# No release-wide --wait: pre-existing broken resources (mail, wireguard,
# sample-sklearn) would trip it. We verify os-ui specifically below.
helm -n agentic-os upgrade agentic-os charts/sovereign-agentic-os \
  --reuse-values --force-conflicts \
  --set osUI.image.tag="0.6.162@$DIGEST" \
  --set queryTool.image.tag="0.6.2"   # MUST be an explicit --set every deploy: `--reuse-values`
                                       # ignores the chart values.yaml pin and reverts query-tool to
                                       # the last release's 0.6.1, dropping the promote-as-view
                                       # CREATE VIEW allowlist. Keep this line in future deploy scripts.

echo "==> force the pod to actually cycle (helm --reuse-values has left a stale pod before)"
kubectl -n agentic-os rollout restart deploy/os-ui

echo "==> os-ui rollout status (targeted)"
kubectl -n agentic-os rollout status deploy/os-ui --timeout=6m
echo "==> ACTUAL running image (config digest, not just the spec):"
kubectl -n agentic-os get pods -l app=os-ui -o jsonpath='{range .items[*]}{.metadata.name}{"  "}{.status.containerStatuses[0].imageID}{"  started="}{.status.startTime}{"\n"}{end}'
kubectl -n agentic-os get deploy os-ui -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
echo "DEPLOY_06162_OK"
