#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# deploy.sh [--env dev|prod] [--from-registry] [--verify-only] <version> — roll out os-ui to a real cluster.
#
#   --env prod (THE DEFAULT) is production, exactly as before: context dmagenticos, values derived
#   from the live release, the backup gate. --env dev is the dev cluster (docs/ops/dev-environment.md):
#   context dmagosdev, values.dev.yaml + the private overlay, `helm upgrade --install`, no backup
#   (synthetic data; reset = reseed). The context is chosen BY THE ENV, never by the kubeconfig's
#   current-context, and scripts/lib/env-guard.sh refuses a context that does not belong to the env.
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
usage: deploy.sh [--env dev|prod] [--from-registry] [--verify-only] [--help] <version>

  <version>            the os-ui image tag to deploy, e.g. 0.9.0 (dev: main-<sha>)

  --env prod|dev       the environment (default prod). It picks the kube context:
                       prod -> $KUBE_CONTEXT or dmagenticos; dev -> $DEV_KUBE_CONTEXT or dmagosdev.
                       scripts/lib/env-guard.sh refuses a mismatch (a dev deploy with the
                       production context, a prod deploy with the dev context, a "dev" cluster
                       without the environment=dev marker). KUBE_CONTEXT is a PROD override only.

  --from-registry      do NOT build or push. Verify <version> already exists in the registry,
                       read its digest from there, and upgrade. Needs no Docker daemon — use it
                       for a tag built by .github/workflows/build-images.yml.
  --verify-only        resolve the image reference, prove it exists, print its digest, exit.
                       Touches no cluster. Implies --from-registry.
  --allow-runner-downgrade  accept pinning a data-runner that does not apply column names over one
                       that does while datasets store mapped names (their uploads fail).
  --help               this text.

