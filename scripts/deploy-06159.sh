#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# One-shot guarded deploy of os-ui 0.6.159 — MCP + documentation alignment for the 0.6.158 fixes
# (docs/guidance only, no behaviour change; tsc-clean + tests green):
#  MCP: generate_app_spec description now frames its failure issues[] as machine-actionable
#     {path,reason,fix} ("act on them + retry, never dead-end; bind an EXISTING granted dataset before
#     assuming a new one must be created"). software.guide.md Design/Choose-Context step says "reuse
#     before you create — list_datasets first + BIND an existing dataset; create new only if none fit".
#  DOCS: OS Guide (MD + regenerated PDF) — Build App documents the inline {path,reason,fix} blockers on
#     a failed auto-generate; Choose Context documents reuse-before-create; version stamp -> 0.6.158.
#  Carries all of 0.6.158.

set -euo pipefail
cd "$(dirname "$0")/.."
export KUBECONFIG="${KUBECONFIG:-deploy/kubeconfig.yaml}"
IMG=ghcr.io/aborek/sovereign-os/os-ui:0.6.159

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

echo "==> helm upgrade (pinned to 0.6.159@$DIGEST)"
# No release-wide --wait: pre-existing broken resources (mail, wireguard,
# sample-sklearn) would trip it. We verify os-ui specifically below.
helm -n agentic-os upgrade agentic-os charts/sovereign-agentic-os \
  --reuse-values --force-conflicts \
  --set osUI.image.tag="0.6.159@$DIGEST" \
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
echo "DEPLOY_06159_OK"
