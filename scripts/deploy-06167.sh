#!/usr/bin/env bash
# One-shot guarded deploy of os-ui 0.6.167 — directory fails CLOSED when OpenSearch is late (chart 0.2.12).
# Fixes the 2026-09-10 all-users lockout: os-ui booting before OpenSearch re-seeded every account from
# OS_USERS with the original passwords into a frozen cache. Now: hydrate retries → 503 fail-closed (prod),
# offline seed is dev-opt-in and never frozen, plus a wait-for-opensearch initContainer on the pod.
# ALSO removes the plaintext OS_USERS roster from the pod env (the os-users mirror is the source of truth).
# Carries all of 0.6.166. See CHANGELOG.md.
set -euo pipefail
cd "$(dirname "$0")/.."
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
IMG=ghcr.io/aborek/sovereign-os/os-ui:0.6.167

echo "==> STANDING RULE: pre-upgrade backup (pg only — Velero not installed yet)"
deploy/pre-upgrade-backup.sh --pg-only

echo "==> building $IMG for linux/amd64 (nodes are amd64; Colima defaults to arm64)"
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

echo "==> helm upgrade (pinned to 0.6.167@$DIGEST; chart 0.2.12 adds the wait-for-opensearch initContainer)"
helm -n agentic-os upgrade agentic-os charts/sovereign-agentic-os \
  --reuse-values --force-conflicts \
  --set osUI.image.tag="0.6.167@$DIGEST" \
  --set osUI.waitForOpenSearch=true \
  --set osUI.allowOfflineUserSeed=false \
  --set osUI.usersSeed="" \
  --set queryTool.image.tag="0.6.2"   # MUST be an explicit --set every deploy: `--reuse-values`
                                       # ignores the chart values.yaml pin and reverts query-tool to
                                       # the last release's 0.6.1, dropping the promote-as-view
                                       # CREATE VIEW allowlist. Keep this line in future deploy scripts.
# NOTE osUI.usersSeed="" is deliberate: the plaintext roster leaves the pod env for good. The
# os-users OpenSearch index holds every account (incl. runtime-created ones); an operator copy of
# the old seed lives outside the repo (see deploy/README.md → secrets not in git).

echo "==> force the pod to actually cycle (helm --reuse-values has left a stale pod before)"
kubectl -n agentic-os rollout restart deploy/os-ui

echo "==> os-ui rollout status (targeted)"
kubectl -n agentic-os rollout status deploy/os-ui --timeout=8m
echo "==> ACTUAL running image + initContainer + env sanity:"
kubectl -n agentic-os get pods -l app=os-ui -o jsonpath='{range .items[*]}{.metadata.name}{"  "}{.status.containerStatuses[0].imageID}{"  started="}{.status.startTime}{"\n"}{end}'
kubectl -n agentic-os get deploy os-ui -o jsonpath='{.spec.template.spec.initContainers[*].name}'; echo "  <- initContainers"
kubectl -n agentic-os get deploy os-ui -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}{"\n"}{end}' | grep -c '^OS_USERS$' | sed 's/^/OS_USERS env entries (want 0): /' || true
echo "DEPLOY_06167_OK"