environment
  IMAGE_FROM_REGISTRY=1     same as --from-registry
  IMAGE_VERIFY_ONLY=1       same as --verify-only
  IMAGE_REPO=<repo>         os-ui image repository (default ghcr.io/data-masterclass/sovereign-os).
                            When set (to anything, the default included), the upgrade also
                            --sets osUI.image.repository to <repo>/os-ui. It moves os-ui ONLY:
                            git-http, git-daemon and minio keep the repository the live
                            release carries (ghcr.io/aborek/sovereign-os/*). Dagster follows
                            the CHART once its repository is registry-qualified (0.3.2: the
                            org registry, pinned by digest).
  SKIP_BUILD=1              reuse an already-built LOCAL image instead of building again
  DEPLOY_REGISTRY_PROBE=<cmd>
                            use `<cmd> <ref>` to read a remote digest instead of
                            crane / skopeo / the registry v2 API. For tests.
  VALUES_OVERLAY=<file>     layer <file> over the values derived from the live release (a second
                            `-f`). The one supported way to CHANGE a release value; pass it once,
                            it then lives in the release. It can NOT bring config-file gateway
                            models back: deploy/gateway-no-config-models.yaml is layered after it.
  GATEWAY_PREFLIGHT=skip    do not read the live gateway before the upgrade (tests only)
  ALLOW_GATEWAY_MODELS_MISSING=1
                            go ahead although the gateway preflight found referenced models with no
                            LiteLLM database row (they stop answering; printed loudly). Owner only.
  KUBE_CONTEXT NS REL WORK VALUES   as before (prod)
  DEPLOY_ENV=dev|prod       same as --env
  DEV_KUBE_CONTEXT=<ctx>    dev context (default dmagosdev)
  DEV_PRIVATE_VALUES=<file> dev: the private overlay (default
                            ~/.sovereign-os-secrets/dev/values.dev.private.yaml, written by
                            scripts/dev/bootstrap-secrets.sh). DEV_PRIVATE_VALUES=cluster reads it
                            from the dev cluster's Secret sovereign-os-dev-values instead (CI).
  DEV_MODEL=stub            dev: also layer values.dev.model-stub.yaml (no model spend)
  DEV_NODE=g2i8|m2i4        dev: the node profile (default g2i8). m2i4 layers values.dev.m2i4.yaml
                            and gates against capacity.dev-m2i4.yaml (the cheaper 4 vCPU node).
  EXPECT_DIGEST=sha256:...  refuse unless <version> resolves to exactly this digest (the release
                            gate passes the digest dev recorded; a re-pointed tag is refused)
  DEPLOY_RECORD=<file>      write {env, context, release, revisions, image, digest} as JSON there

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
    --env)           DEPLOY_ENV=${2:-}; shift ;;
    --verify-only)   VERIFY_ONLY=1; FROM_REGISTRY=1 ;;
    --allow-runner-downgrade) ALLOW_RUNNER_DOWNGRADE=1 ;;
    -h|--help)       usage; exit 0 ;;
    -*)              echo "deploy.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
    *)               [ -z "$VERSION" ] || { echo "deploy.sh: unexpected argument $1" >&2; exit 2; }
                     VERSION=$1 ;;
  esac
  shift
done
[ -n "$VERIFY_ONLY" ] && FROM_REGISTRY=1
[ -n "$VERSION" ] || { usage >&2; exit 2; }

DEPLOY_ENV=${DEPLOY_ENV:-prod}
case $DEPLOY_ENV in
  prod) CTX=${KUBE_CONTEXT:-$(bash scripts/lib/env-guard.sh --env prod --print-default-context)} ;;
  dev)  CTX=${DEV_KUBE_CONTEXT:-$(bash scripts/lib/env-guard.sh --env dev --print-default-context)} ;;
  *)    echo "deploy.sh: --env must be dev or prod (got '$DEPLOY_ENV')" >&2; exit 2 ;;
esac
NS=${NS:-agentic-os}
REL=${REL:-agentic-os}
CHART=charts/sovereign-agentic-os
GATEWAY_CONFIG_MODELS=deploy/gateway-no-config-models.yaml   # empties the gateway's config model_list, layered last on dev and prod
[ -f "$GATEWAY_CONFIG_MODELS" ] || { echo "GATEWAY_CONFIG_MODELS_MISSING — $GATEWAY_CONFIG_MODELS is not a file" >&2; exit 2; }
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
  if [ -n "${EXPECT_DIGEST:-}" ] && [ "$DIGEST" != "$EXPECT_DIGEST" ]; then
    echo "DIGEST_NOT_DEV_TESTED — $IMG resolves to $DIGEST, but the tested digest is $EXPECT_DIGEST; refusing" >&2
    exit 1
  fi
  if [ -n "$VERIFY_ONLY" ]; then
    echo "VERIFY_${VERSION}_OK $IMG $DIGEST"
    exit 0
  fi
fi

say "env $DEPLOY_ENV: context $CTX / namespace $NS"
# THE ENV/CONTEXT GUARD. Before any cluster read: a dev deploy can never reach production.
if guard=$(bash scripts/lib/env-guard.sh --env "$DEPLOY_ENV" --context "$CTX" 2>/dev/null); then
  echo "   ${guard##*$'\n'}"
else
  echo "   ${guard##*$'\n'}" >&2
  echo "DEPLOY_REFUSED — env $DEPLOY_ENV does not match context $CTX; nothing was changed" >&2
  exit 1
fi
# Helm 4 or newer, before any other Helm call (the Secret deletion guard below relies on Helm 4's
# behaviour). After the env guard, so a wrong context is refused first. Fail closed.
bash scripts/lib/helm-version-guard.sh || exit 1

revision_of() {
  helm --kube-context "$CTX" history "$REL" -n "$NS" --max 1 -o json 2>/dev/null \
    | python3 -c 'import json,sys; h=json.load(sys.stdin); print(h[-1]["revision"] if h else "")' 2>/dev/null || true
}
REV_BEFORE=$(revision_of)
write_record() { # write_record <revision after>
  [ -n "${DEPLOY_RECORD:-}" ] || return 0
  python3 - "$DEPLOY_RECORD" "$DEPLOY_ENV" "$CTX" "$NS" "$REL" "${REV_BEFORE:-}" "$1" "$IMG" "${DIGEST:-}" <<'PY2'
import json, sys
k = ['env', 'context', 'namespace', 'release', 'revision_before', 'revision_after', 'image', 'digest']
rec = dict(zip(k, sys.argv[2:]))
rec['rollback'] = (f"scripts/rollback.sh --env {rec['env']} --to {rec['revision_before']}" if rec['revision_before'] else '')
json.dump(rec, open(sys.argv[1], 'w'), indent=2)
PY2
}

OVERLAY_ARGS=()
if [ "$DEPLOY_ENV" = dev ]; then
  # DEV VALUES: the committed profile + the private overlay; never derived from a live release
  # (dev may not have one yet, and it must not inherit anything by accident).
  say "dev values: values.dev.yaml + the private overlay${DEV_MODEL:+ + values.dev.model-stub.yaml}"
  PRIVATE=${DEV_PRIVATE_VALUES:-$HOME/.sovereign-os-secrets/dev/values.dev.private.yaml}
  if [ "$PRIVATE" = cluster ]; then
    PRIVATE=$WORK/values.dev.private.yaml
    ( umask 077
      kubectl --context "$CTX" -n "$NS" get secret sovereign-os-dev-values -o jsonpath='{.data.values\.yaml}' \
        | base64 -d > "$PRIVATE" ) || { echo "DEV_PRIVATE_VALUES_MISSING — Secret sovereign-os-dev-values not readable on $CTX (scripts/dev/bootstrap-secrets.sh)" >&2; exit 1; }
  fi
  [ -s "$PRIVATE" ] || { echo "DEV_PRIVATE_VALUES_MISSING — $PRIVATE is missing or empty (scripts/dev/bootstrap-secrets.sh)" >&2; exit 1; }
  cp values.dev.yaml "$VALUES"
  OVERLAY_ARGS=(-f "$PRIVATE")
  [ "${DEV_MODEL:-}" != stub ] || OVERLAY_ARGS+=(-f values.dev.model-stub.yaml)
  case ${DEV_NODE:-g2i8} in
    g2i8) DEV_BUDGET=$CHART/capacity.dev.yaml ;;
    m2i4) DEV_BUDGET=$CHART/capacity.dev-m2i4.yaml; OVERLAY_ARGS+=(-f values.dev.m2i4.yaml) ;;
    *)    echo "deploy.sh: DEV_NODE must be g2i8 or m2i4" >&2; exit 2 ;;
  esac
  if [ -n "${VALUES_OVERLAY:-}" ]; then
    [ -f "$VALUES_OVERLAY" ] || { echo "VALUES_OVERLAY_NOT_FOUND — $VALUES_OVERLAY is not a file" >&2; exit 2; }
    OVERLAY_ARGS+=(-f "$VALUES_OVERLAY")
  fi
  # The repository is always set explicitly on dev (below), so the split-namespace check of the
  # prod path does not apply.
  IMAGE_REPO_GIVEN=1
else
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
# The TAG, the DIGEST and the code-location list are chart-owned. The image REPOSITORY is the
# operator's while the chart names only the laptop profile's unprefixed `sovereign-os/dagster`.
# Once the chart names a REGISTRY-QUALIFIED repository (a host in the first segment, e.g.
# `ghcr.io/data-masterclass/sovereign-os/dagster`, WP-03 0.3.2) the chart owns it too: the
# digest it pins exists only there, so carrying the live repository would pull a digest that
# is not in it (ImagePullBackOff). Tested in scripts/tests/deploy-dagster-image.test.sh.
import copy
migrated = []
def qualified(repo):
    first = str(repo or '').split('/', 1)[0]
    return '/' in str(repo or '') and ('.' in first or ':' in first or first == 'localhost')
d = kept.get('dagster')
if isinstance(d, dict):
    for comp in ('dagsterWebserver', 'dagsterDaemon'):
        img = (d.get(comp) or {}).get('image')
        chart_img = ((new.get('dagster') or {}).get(comp) or {}).get('image') or {}
        keys = ('tag', 'digest', 'repository') if qualified(chart_img.get('repository')) else ('tag', 'digest')
        if isinstance(img, dict):
            for k in keys:
                if img.pop(k, None) is not None:
                    migrated.append(f'dagster.{comp}.image.{k}')
    ud = d.get('dagster-user-deployments')
    if isinstance(ud, dict) and isinstance(ud.get('deployments'), list):
        live_repo = next((e['image']['repository'] for e in ud['deployments']
                          if isinstance(e, dict) and isinstance(e.get('image'), dict) and e['image'].get('repository')), None)
        fresh = copy.deepcopy(new['dagster']['dagster-user-deployments']['deployments'])
        default_repo = new['dagster']['dagster-user-deployments']['deployments'][0]['image']['repository']
        if live_repo and not qualified(default_repo):
            for e in fresh:
                e.setdefault('image', {})['repository'] = live_repo
                # sidecars (repo-sync) name the image as one string: swap the laptop repository
                for sc in e.get('sidecarContainers') or []:
                    if isinstance(sc.get('image'), str) and sc['image'].startswith(default_repo + ':'):
                        sc['image'] = live_repo + sc['image'][len(default_repo):]
        ud['deployments'] = fresh
        migrated.append('dagster.dagster-user-deployments.deployments (chart list, '
                        + ('chart repository' if qualified(default_repo) else 'operator repository') + ')')
# ROLL ORDER — the data-runner goes BEFORE (or with) os-ui, never after, and is never rolled back
# below the first build that applies `columnNames` while datasets store mapped column names: an
# older runner ignores the names and lands raw headers. os-ui refuses to register such a landing
# (typed COLUMN_MAPPING_MISMATCH), so nothing is silently broken, but the upload fails until the
# runner is forward again. One `helm upgrade` rolls both at once, which satisfies the order.
# WHY THE FIRST UPGRADE IS SAFE in any roll order: a dataset STORES mapped names only after a
# runner that applies `columnNames` has landed one of its uploads. Before that first landing no
# dataset has a mapping, so an os-ui that is briefly ahead of an older runner just records the
# raw headers it landed (valid quoted names) — there is nothing to flip. The rollback side of the
# same rule is enforced by scripts/rollback.sh: it refuses to go below that runner while any
# dataset stores mapped names, unless --allow-runner-downgrade is given.
# NOTE: the digest pin adds `@sha256:` to the runner's image reference, so the first deploy with
# it restarts data-runner once on the SAME image bits.
# The data-runner image follows the same rule (pinned by digest, chart-owned): tag, digest and
# localBuild always come from the chart, and the repository too once the chart's is
# registry-qualified — so a live hand-built `ghcr.io/aborek/...` value never wins over the pin.
dr_img = (kept.get('dataRunner') or {}).get('image') if isinstance(kept.get('dataRunner'), dict) else None
if isinstance(dr_img, dict):
    chart_dr = ((new.get('dataRunner') or {}).get('image') or {})
    keys = ('tag', 'digest', 'localBuild', 'repository') if qualified(chart_dr.get('repository')) else ('tag', 'digest', 'localBuild')
    for k in keys:
        if dr_img.pop(k, None) is not None:
            migrated.append(f'dataRunner.image.{k}')
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
# The diff shows VALUES_OVERLAY and the gateway file (layered below) as one overlay.
python3 - "$WORK/diff-overlay.yaml" ${VALUES_OVERLAY:+"$VALUES_OVERLAY"} "$GATEWAY_CONFIG_MODELS" <<'PY'
import sys, yaml
def merge(a, b):
    if isinstance(a, dict) and isinstance(b, dict):
        out = dict(a)
        for k, v in b.items(): out[k] = merge(a.get(k), v)
        return out
    return a if b is None else b
out = {}
for f in sys.argv[2:]: out = merge(out, yaml.safe_load(open(f)) or {})
yaml.safe_dump(out, open(sys.argv[1], "w"), sort_keys=False)
PY
python3 scripts/lib/values-diff.py "$WORK/live.yaml" "$CHART/values.yaml" "$VALUES" "$WORK/diff-overlay.yaml" \
  || echo "   (values diff unavailable — not a deploy failure)"
fi  # end of the prod values derivation

# NO CONFIG-FILE GATEWAY MODELS (both environments). Every model lives in LiteLLM's database, created by hand
# per environment (owner decision 2026-11-23; docs/components/litellm.md "Models live in LiteLLM's database").
# deploy/gateway-no-config-models.yaml sets `litellm.proxy_config.model_list: []` and is layered after every
# other values source (the dev values and private overlay, the live production release, VALUES_OVERLAY); Helm
# replaces a list whole, so no earlier list survives. The gateway preflight below refuses the upgrade while a
# referenced model has no database row. scripts/check-gateway-config-models.mjs gates this ordering in CI.
OVERLAY_ARGS+=(-f "$GATEWAY_CONFIG_MODELS")
say "gateway models: layering $GATEWAY_CONFIG_MODELS (no config-file models; the catalog is LiteLLM's database)"

# THE API SERVER ADDRESS THE PODS USE (both environments). On Gardener (STACKIT SKE) a webhook sets
# every pod's KUBERNETES_SERVICE_HOST to the API server's domain, so in-cluster clients connect to
# the address it resolves to, which `allow-apiserver-egress` must admit next to the endpoint
# (networkPolicies.apiserver.extraCidrs). Read from the running pods and resolved here, per cluster,
# on every deploy; a host that does not resolve stops the deploy (run launches would time out).
APISERVER_OVERLAY=$WORK/apiserver-extra.yaml
set +e
python3 scripts/lib/apiserver-cidrs.py --context "$CTX" --namespace "$NS" > "$APISERVER_OVERLAY"
api_rc=$?
set -e
case $api_rc in
  0) OVERLAY_ARGS+=(-f "$APISERVER_OVERLAY"); say "API server egress: adding $(sed -n 's/^ *extraCidrs: //p' "$APISERVER_OVERLAY") (the pods' KUBERNETES_SERVICE_HOST)" ;;
  1) say "API server egress: no injected KUBERNETES_SERVICE_HOST in $NS; the endpoint addresses suffice" ;;
  *) echo "APISERVER_HOST_UNRESOLVED — see the line above; fix DNS or set networkPolicies.apiserver.extraCidrs" >&2; exit 1 ;;
esac

# TEST-RENDER SWITCH (templates/base/secret-defaults-guard.yaml). global.allowChartDefaultSecrets lets
# a throwaway test render keep the chart's published default secrets; a real deploy must never
# carry it, whatever set it (the chart default, the live release, the dev values, VALUES_OVERLAY).
# The values are merged in the order helm applies them; anything but false/absent refuses.
say "test-render switch: global.allowChartDefaultSecrets must not be set for a deploy"
if ! python3 - "$CHART/values.yaml" "$VALUES" ${OVERLAY_ARGS[@]+"${OVERLAY_ARGS[@]}"} <<'PY'
import sys, yaml
files = [a for a in sys.argv[1:] if a != "-f"]
val, src = None, None
for f in files:
    g = (yaml.safe_load(open(f)) or {}).get("global")
    if isinstance(g, dict) and "allowChartDefaultSecrets" in g:
        val, src = g["allowChartDefaultSecrets"], f
if val in (None, False):
    print("   ok   not set (the chart guard refuses default secrets on this install)")
    sys.exit(0)
print(f"ALLOW_CHART_DEFAULT_SECRETS_REFUSED — global.allowChartDefaultSecrets is {val!r} in the merged values (last set by {src}). It is for test renders only; remove it. Nothing was changed.", file=sys.stderr)
sys.exit(1)
PY
then exit 1; fi

say "what the upgrade changes"
if [ "$DEPLOY_ENV" = dev ] && [ -z "$REV_BEFORE" ]; then
  : > "$WORK/before.yaml"   # first install on dev: nothing to compare with
else
  helm --kube-context "$CTX" get manifest "$REL" -n "$NS" > "$WORK/before.yaml"
fi
helm template "$REL" "$CHART" -n "$NS" -f "$VALUES" "${OVERLAY_ARGS[@]+"${OVERLAY_ARGS[@]}"}" --skip-schema-validation > "$WORK/after.yaml"
# RUNNER CAPABILITY FROM THE IMAGE ITSELF. Does the pinned data-runner apply os-ui's `columnNames`?
# Decided HERE from the image's own OCI label org.sovereign-os.applies-column-names, read from the
# registry (scripts/lib/image-label.sh, read-only), never from the chart alone: an old hand-built
# runner (0.1.x, 0.2.0, 0.2.1) is not on the legacy list but carries no label, so it is NOT capable.
# A digest on dataRunner.legacyDigests is not capable whatever it says (extra guard, and the one
# case read without the registry). FAIL CLOSED: an unreadable label refuses the deploy. The value
# is passed to the chart (dataRunner.verifiedCapability), so the release's annotation — what
# scripts/rollback.sh reads later — is the image's truth.
CAP_SET=()
RUNNER_REF=$(python3 - "$WORK/after.yaml" <<'PY'
import sys, yaml
for d in yaml.safe_load_all(open(sys.argv[1])):
    if isinstance(d, dict) and d.get("kind") == "Deployment" and (d.get("metadata") or {}).get("name") == "data-runner":
        print(d["spec"]["template"]["spec"]["containers"][0]["image"])
PY
) || { echo "RUNNER_CAPABILITY_UNKNOWN — cannot read the data-runner image from the rendered chart" >&2; exit 1; }
if [ -n "$RUNNER_REF" ]; then
  LEGACY=$(python3 -c 'import sys,yaml; print(" ".join(((yaml.safe_load(open(sys.argv[1])) or {}).get("dataRunner") or {}).get("legacyDigests") or []))' "$CHART/values.yaml")
  case " $LEGACY " in
    *" ${RUNNER_REF##*@} "*) RUNNER_CAP=false; echo "   data-runner $RUNNER_REF: a legacy build (dataRunner.legacyDigests) — does not apply column names" ;;
    *)
      label=$(bash scripts/lib/image-label.sh "$RUNNER_REF" org.sovereign-os.applies-column-names) \
        || { echo "RUNNER_LABEL_UNREADABLE — cannot read the org.sovereign-os.applies-column-names label of $RUNNER_REF from the registry; refusing rather than guessing" >&2; exit 1; }
      if [ "$label" = true ]; then RUNNER_CAP=true; else RUNNER_CAP=false; fi
      echo "   data-runner $RUNNER_REF: label org.sovereign-os.applies-column-names='${label}' -> applies column names: $RUNNER_CAP" ;;
  esac
  CAP_SET=(--set-string "dataRunner.verifiedCapability=$RUNNER_CAP")
  helm template "$REL" "$CHART" -n "$NS" -f "$VALUES" "${OVERLAY_ARGS[@]+"${OVERLAY_ARGS[@]}"}" "${CAP_SET[@]}" --skip-schema-validation > "$WORK/after.yaml"
fi
# RE-PIN GUARD (data-runner): deploying a runner that does not apply column names over one that
# does — e.g. re-pinning a legacy digest (dataRunner.legacyDigests) — is refused while any dataset
# stores mapped column names, exactly as scripts/rollback.sh refuses the same downgrade.
# `--allow-runner-downgrade` is the explicit override. Fail closed: an unreadable manifest refuses.
CAP_BEFORE=$(python3 scripts/lib/runner-capability.py "$WORK/before.yaml") \
  || { echo "RUNNER_CAPABILITY_UNKNOWN — cannot read the live data-runner from the release manifest" >&2; exit 1; }
CAP_AFTER=$(python3 scripts/lib/runner-capability.py "$WORK/after.yaml") \
  || { echo "RUNNER_CAPABILITY_UNKNOWN — cannot read the data-runner from the rendered chart" >&2; exit 1; }
if [ "$CAP_BEFORE" = true ] && [ "$CAP_AFTER" != true ]; then
  probe=${DEPLOY_MAPPED_COLUMNS_PROBE:-scripts/lib/mapped-columns.sh}
  if mapped=$(bash "$probe" --context "$CTX" --ns "$NS" 2>/dev/null | tail -1) && [[ $mapped =~ ^[0-9]+$ ]]; then :; else mapped=unknown; fi
  if [ "$mapped" != 0 ]; then
    if [ -z "${ALLOW_RUNNER_DOWNGRADE:-}" ]; then
      echo "RUNNER_DOWNGRADE_REFUSED — this deploy pins a data-runner that does not apply column names over one that does, and $mapped dataset(s) store mapped column names; their uploads would fail. Pin a current runner, or pass --allow-runner-downgrade." >&2
      exit 1
    fi
    echo "   WARNING: --allow-runner-downgrade: $mapped dataset(s) store mapped column names"
  fi
fi
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

# SECRET DELETION GUARD (WP-10): Helm deletes a Secret the chart stops rendering unless the live
# object carries helm.sh/resource-policy: keep. Refuse before anything changes.
bash scripts/lib/secret-deletion-guard.sh --context "$CTX" --ns "$NS" "$WORK/before.yaml" "$WORK/after.yaml" || exit 1

# SECRET PREFLIGHT (defence in depth). os-ui and the worker refuse to boot in production when a
# secret they read is missing or equals a public development default (core/kernel/secret-guard.ts),
# so an upgrade that would hand them such a value must not start. READ-ONLY and BY HASH ONLY: the
# values the upgrade applies (the render above, else the Secret already in the cluster) are hashed
# in-process and compared with the published defaults' digests; nothing is printed but names.
# Before the backup, so a refusal changes nothing. Rotate first: docs/ops/secret-rotation.md.
say "secret preflight: no guarded secret is missing or a public development default"
if ! KUBECTL="kubectl --context $CTX -n $NS" python3 scripts/lib/check-secrets-not-defaults.py "$WORK/after.yaml"; then
  echo "SECRET_PREFLIGHT_FAILED — the secrets above must be rotated BEFORE this upgrade (the new os-ui would refuse to boot)." >&2
  echo "   Procedure: docs/ops/secret-rotation.md (rotation order for LiteLLM, os-ui, os-ui-worker and Langfuse). Nothing was changed." >&2
  exit 1
fi
# ROTATION DRIFT GUARD (docs/ops/WP-secret-rotation.md). Between `rotate-secrets.sh ds-rekey` and
# the overlay deploy, the cluster holds rotated credentials the release values do not have yet; a
# deploy from older values would put them back and silently undo the rotation. Every Secret key the
# cluster records as written by rotate-secrets must equal the render — by fingerprint — unless
# ROTATION_IN_PROGRESS is set. Read-only, before the backup; the refusal names the overlay to use.
say "rotation drift guard: no Secret key that rotate-secrets.sh changed goes back to an older value"
if ! KUBECTL="kubectl --context $CTX -n $NS" python3 scripts/lib/rotation-drift-guard.py --what deploy "$WORK/after.yaml"; then
  exit 1
fi
# CAPACITY GATE (WP-47). The same check CI and release.sh run, but on the values THIS upgrade
# applies: chart defaults + the live release values + VALUES_OVERLAY, rendered as helm will. A
# deploy run by hand must not put more on the node than it can give. CI=true: a skip (no helm
# dependencies, no js-yaml) stops the deploy too. Before the backup, so a refusal changes nothing.
say "capacity gate: the values this upgrade applies must fit the node (scripts/check-capacity.mjs)"
if [ "$DEPLOY_ENV" = dev ]; then
  # The budget is only true for the node it describes: DEV_NODE must name the flavour the dev
  # node REALLY is (its node.kubernetes.io/instance-type label), or the gate checks the wrong box.
  want=$(sed -n 's/^  flavour: *//p' "$DEV_BUDGET" | head -1)
  have=$(kubectl --context "$CTX" get nodes -o jsonpath='{.items[*].metadata.labels.node\.kubernetes\.io/instance-type}' 2>/dev/null || true)
  if [ -z "$have" ]; then
    echo "DEV_NODE_UNKNOWN — the dev nodes carry no instance-type label (or cannot be read); refusing to gate against $want blindly" >&2; exit 1
  fi
  for f in $have; do
    [ "$f" = "$want" ] || { echo "DEV_NODE_MISMATCH — DEV_NODE=${DEV_NODE:-g2i8} expects $want, the dev node is $f; set DEV_NODE to match (docs/ops/dev-environment.md, Sizing)" >&2; exit 1; }
  done
  echo "   dev node flavour $have matches DEV_NODE=${DEV_NODE:-g2i8}"
  CAPACITY_ARGS=(--budget "$DEV_BUDGET" -f "$VALUES" "${OVERLAY_ARGS[@]}")
else
  CAPACITY_ARGS=(-f "$VALUES" ${VALUES_OVERLAY:+-f "$VALUES_OVERLAY"} -f "$GATEWAY_CONFIG_MODELS")
fi
if CI=true node scripts/check-capacity.mjs --profile default --skip-schema-validation "${CAPACITY_ARGS[@]}" > "$WORK/capacity.txt" 2>&1; then
  grep -E 'percent of allocatable|check-capacity: ok' "$WORK/capacity.txt" | sed 's/^ */   /'
else
  sed 's/^/   /' "$WORK/capacity.txt" | grep -vE '^   +(Deployment|StatefulSet|DaemonSet|ReplicaSet|Pod)/' >&2
  echo "CAPACITY_GATE_FAILED — the values this deploy applies do not fit the node budget in $CHART/capacity.yaml; nothing was changed" >&2
  exit 1
fi

# GATEWAY PREFLIGHT (both environments). This upgrade drops the config-file models (above), so every model a role
# alias, a virtual key or the current config names must already be a LiteLLM DATABASE row, or it stops answering.
# Read-only, inside the gateway pod (scripts/gateway/gateway_live.py; the master key never leaves it; names only).
# Before the backup, so a refusal changes nothing. Fix: scripts/gateway/migrate-config-models-to-db.mjs.
if [ "${GATEWAY_PREFLIGHT:-}" = skip ]; then
  say "gateway preflight SKIPPED (GATEWAY_PREFLIGHT=skip)"
elif ! gw_err=$(kubectl --context "$CTX" -n "$NS" get deploy "$REL-litellm" -o name 2>&1 >/dev/null); then
  # Only a real NotFound means "first install". Anything else (auth, network, RBAC) must not fail open.
  case $gw_err in
    *NotFound*|*"not found"*) say "gateway preflight: no $REL-litellm yet (first install) — nothing to lose" ;;
    *) echo "GATEWAY_PREFLIGHT_UNREADABLE — kubectl get deploy $REL-litellm failed: ${gw_err##*$'\n'}" >&2
       echo "GATEWAY_PREFLIGHT_FAILED — nothing was changed (fix cluster access, or GATEWAY_PREFLIGHT=skip in a test)." >&2
       exit 1 ;;
  esac
