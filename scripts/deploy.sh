#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# deploy.sh <version> — build, push and roll out os-ui to a real cluster.
#
#   ./scripts/deploy.sh 0.7.0
#
# Run it DIRECTLY — never `deploy.sh … | tail`. A pipeline's exit status is the
# last command's, so a failed upgrade reports 0 and looks like success. The
# 2026-11-04 schema-fetch failure was missed for exactly that reason.
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
# The chart OWNS its bundled components' images and Dagster's code locations. A live values
# file written for an older release pins them (image 0.2.0, code location `example-user-code`),
# and keeping those would silently deploy the old Dagster next to the new os-ui — which is what
# happened on 0.8.0's first rollout. Drop exactly those keys so the chart's defaults apply;
# everything the operator set (enabled, pull secrets, resources, ingress) is kept.
# Only the TAG and the code-location list are chart-owned; the image REPOSITORY is the
# operator's (the chart default is the laptop profile's unprefixed `sovereign-os/dagster`,
# the cluster pulls `ghcr.io/aborek/sovereign-os/dagster`), so it is carried over.
import copy
migrated = []
d = kept.get('dagster')
if isinstance(d, dict):
    for comp in ('dagsterWebserver', 'dagsterDaemon'):
        img = (d.get(comp) or {}).get('image')
        if isinstance(img, dict) and img.pop('tag', None) is not None:
            migrated.append(f'dagster.{comp}.image.tag')
    ud = d.get('dagster-user-deployments')
    if isinstance(ud, dict) and isinstance(ud.get('deployments'), list):
        live_repo = next((e['image']['repository'] for e in ud['deployments']
                          if isinstance(e, dict) and isinstance(e.get('image'), dict) and e['image'].get('repository')), None)
        fresh = copy.deepcopy(new['dagster']['dagster-user-deployments']['deployments'])
        if live_repo:
            default_repo = new['dagster']['dagster-user-deployments']['deployments'][0]['image']['repository']
            for e in fresh:
                e.setdefault('image', {})['repository'] = live_repo
                # sidecars (repo-sync) name the image as one string: swap the laptop repository
                for sc in e.get('sidecarContainers') or []:
                    if isinstance(sc.get('image'), str) and sc['image'].startswith(default_repo + ':'):
                        sc['image'] = live_repo + sc['image'][len(default_repo):]
        ud['deployments'] = fresh
        migrated.append('dagster.dagster-user-deployments.deployments (chart list, operator repository)')
yaml.safe_dump(kept, open(sys.argv[3], 'w'), sort_keys=False)
dropped = sorted(set(live) - set(kept))
print(f"   kept {len(kept)} top-level keys; dropped {len(dropped)} for removed components")
if dropped: print("   dropped:", ', '.join(dropped))
if migrated: print("   chart-owned keys reset to the chart defaults:", ', '.join(migrated))
PY

say "what the upgrade changes"
helm --kube-context "$CTX" get manifest "$REL" -n "$NS" > "$WORK/before.yaml"
helm template "$REL" "$CHART" -n "$NS" -f "$VALUES" --skip-schema-validation > "$WORK/after.yaml"
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

# POST-BUILD SMOKE (engine rebuild A4 review): the os-ui-worker container runs the TypeScript
# SOURCE under Node's type stripping, which no unit test can verify — it is a property of the
# BASE IMAGE's Node (>= 22.6) and of the resolve hook's aliases. A base-image bump that goes
# backwards breaks the worker with ERR_UNKNOWN_FILE_EXTENSION at boot, AFTER the deploy. So
# import the whole run-path module graph in the built image before pushing it — registering
# worker/resolve-hook.mjs first, exactly as worker/start.mjs does (without it @core/* cannot resolve). Nothing connects
# to a database until main() runs, so this needs no cluster and fails loudly on its own.
say "smoke: the image can import the worker under --experimental-strip-types"
docker run --rm --entrypoint node --workdir /app/src "$IMG" \
  --experimental-strip-types --no-warnings --input-type=module \
  -e "import { register } from 'node:module'; register('./worker/resolve-hook.mjs', 'file:///app/src/'); const m = await import('./worker/agent-runs.ts'); if (typeof m.main !== 'function') { console.error('worker/agent-runs.ts exports no main()'); process.exit(1); } console.log('worker smoke: graph loaded, main() present');" \
  || { echo "WORKER_STRIP_TYPES_SMOKE_FAILED — the image cannot load the worker graph (Node < 22.6, or a package missing from the standalone tree: see scripts/worker-deps.mjs)"; exit 1; }

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
# --skip-schema-validation: the dagster subchart's values.schema.json $ref's a
# JSON schema on raw.githubusercontent.com. Helm fetches it at upgrade time, and
# on 2026-11-04 that fetch timed out and FAILED a production deploy after the
# image had already been built and pushed. A deploy must not depend on GitHub
# answering within Helm's timeout. Our own values are still exercised by the
# template/diff step above and by `helm lint` in CI.
helm --kube-context "$CTX" upgrade "$REL" "$CHART" -n "$NS" -f "$VALUES" \
  --set osUI.image.tag="$VERSION@$DIGEST" --force-conflicts --skip-schema-validation --timeout 20m
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
