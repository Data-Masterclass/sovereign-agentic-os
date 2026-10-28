#!/usr/bin/env bash
# Deploy os-ui 0.6.171 (Governance rename + Manage group) AND switch off the
# unused components in ONE helm upgrade (one os-ui roll, not two).
#
# Switched off: haystack, sample-agent, wireguard, mail, terminal-broker,
# workbench-broker, openmetadata, cube, forgejo, ci-runner, argo-cd,
# softwareDelivery. Kept: dagster, docling. PVCs of removed components carry
# helm.sh/resource-policy=keep (annotated before this run).
set -euo pipefail
cd "$(dirname "$0")/.."
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
IMG=ghcr.io/aborek/sovereign-os/os-ui:0.6.171
BACKUP="${PRE_UPGRADE_BACKUP:-pre-upgrade-20261028-221210}"

echo "==> STANDING RULE: gate on the pre-upgrade Velero backup ($BACKUP) + pg dump"
for i in $(seq 1 60); do
  phase=$(kubectl -n velero get backups.velero.io "$BACKUP" -o jsonpath='{.status.phase}' 2>/dev/null || true)
  case "$phase" in
    Completed) echo "   velero backup $BACKUP: Completed"; break ;;
    Failed|PartiallyFailed|FailedValidation) echo "BACKUP_GATE_FAILED: $phase"; exit 1 ;;
    *) echo "   velero backup phase=${phase:-pending} (${i}/60)"; sleep 20 ;;
  esac
  [ "$i" = 60 ] && { echo "BACKUP_GATE_TIMEOUT"; exit 1; }
done

echo "==> building $IMG for linux/amd64"
docker build --platform linux/amd64 --provenance=false -t "$IMG" -f images/base/os-ui/Dockerfile .
echo "==> pushing $IMG (up to 5 tries)"
pushed=""
for i in 1 2 3 4 5; do
  if docker push "$IMG"; then pushed=1; break; fi
  echo "   push attempt $i failed; retry in 10s…"; sleep 10
done
[ -n "$pushed" ] || { echo "PUSH_FAILED after 5 attempts"; exit 1; }
DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "$IMG" | sed -E 's/.*@(sha256:.*)/\1/')
if [ -z "$DIGEST" ] || [ "$DIGEST" = "sha256:" ]; then
  echo "DIGEST_EMPTY_ABORT"; exit 1
fi
echo "==> digest: $DIGEST"

TABS='home\,agents\,dashboards\,software\,data\,metrics\,files\,knowledge\,connections\,monitoring\,governance\,admin\,workflows'
echo "==> helm upgrade (image + 13 tabs + standing flags + component switch-off)"
helm -n agentic-os upgrade agentic-os charts/sovereign-agentic-os \
  --reuse-values --force-conflicts --timeout 15m \
  --set osUI.image.tag="0.6.171@$DIGEST" \
  --set-string "osUI.enabledTabs=$TABS" \
  --set osUI.waitForOpenSearch=true \
  --set osUI.allowOfflineUserSeed=false \
  --set osUI.usersSeed="" \
  --set osUI.openmetadataConnectEnabled=false \
  --set queryTool.image.tag="0.6.2" \
  --set mcpTestAgent.enabled=false \
  --set haystack.enabled=false \
  --set sampleAgent.enabled=false \
  --set wireguard.enabled=false \
  --set mail.enabled=false \
  --set terminal.enabled=false \
  --set workbench.enabled=false \
  --set openmetadata.enabled=false \
  --set cube.enabled=false \
  --set forgejo.enabled=false \
  --set ciRunner.enabled=false \
  --set argo-cd.enabled=false \
  --set softwareDelivery.enabled=false
# NO rollout restart: the image + env change already rolls os-ui once.

echo "==> os-ui rollout status"
kubectl -n agentic-os rollout status deploy/os-ui --timeout=10m
echo "==> running image:"
kubectl -n agentic-os get pods -l app=os-ui -o jsonpath='{range .items[*]}{.metadata.name}{"  "}{.status.containerStatuses[0].imageID}{"\n"}{end}'
echo "==> env sanity (OS_ENABLED_TABS / FORGEJO_ENABLED / OPENMETADATA_CONNECT_ENABLED):"
kubectl -n agentic-os get deploy os-ui -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}={.value}{"\n"}{end}' | grep -E '^(OS_ENABLED_TABS|FORGEJO_ENABLED|OPENMETADATA_CONNECT_ENABLED)='
echo "==> remaining workloads:"
kubectl -n agentic-os get deploy,sts --no-headers | awk '{print $1}' | tr '\n' ' '; echo
echo "==> PVCs (all must still exist):"
kubectl -n agentic-os get pvc --no-headers | awk '{print $1}' | tr '\n' ' '; echo
echo "DEPLOY_06171_OK"