else
  say "gateway preflight: every referenced model has a LiteLLM database row"
  set +e
  GATEWAY_SKIP_ENV_GUARD=1 DEV_KUBECONFIG= PROD_KUBECONFIG= NS="$NS" REL="$REL" node scripts/gateway/preflight-db-models.mjs --env "$DEPLOY_ENV" --context "$CTX"
  gw_rc=$?
  set -e
  if [ "$gw_rc" -ne 0 ]; then
    if [ "${ALLOW_GATEWAY_MODELS_MISSING:-}" = 1 ]; then
      echo "!!! ALLOW_GATEWAY_MODELS_MISSING=1 — DEPLOYING ANYWAY: the models listed above will STOP ANSWERING after this upgrade !!!" >&2
    else
      echo "GATEWAY_PREFLIGHT_FAILED — nothing was changed. Create the missing database rows first (scripts/gateway/migrate-config-models-to-db.mjs --env $DEPLOY_ENV --apply), or set ALLOW_GATEWAY_MODELS_MISSING=1 knowingly." >&2
      exit 1
    fi
  fi
fi

if [ "$DEPLOY_ENV" = dev ]; then
  say "no pre-upgrade backup on dev: synthetic data only, a reset reseeds it (docs/ops/dev-environment.md)"
else
say "pre-upgrade backup (standing rule — aborts the deploy if it fails)"
# pre-upgrade-backup.sh uses the AMBIENT kubectl context. It gets a kubeconfig of its own that
# holds ONLY $CTX (minified), so it cannot reach another cluster — and the shared kubeconfig's
# current-context is never changed (it used to be, with `kubectl config use-context`).
( umask 077; kubectl config view --minify --flatten --context "$CTX" > "$WORK/backup-kubeconfig.yaml" )
KUBECONFIG=$WORK/backup-kubeconfig.yaml deploy/pre-upgrade-backup.sh
fi

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

