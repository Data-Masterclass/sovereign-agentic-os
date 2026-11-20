#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# deploy.sh [--from-registry] [--verify-only] <version> — roll out os-ui to a real cluster.
#
#   ./scripts/deploy.sh --from-registry 0.7.0     use a tag CI already built — no local Docker
#                                                 (the supported path since 2026-11-19)
#   ./scripts/deploy.sh 0.7.0                     build here, push, upgrade — needs push rights
#                                                 on the image repository (see --help)
#   ./scripts/deploy.sh --help
#
# Run it DIRECTLY — never `deploy.sh … | tail`. A pipeline's exit status is the
# last command's, so a failed upgrade reports 0 and looks like success. The
# 2026-11-04 schema-fetch failure was missed for exactly that reason.
#
# Order is deliberate: the capacity gate (scripts/check-capacity.mjs, on the values this upgrade
# applies) and the backup FIRST (the script aborts if either fails),
# then build for the cluster's architecture, then one helm upgrade.
#
# Values: the release's OWN values are the source of truth for a running cluster —
# the chart's values.yaml is the laptop profile, so never deploy a cloud cluster
# from the defaults. This script derives the values file from the live release and
# drops only the keys the chart no longer defines.
#
# --from-registry exists because building here costs too much: the Colima VM reserves 14 GB on a
# 24 GB host, its DNS failed twice mid-build, the host has OOM-killed runs, and an emulated
# amd64 build blocks the machine for 10-15 minutes. `.github/workflows/build-images.yml` builds
# the same Dockerfile on an amd64 runner and pushes the tag; this mode then VERIFIES that tag
# exists, reads its digest from the registry, and does everything else — backup gate, values
# derivation, --force-conflicts, the single helm upgrade — exactly as a local build does.
set -euo pipefail
cd "$(dirname "$0")/.."

