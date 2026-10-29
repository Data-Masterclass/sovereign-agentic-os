#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# deploy.sh <version> — build, push and roll out os-ui to a real cluster.
#
#   ./scripts/deploy.sh 0.7.0
#
# Order is deliberate: back up FIRST (the script aborts if the backup gate fails),
# then build for the cluster's architecture, then one helm upgrade.
#
# Values: the release's OWN values are the source of truth for a running cluster —
# the chart's values.yaml is the laptop profile, so never deploy a cloud cluster
# from the defaults. This script derives the values file from the live release and
# drops only the keys the chart no longer defines.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=${1:?usage: deploy.sh <version>}
CTX=${KUBE_CONTEXT:-dmagenticos}
NS=${NS:-agentic-os}
REL=${REL:-agentic-os}
CHART=charts/sovereign-agentic-os
IMG=ghcr.io/aborek/sovereign-os/os-ui:$VERSION
WORK=${WORK:-$(mktemp -d)}
VALUES=${VALUES:-$WORK/release-values.yaml}

say() { printf '\n==> %s\n' "$*"; }

say "context $CTX / namespace $NS"
kubectl --context "$CTX" -n "$NS" get deploy os-ui >/dev/null

say "deriving the values file from the live release"
# Keys the chart no longer defines (removed components) are dropped; everything
# the operator set — ingress hosts, public URL, API keys, enabled tabs — is kept.
helm --kube-context "$CTX" get values "$REL" -n "$NS" -o yaml > "$WORK/live.yaml"
python3 - "$WORK/live.yaml" "$CHART/values.yaml" "$VALUES" <<'PY'
import sys, yaml
live = yaml.safe_load(open(sys.argv[1])) or {}
new = yaml.safe_load(open(sys.argv[2]))
kept = {k: v for k, v in live.items() if k in new}
if 'osUI' in kept and isinstance(kept['osUI'], dict):
    kept['osUI'] = {k: v for k, v in kept['osUI'].items() if k in new['osUI']}
yaml.safe_dump(kept, open(sys.argv[3], 'w'), sort_keys=False)
dropped = sorted(set(live) - set(kept))
print(f"   kept {len(kept)} top-level keys; dropped {len(dropped)} for removed components")
if dropped: print("   dropped:", ', '.join(dropped))
PY

say "what the upgrade changes"
helm --kube-context "$CTX" get manifest "$REL" -n "$NS" > "$WORK/before.yaml"
helm template "$REL" "$CHART" -n "$NS" -f "$VALUES" > "$WORK/after.yaml"
python3 - "$WORK/before.yaml" "$WORK/after.yaml" <<'PY'
import sys, yaml
def objs(p):
    return {(d['kind'], d['metadata']['name'])
            for d in yaml.safe_load_all(open(p))
            if isinstance(d, dict) and d.get('kind') and (d.get('metadata') or {}).get('name')}
a, b = objs(sys.argv[1]), objs(sys.argv[2])
rm = sorted(a - b)
risky = [x for x in rm if x[0] in ('PersistentVolumeClaim', 'StatefulSet')]
for k, n in rm: print(f"   delete {k:26s} {n}")
if risky:
    print("\n   REFUSING: the upgrade would delete stateful objects:", risky)
    print("   annotate them helm.sh/resource-policy=keep first, or fix the values.")
    sys.exit(1)
print(f"   {len(rm)} deletions, no stateful object among them")
PY

say "pre-upgrade backup (standing rule — aborts the deploy if it fails)"
# pre-upgrade-backup.sh uses the AMBIENT kubectl context, so make it explicit —
# running it against the wrong cluster is how you get a deploy with no backup.
kubectl config use-context "$CTX" >/dev/null
KUBECONFIG=${KUBECONFIG:-$HOME/.kube/config} deploy/pre-upgrade-backup.sh

# SKIP_BUILD=1 reuses an already-built local image — useful when a run died after
# the build (emulated amd64 builds take 10-15 min on an arm64 Mac).
if [ "${SKIP_BUILD:-}" = "1" ] && docker image inspect "$IMG" >/dev/null 2>&1; then
  say "reusing the local $IMG (SKIP_BUILD=1)"
else
  say "building $IMG for linux/amd64 (cluster nodes are amd64)"
  docker build --platform linux/amd64 --provenance=false -t "$IMG" -f images/base/os-ui/Dockerfile .
fi

say "pushing $IMG"
pushed=""
for i in 1 2 3 4 5; do
  if docker push "$IMG"; then pushed=1; break; fi
  echo "   attempt $i failed; retrying in 10s…"; sleep 10
done
[ -n "$pushed" ] || { echo "PUSH_FAILED"; exit 1; }
DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "$IMG" | sed -E 's/.*@(sha256:.*)/\1/')
[ -n "$DIGEST" ] || { echo "DIGEST_EMPTY — refusing to deploy an unpinned image"; exit 1; }
say "digest $DIGEST"

say "helm upgrade"
helm --kube-context "$CTX" upgrade "$REL" "$CHART" -n "$NS" -f "$VALUES" \
  --set osUI.image.tag="$VERSION@$DIGEST" --force-conflicts --timeout 20m
# No rollout restart: the image change already rolls os-ui exactly once.

say "rollout"
kubectl --context "$CTX" -n "$NS" rollout status deploy/os-ui --timeout=15m

say "verify"
kubectl --context "$CTX" -n "$NS" get pods -l app.kubernetes.io/name=os-ui \
  -o jsonpath='{range .items[*]}   {.metadata.name}  {.status.containerStatuses[0].imageID}{"\n"}{end}'
kubectl --context "$CTX" -n "$NS" get deploy os-ui \
  -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}={.value}{"\n"}{end}' \
  | grep -E '^(OS_ENABLED_TABS|EXTERNAL_CONNECTORS_ENABLED|OS_PUBLIC_URL)=' | sed 's/^/   /'
echo "   not-ready pods: $(kubectl --context "$CTX" -n "$NS" get pods --no-headers | grep -vcE 'Running|Completed')"
echo "   values file kept at $VALUES (contains secrets — do not commit)"
echo "DEPLOY_${VERSION}_OK"