# WP-49 (review N1): before the upgrade, every live domain repo's layout, READ-ONLY, and how the
# Dagster image will wire it (native / legacy os/schedules.yml / refused). A repo that would be
# refused stops the deploy here; the schedule count is recorded so the rollout can be checked.
say "dagster: domain repo layouts (read-only)"
bash scripts/lib/dagster-layout-check.sh layout "$CTX" "$NS" || { echo "DAGSTER_LAYOUT_REFUSED — a domain's data/dagster/definitions.py does not match os/generated.yml"; exit 1; }
DAGSTER_SCHEDULES_BEFORE=$(bash scripts/lib/dagster-layout-check.sh schedules "$CTX" "$NS") \
  || { echo "DAGSTER_SCHEDULES_UNREADABLE — cannot record the schedule count before the upgrade"; exit 1; }
echo "   dagster schedules before the upgrade: $DAGSTER_SCHEDULES_BEFORE"

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
INSTALL_ARGS=()
[ "$DEPLOY_ENV" != dev ] || INSTALL_ARGS=(--install --create-namespace)
helm --kube-context "$CTX" upgrade "${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"}" "$REL" "$CHART" -n "$NS" -f "$VALUES" "${OVERLAY_ARGS[@]+"${OVERLAY_ARGS[@]}"}" \
  --set osUI.image.tag="$VERSION@$DIGEST" "${REPO_SET[@]+"${REPO_SET[@]}"}" "${CAP_SET[@]+"${CAP_SET[@]}"}" \
  --force-conflicts --skip-schema-validation --timeout 20m