FROM_REGISTRY=${IMAGE_FROM_REGISTRY:-}
VERIFY_ONLY=${IMAGE_VERIFY_ONLY:-}
VERSION=
usage() {
  cat <<'USAGE'
usage: deploy.sh [--from-registry] [--verify-only] [--help] <version>

  <version>            the os-ui image tag to deploy, e.g. 0.9.0

  --from-registry      do NOT build or push. Verify <version> already exists in the registry,
                       read its digest from there, and upgrade. Needs no Docker daemon — use it
                       for a tag built by .github/workflows/build-images.yml.
  --verify-only        resolve the image reference, prove it exists, print its digest, exit.
                       Touches no cluster. Implies --from-registry.
  --help               this text.

environment
  IMAGE_FROM_REGISTRY=1     same as --from-registry
  IMAGE_VERIFY_ONLY=1       same as --verify-only
  IMAGE_REPO=<repo>         os-ui image repository (default ghcr.io/data-masterclass/sovereign-os).
                            When set (to anything, the default included), the upgrade also
                            --sets osUI.image.repository to <repo>/os-ui. It moves os-ui ONLY:
                            dagster, git-http, git-daemon and minio keep the repository the
                            live release carries (ghcr.io/aborek/sovereign-os/*).
  SKIP_BUILD=1              reuse an already-built LOCAL image instead of building again
  DEPLOY_REGISTRY_PROBE=<cmd>
                            use `<cmd> <ref>` to read a remote digest instead of
                            crane / skopeo / the registry v2 API. For tests.
  VALUES_OVERLAY=<file>     layer <file> over the values derived from the live release (a second
                            `-f`). The one supported way to CHANGE a release value; pass it once,
                            it then lives in the release. Example:
                            deploy/overlays/gateway-model-info.stackit.yaml
  KUBE_CONTEXT NS REL WORK VALUES   as before

the os-ui image is built in CI (see CONTRIBUTING.md -> "Images: build in CI")
  It lives at ghcr.io/data-masterclass/sovereign-os/os-ui (option A, taken 2026-11-19): the
  build-images workflow pushes there with the built-in GITHUB_TOKEN, no secret needed.
       git tag os-ui-v<version> && git push public os-ui-v<version>
       ./scripts/deploy.sh --from-registry <version>

  A LOCAL build (no --from-registry) pushes to IMAGE_REPO with YOUR `docker login ghcr.io`.
  With the default that is the org package, so the push needs write access to it; without it
  the run ends in PUSH_FAILED — after the backup gate, before any helm upgrade. The other way,
       IMAGE_REPO=ghcr.io/aborek/sovereign-os ./scripts/deploy.sh <version>
  pushes to the old namespace AND moves the release's osUI.image.repository back there, so
  the next plain --from-registry deploy is refused (IMAGE_REPOSITORY_MISMATCH) until it is
  run once with IMAGE_REPO=ghcr.io/data-masterclass/sovereign-os.
USAGE
}
while [ $# -gt 0 ]; do
  case $1 in
    --from-registry) FROM_REGISTRY=1 ;;
    --verify-only)   VERIFY_ONLY=1; FROM_REGISTRY=1 ;;
    -h|--help)       usage; exit 0 ;;
    -*)              echo "deploy.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
    *)               [ -z "$VERSION" ] || { echo "deploy.sh: unexpected argument $1" >&2; exit 2; }
                     VERSION=$1 ;;
  esac
  shift
done
[ -n "$VERIFY_ONLY" ] && FROM_REGISTRY=1
[ -n "$VERSION" ] || { usage >&2; exit 2; }

CTX=${KUBE_CONTEXT:-dmagenticos}
NS=${NS:-agentic-os}
REL=${REL:-agentic-os}
CHART=charts/sovereign-agentic-os
# The default is the org namespace CI pushes to (option A, taken 2026-11-19; it was
# ghcr.io/aborek/sovereign-os before). When IMAGE_REPO is PASSED the upgrade below also --sets
# osUI.image.repository, because the chart would otherwise keep pulling the repository the live
# release carries. "Passed" is recorded here, not inferred from the value: comparing against the
# default made `IMAGE_REPO=<the default>` a no-op, so the repository guard's own advice ("run
# with IMAGE_REPO=…") could not move a release ONTO the default namespace.
# IMAGE_REPO names the os-ui repository only — nothing else in this script reads it.
IMAGE_REPO_DEFAULT=ghcr.io/data-masterclass/sovereign-os
IMAGE_REPO_GIVEN=${IMAGE_REPO:+1}
IMAGE_REPO=${IMAGE_REPO:-$IMAGE_REPO_DEFAULT}
IMG=$IMAGE_REPO/os-ui:$VERSION
WORK=${WORK:-$(mktemp -d)}
VALUES=${VALUES:-$WORK/release-values.yaml}

say() { printf '\n==> %s\n' "$*"; }

# remote_digest <ref> — print the `sha256:…` a registry tag resolves to, with NO Docker daemon.
# `docker manifest inspect` is deliberately not used: it needs the very daemon this mode exists
# to avoid. First tool that is present wins; if none is, refuse rather than deploy something
# unverified.
remote_digest() {
  ref=$1
  if [ -n "${DEPLOY_REGISTRY_PROBE:-}" ]; then
    $DEPLOY_REGISTRY_PROBE "$ref"; return
  fi
  if command -v crane >/dev/null 2>&1; then
    crane digest "$ref"; return
  fi
  if command -v skopeo >/dev/null 2>&1; then
    skopeo inspect --format '{{.Digest}}' "docker://$ref"; return
  fi
  command -v curl >/dev/null 2>&1 || {
    echo "NO_REGISTRY_TOOL — install crane (brew install crane) or skopeo, or set DEPLOY_REGISTRY_PROBE" >&2
    return 1
  }
  # Registry v2 by hand, in its own script so its HTTP-status handling is testable without a
  # network (it distinguishes 401/403 — a private package the token cannot read — from 404, a
  # tag that was never pushed) and so credentials go in on stdin rather than argv.
  bash scripts/lib/registry-digest.sh "$ref"
}

if [ -n "$FROM_REGISTRY" ]; then
  say "verifying $IMG exists in the registry (no local build)"
  DIGEST=$(remote_digest "$IMG" || true)
  case ${DIGEST:-} in
    sha256:*) ;;
    *) echo "IMAGE_NOT_IN_REGISTRY — $IMG did not resolve to a digest." >&2
       echo "   Build it first:  git tag os-ui-v$VERSION && git push public os-ui-v$VERSION" >&2
       echo "   (or run the build-images workflow by hand), then retry." >&2
       exit 1 ;;
  esac
  say "digest $DIGEST"
  if [ -n "$VERIFY_ONLY" ]; then
    echo "VERIFY_${VERSION}_OK $IMG $DIGEST"
    exit 0
  fi
fi

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

# REFUSE A SPLIT-NAMESPACE DEPLOY (review M3). The digest comes from the image we are about to
# build or verify; the repository comes from the live release's own values. If those two
# disagree the digest does not exist where the chart pulls from, and every os-ui pod goes
# ImagePullBackOff — after the backup gate, after the push, with the old ReplicaSet gone. Only
# checked when IMAGE_REPO was NOT passed: with it, the upgrade below --sets the repository, so
# the two agree by construction. See scripts/lib/check-image-repo.py.
if [ -z "$IMAGE_REPO_GIVEN" ]; then
  say "the release's os-ui repository must match the image we are deploying"
  python3 scripts/lib/check-image-repo.py "$VALUES" "$IMAGE_REPO/os-ui" "$CHART/values.yaml"
fi

# VALUES_OVERLAY=<file> — an operator's deliberate change to the RELEASE VALUES, layered over the
# file derived above (a second `-f`, so Helm's own merge rules apply: maps merge, lists replace).
# The derived file is the live release's values, so without this there is no door for changing
# them short of a hand-run `helm upgrade` that skips the backup gate. What the overlay sets
# becomes part of the release: the next plain run derives it from there, so it is passed ONCE.
# It appears in the "what the upgrade changes" list below before anything is applied.
OVERLAY_ARGS=()
if [ -n "${VALUES_OVERLAY:-}" ]; then
  [ -f "$VALUES_OVERLAY" ] || { echo "VALUES_OVERLAY_NOT_FOUND — $VALUES_OVERLAY is not a file" >&2; exit 2; }
  OVERLAY_ARGS=(-f "$VALUES_OVERLAY")
  say "layering VALUES_OVERLAY=$VALUES_OVERLAY over the release values"
fi

# WHICH VALUES WIN (2026-11-19). The values above come from the live release, so a value the
# release already pins silently beats a changed chart default — a chart change once did not
# reach production for exactly that reason. List what changes, what the release overrides and
# what the chart does not define, BEFORE anything is applied. Information only; secret-looking
# paths and non-plain values print as `(hidden)` (see scripts/lib/values-diff.py).
say "which release values change, and which override the chart"
python3 scripts/lib/values-diff.py "$WORK/live.yaml" "$CHART/values.yaml" "$VALUES" ${VALUES_OVERLAY:+"$VALUES_OVERLAY"} \
  || echo "   (values diff unavailable — not a deploy failure)"

say "what the upgrade changes"
helm --kube-context "$CTX" get manifest "$REL" -n "$NS" > "$WORK/before.yaml"
helm template "$REL" "$CHART" -n "$NS" -f "$VALUES" "${OVERLAY_ARGS[@]+"${OVERLAY_ARGS[@]}"}" --skip-schema-validation > "$WORK/after.yaml"
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

# CAPACITY GATE (WP-47). The same check CI and release.sh run, but on the values THIS upgrade
# applies: chart defaults + the live release values + VALUES_OVERLAY, rendered as helm will. A
# deploy run by hand must not put more on the node than it can give. CI=true: a skip (no helm
# dependencies, no js-yaml) stops the deploy too. Before the backup, so a refusal changes nothing.
say "capacity gate: the values this upgrade applies must fit the node (scripts/check-capacity.mjs)"
if CI=true node scripts/check-capacity.mjs --profile default --skip-schema-validation -f "$VALUES" \
     ${VALUES_OVERLAY:+-f "$VALUES_OVERLAY"} > "$WORK/capacity.txt" 2>&1; then
  grep -E 'percent of allocatable|check-capacity: ok' "$WORK/capacity.txt" | sed 's/^ */   /'
else
  sed 's/^/   /' "$WORK/capacity.txt" | grep -vE '^   +(Deployment|StatefulSet|DaemonSet|ReplicaSet|Pod)/' >&2
  echo "CAPACITY_GATE_FAILED — the values this deploy applies do not fit the node budget in $CHART/capacity.yaml; nothing was changed" >&2
  exit 1
fi

say "pre-upgrade backup (standing rule — aborts the deploy if it fails)"
# pre-upgrade-backup.sh uses the AMBIENT kubectl context, so make it explicit —
# running it against the wrong cluster is how you get a deploy with no backup.
kubectl config use-context "$CTX" >/dev/null
KUBECONFIG=${KUBECONFIG:-$HOME/.kube/config} deploy/pre-upgrade-backup.sh

if [ -n "$FROM_REGISTRY" ]; then
  # Already verified above, and the smoke that follows a local build ran in CI against this
  # exact image before it was pushed (.github/workflows/build-images.yml). Nothing to build,
  # nothing to push, no Docker daemon needed.
  say "using the registry image $IMG@$DIGEST (built in CI)"
else

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

fi  # end of the local build-and-push path

say "helm upgrade"
# --skip-schema-validation: the dagster subchart's values.schema.json $ref's a
# JSON schema on raw.githubusercontent.com. Helm fetches it at upgrade time, and
# on 2026-11-04 that fetch timed out and FAILED a production deploy after the
# image had already been built and pushed. A deploy must not depend on GitHub
# answering within Helm's timeout. Our own values are still exercised by the
# template/diff step above and by `helm lint` in CI.
#
# The image REPOSITORY is normally the operator's, carried over from the live release by the
# derivation above (night-1: the chart owns the TAG, the operator owns the REPOSITORY). Only
# when IMAGE_REPO was passed explicitly do we override it — so a plain `deploy.sh <version>`
# runs the exact command line it has always run.
REPO_SET=()
[ -z "$IMAGE_REPO_GIVEN" ] || REPO_SET=(--set "osUI.image.repository=$IMAGE_REPO/os-ui")
[ ${#REPO_SET[@]} -eq 0 ] || say "overriding osUI.image.repository=$IMAGE_REPO/os-ui (IMAGE_REPO)"
helm --kube-context "$CTX" upgrade "$REL" "$CHART" -n "$NS" -f "$VALUES" "${OVERLAY_ARGS[@]+"${OVERLAY_ARGS[@]}"}" \
  --set osUI.image.tag="$VERSION@$DIGEST" "${REPO_SET[@]+"${REPO_SET[@]}"}" \
  --force-conflicts --skip-schema-validation --timeout 20m
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