write_record "$(revision_of)"
# No rollout restart: the image change already rolls os-ui exactly once.

say "rollout"
kubectl --context "$CTX" -n "$NS" rollout status deploy/os-ui --timeout=15m
# Docling rolls in the same upgrade; os-ui's conversions depend on it, so the deploy is not done
# until the new docling pod has passed /ready (its boot loads the table models). Skipped only when
# the chart does not deploy docling.
if kubectl --context "$CTX" -n "$NS" get deploy/docling >/dev/null 2>&1; then
  kubectl --context "$CTX" -n "$NS" rollout status deploy/docling --timeout=15m
fi

# WP-49 (review N1): the code location must define at least as many schedules as before. repo-sync
# parses each domain after the new pod starts, so the count is polled for a bounded time.
if kubectl --context "$CTX" -n "$NS" get "deploy/$REL-dagster-user-deployments-sovereign" >/dev/null 2>&1; then
  kubectl --context "$CTX" -n "$NS" rollout status "deploy/$REL-dagster-user-deployments-sovereign" --timeout=15m
  after=0
  for _ in $(seq 1 ${DAGSTER_SCHEDULE_POLLS:-40}); do
    after=$(bash scripts/lib/dagster-layout-check.sh schedules "$CTX" "$NS" 2>/dev/null || echo 0)
    [ "${after:-0}" -ge "$DAGSTER_SCHEDULES_BEFORE" ] && break
    sleep "${DAGSTER_SCHEDULE_POLL_SECONDS:-15}"
  done
  bash scripts/lib/dagster-layout-check.sh compare "$DAGSTER_SCHEDULES_BEFORE" "${after:-0}" || exit 1
fi

say "verify"
kubectl --context "$CTX" -n "$NS" get pods -l app.kubernetes.io/name=os-ui \
  -o jsonpath='{range .items[*]}   {.metadata.name}  {.status.containerStatuses[0].imageID}{"\n"}{end}'
kubectl --context "$CTX" -n "$NS" get deploy os-ui \
  -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}={.value}{"\n"}{end}' \
  | grep -E '^(OS_ENABLED_TABS|EXTERNAL_CONNECTORS_ENABLED|OS_PUBLIC_URL)=' | sed 's/^/   /'
echo "   not-ready pods: $(kubectl --context "$CTX" -n "$NS" get pods --no-headers | grep -vcE 'Running|Completed')"
echo "   values file kept at $VALUES (contains secrets — do not commit)"
echo "DEPLOY_${VERSION}_OK${DEPLOY_ENV:+ env=$DEPLOY_ENV}"
