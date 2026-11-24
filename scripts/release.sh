#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# release.sh — the release gate: one commit, tested, tagged, built, deployed, smoke-tested.
# =============================================================================
#   ./scripts/release.sh [--env prod] [--dry-run] [--remote <name>] [--sha <sha>] [--no-dev-gate]
#                        [--allow-unrecoverable-conn-key] <version>
#   ./scripts/release.sh --env dev [--dry-run] [--remote <name>]       (no version: deploys main-<sha>)
#
# --env prod (THE DEFAULT) is the production release below. --env dev runs gates 1, 3 and 4 and
# then deploys the CI-built image main-<sha> of <remote>/main to the dev cluster and smoke-tests
# it there: no tag, no build. Every merge to main already does this in .github/workflows/dev.yml;
# the dev mode is the same thing by hand. The context follows the env (scripts/lib/env-guard.sh).
#
# WHY. Releases were gated by a shell sequence typed by hand, and twice a PR merged with a red
# check went out because the sequence did not look at CI on the merged commit. This script IS
# that sequence, in order, and it stops at the first gate that is not green:
#
#   1. on `main`, no uncommitted changes to tracked files, `main` fast-forwards to <remote>/main
#   2. the tag os-ui-v<version> does not exist (or already points at this exact commit: resume)
#   3. ci.yml AND license-gate.yml passed on a push to main for this SHA (waits while running)
#   3b. prod only: dev.yml's job dev-green passed on a push to main for this SHA — the commit was
#      built, deployed to dev and smoke-tested there (docs/ops/ci-cd.md). A dev run that was
#      cancelled (a newer merge replaced it) is not green. AND the digest that run RECORDED
#      (artifact dev-tested-digest, scripts/lib/dev-digest.sh) is the only digest that may reach
#      production: main-<sha> must still resolve to it (MAIN_TAG_MOVED otherwise), the promotion
#      copies that digest, and deploy.sh refuses any other (EXPECT_DIGEST). --no-dev-gate skips
#      3b for a LOCAL run while dev does not exist yet; it is refused when CI or GITHUB_ACTIONS is set.
#
# --phase all|check|promote|deploy (default all). The prod workflow runs the three parts in three
# jobs so that no job holds both a write token and a kubeconfig or `npm ci`:
#   check    gates 1-5 + 3b, read-only (needs npm dependencies for the capacity gate)
#   promote  gates 1-3b again (API only), then 6: the tag and the promotion of the dev digest
#   deploy   gates 1-3b again (API only), then 7-8 with EXPECT_DIGEST
#   4. node scripts/check-structure.mjs and node scripts/check-consoles-not-public.mjs pass, and
#      the capacity gate (scripts/check-capacity.mjs, WP-47) finds the rendered chart within the
#      node budget in charts/sovereign-agentic-os/capacity.yaml (run with CI=true: no skip)
#   5. no cloud-sync duplicate (`* 2`, `* 2.*`) anywhere under os-ui/
#   5b. (production deploy, phases deploy and all) the GATEWAY PARITY gate: dev's and production's live
#      LiteLLM catalogs (models, provider model, api_base, limits, prices, supports_* flags, role aliases)
#      are the same — scripts/check-gateway-parity-live.mjs, read-only, never a key. Needs BOTH clusters
#      (DEV_KUBECONFIG / PROD_KUBECONFIG or KUBECONFIG; in prod.yml the DEV_PARITY_KUBECONFIG secret). Dev
#      unreachable or a difference → the release STOPS, naming it. `--no-gateway-parity` skips the gate
#      explicitly (printed in the release output; use it only after running the check by hand).
#   6. tag the SHA and push the tag; wait for build-images.yml to pass for it. build-images.yml
#      does not REBUILD when dev already has main-<sha>: it gives that same digest the version tag.
#      With RELEASE_PROMOTE_IMAGE=1 (the prod workflow, whose tag push starts no other workflow)
#      this script gives the tag itself (scripts/lib/promote-image.sh) and checks the digest.
#   7. ./scripts/deploy.sh --from-registry <version>  (VALUES_OVERLAY is passed through)
#      — skipped when os-ui already runs <version>, so a re-run after a smoke failure is safe
#   8. ./scripts/smoke-test.sh --expect-tag <version>
#
# The last line is always one of:
#   RELEASE_<version>_OK                 every step passed
#   RELEASE_<version>_DRY_RUN_OK         --dry-run: every check passed; nothing was changed
#   RELEASE_<version>_STOPPED: <reason>  the first gate that failed, and what to do
#
# --allow-unrecoverable-conn-key (or ALLOW_UNRECOVERABLE_CONN_KEY=1) reaches deploy.sh and smoke-test.sh:
# the smoke test FAILS a prod release whose connection credentials could not be recovered after a restore
# (builtin master key without a confirmed recovery key), and deploy.sh refuses an ESO key wiring with no
# ExternalSecret (docs/ops/connection-keys.md).
#
# --dry-run runs every CHECK (1-5, read-only) and prints what steps 6-8 would do. It does not
# fast-forward, tag, push, deploy or wait. It never prints a secret: nothing here reads one.
#
# Environment: RELEASE_REMOTE (public — the remote's name in the operator checkout),
# RELEASE_REPO (Data-Masterclass/sovereign-agentic-os), RELEASE_CI_WAIT_MINUTES (45),
# RELEASE_BUILD_WAIT_MINUTES (60), KUBE_CONTEXT / NS / REL (as deploy.sh), VALUES_OVERLAY.
# DEPLOY_SCRIPT and SMOKE_SCRIPT replace the two scripts in tests only.
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE=${RELEASE_REMOTE:-public}
DRY_RUN=''
VERSION=''
ENV_NAME=prod
RELEASE_SHA=''
DEV_GATE=1
GATEWAY_PARITY=1
PHASE=all
DEV_DIGEST=''
IMAGE_REPO=${IMAGE_REPO:-ghcr.io/data-masterclass/sovereign-os}
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) DRY_RUN=1 ;;
    --remote)  REMOTE=${2:?--remote needs a name}; shift ;;
    --env)     ENV_NAME=${2:?--env needs dev or prod}; shift ;;
    --sha)     RELEASE_SHA=${2:?--sha needs a commit}; shift ;;
    --no-dev-gate) DEV_GATE='' ;;
    --no-gateway-parity) GATEWAY_PARITY='' ;;
    --allow-unrecoverable-conn-key) export ALLOW_UNRECOVERABLE_CONN_KEY=1 ;;
    --phase)   PHASE=${2:?--phase needs all, check, promote or deploy}; shift ;;
    -h|--help) sed -n '7,8p' "$0" | sed 's/^# //'; exit 0 ;;
    -*)        echo "release.sh: unknown option $1" >&2; exit 2 ;;
    *)         [ -z "$VERSION" ] || { echo "release.sh: unexpected argument $1" >&2; exit 2; }
               VERSION=$1 ;;
  esac
  shift
done
case $ENV_NAME in dev|prod) ;; *) echo "release.sh: --env must be dev or prod" >&2; exit 2 ;; esac
case $PHASE in all|check|promote|deploy) ;; *) echo "release.sh: --phase must be all, check, promote or deploy" >&2; exit 2 ;; esac
if [ "$ENV_NAME" = dev ]; then
  [ -z "$VERSION" ] || { echo "release.sh: --env dev takes no version (it deploys main-<sha>)" >&2; exit 2; }
  VERSION=dev
fi
[ -n "$VERSION" ] || { sed -n '7,8p' "$0" | sed 's/^# //' >&2; exit 2; }

export WORKFLOW_REPO=${RELEASE_REPO:-Data-Masterclass/sovereign-agentic-os}
if [ "$ENV_NAME" = dev ]; then
  CTX=${DEV_KUBE_CONTEXT:-$(bash scripts/lib/env-guard.sh --env dev --print-default-context)}
else
  CTX=${KUBE_CONTEXT:-$(bash scripts/lib/env-guard.sh --env prod --print-default-context)}
fi
NS=${NS:-agentic-os}
REL=${REL:-agentic-os}
DEPLOY_SCRIPT=${DEPLOY_SCRIPT:-./scripts/deploy.sh}
SMOKE_SCRIPT=${SMOKE_SCRIPT:-./scripts/smoke-test.sh}
TAG=os-ui-v$VERSION
ROLLBACK_HINT=''

say()  { printf '\n==> %s\n' "$*"; }
stop() { echo "RELEASE_${VERSION}_STOPPED: $*${ROLLBACK_HINT:+ — $ROLLBACK_HINT}"; exit 1; }
would(){ echo "   [dry-run] would $*"; }

if [ "$ENV_NAME" = prod ]; then
  case $VERSION in
    *[!A-Za-z0-9._-]* | [!0-9]*) stop "'$VERSION' is not a version (expected e.g. 0.9.18)" ;;
  esac
fi
if [ -z "$DEV_GATE" ]; then
  [ "$ENV_NAME" = prod ] || stop "--no-dev-gate applies to --env prod only"
  if [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ]; then
    stop "--no-dev-gate is refused in CI: a production release from a workflow needs a green dev run"
  fi
fi

check_checkout() {
  if [ -n "$RELEASE_SHA" ]; then check_checkout_sha; return; fi
  say "checkout: on main, clean, fast-forward to $REMOTE/main"
  [ "$(git symbolic-ref --short -q HEAD || true)" = main ] || stop "not on branch main — git checkout main"
  [ -z "$(git status --porcelain --untracked-files=no)" ] || stop "uncommitted changes to tracked files — commit or stash them"
  git fetch --quiet "$REMOTE" main || stop "git fetch $REMOTE main failed (is the remote called '$REMOTE'? pass --remote)"
  SHA=$(git rev-parse "$REMOTE/main")
  if [ "$(git rev-parse HEAD)" = "$SHA" ]; then
    echo "   main is at $REMOTE/main ${SHA:0:12}"
  elif git merge-base --is-ancestor HEAD "$SHA"; then
    if [ -n "$DRY_RUN" ]; then would "fast-forward main to ${SHA:0:12}"
    else git merge --ff-only --quiet "$SHA"; echo "   fast-forwarded main to ${SHA:0:12}"; fi
  else
    stop "local main has commits that are not on $REMOTE/main — push them through a PR, or reset main"
  fi
}

# --sha <sha>: release THIS commit of main rather than main's head (the prod workflow releases the
# commit that passed dev while main may have moved on). The checkout must BE that commit (the
# chart deployed is the working tree), it must be clean, and it must be on <remote>/main.
check_checkout_sha() {
  say "checkout: commit $RELEASE_SHA, clean, on $REMOTE/main"
  [ -z "$(git status --porcelain --untracked-files=no)" ] || stop "uncommitted changes to tracked files — commit or stash them"
  git fetch --quiet "$REMOTE" main || stop "git fetch $REMOTE main failed (is the remote called '$REMOTE'? pass --remote)"
  SHA=$(git rev-parse -q --verify "$RELEASE_SHA^{commit}") || stop "$RELEASE_SHA is not a commit here"
  [ "$(git rev-parse HEAD)" = "$SHA" ] || stop "HEAD is not $RELEASE_SHA — git checkout $RELEASE_SHA first"
  git merge-base --is-ancestor "$SHA" "$REMOTE/main" || stop "${SHA:0:12} is not on $REMOTE/main — only merged commits are released"
  echo "   releasing ${SHA:0:12} (on $REMOTE/main)"
}

# tag_commit <where> — the commit os-ui-v<version> points at locally (local) or on the remote.
tag_commit() {
  if [ "$1" = local ]; then
    git rev-parse -q --verify "refs/tags/$TAG^{commit}" || true
  else
    # An annotated tag lists its peeled commit as `<tag>^{}`; prefer that line when present.
    git ls-remote "$REMOTE" "refs/tags/$TAG" "refs/tags/$TAG^{}" | sort -k2 | tail -1 | cut -f1
  fi
}

check_tag() {
  say "tag $TAG"
  local remote_at local_at
  remote_at=$(tag_commit remote) || stop "git ls-remote $REMOTE failed"
  local_at=$(tag_commit local)
  RESUME=''
  for at in "$remote_at" "$local_at"; do
    [ -z "$at" ] || [ "$at" = "$SHA" ] || stop "$TAG already exists on another commit (${at:0:12}) — pick a new version"
  done
  if [ -n "$remote_at" ]; then RESUME=1; echo "   $TAG already points at ${SHA:0:12}: resuming"
  else echo "   $TAG is free"; fi
}

# workflows_green <branch> <workflows> <wait minutes> <what it means>
workflows_green() {
  local rc=0
  bash scripts/lib/workflow-status.sh --sha "$SHA" --branch "$1" --workflows "$2" --wait-minutes "$3" || rc=$?
  case $rc in
    0) ;;
    1) stop "$4 is RED for ${SHA:0:12} — fix it on main through a PR, then release the new commit" ;;
    3) stop "$4 has not finished for ${SHA:0:12} — re-run this command when it has" ;;
    *) stop "could not read the workflow runs from GitHub (gh auth status?)" ;;
  esac
}

check_ci() {
  say "CI on main for ${SHA:0:12}"
  workflows_green main "ci.yml license-gate.yml" "$([ -n "$DRY_RUN" ] && echo 0 || echo "${RELEASE_CI_WAIT_MINUTES:-45}")" "CI (ci.yml + license-gate.yml)"
}

# 3b. The commit was green on dev: dev.yml (deploy + smoke + acceptance) concluded `success` on the
# push to main for this exact SHA. The same query as check_ci, so the two cannot drift.
check_dev() {
  if [ -z "$DEV_GATE" ]; then
    say "dev gate SKIPPED (--no-dev-gate, local run): this commit is NOT known to be green on dev"
    return
  fi
  say "dev environment for ${SHA:0:12} (dev.yml: deploy, smoke test, acceptance suite)"
  local rc=0
  bash scripts/lib/workflow-status.sh --sha "$SHA" --branch main --workflows "dev.yml" --require-job dev-green \
    --wait-minutes "$([ -n "$DRY_RUN" ] && echo 0 || echo "${RELEASE_DEV_WAIT_MINUTES:-${RELEASE_CI_WAIT_MINUTES:-90}}")" || rc=$?
  case $rc in
    0) ;;
    1) stop "NOT_GREEN_ON_DEV: dev.yml is RED for ${SHA:0:12} — production gets only a commit that was green on dev" ;;
    3) stop "NOT_GREEN_ON_DEV: dev.yml has not finished (or never ran) for ${SHA:0:12} — wait for it, or release a commit that passed dev" ;;
    *) stop "could not read the workflow runs from GitHub (gh auth status?)" ;;
  esac
  # The digest dev TESTED, from the dev run's own record — never from the mutable tag.
  DEV_DIGEST=$(bash scripts/lib/dev-digest.sh --sha "$SHA" | tail -1) \
    || stop "NO_DEV_DIGEST: ${DEV_DIGEST#NO_DEV_DIGEST_RECORD: } — production gets only the digest dev recorded"
  echo "   dev tested $IMAGE_REPO/os-ui@$DEV_DIGEST"
  local now
  now=$(bash scripts/lib/promote-image.sh --digest "$IMAGE_REPO/os-ui:main-$SHA" 2>/dev/null) || now=''
  [ "$now" = "$DEV_DIGEST" ] || stop "MAIN_TAG_MOVED: main-$SHA now resolves to ${now:-nothing}, but dev tested $DEV_DIGEST — the tag was overwritten; refusing"
  echo "   main-$SHA still resolves to the tested digest"
}

check_tree() {
  say "repository checks"
  node scripts/check-structure.mjs >/dev/null || stop "node scripts/check-structure.mjs fails — run it to see why"
  echo "   check-structure: ok"
  node scripts/check-consoles-not-public.mjs >/dev/null || stop "node scripts/check-consoles-not-public.mjs fails — run it to see why"
  echo "   check-consoles-not-public: ok"
  CI=true node scripts/check-capacity.mjs >/dev/null \
    || stop "node scripts/check-capacity.mjs fails — the chart does not fit the node budget; run it to see why"
  echo "   check-capacity: ok"
  local strays
  strays=$(find os-ui \( -path '*/node_modules' -o -path '*/.next' \) -prune -o \( -name '* 2' -o -name '* 2.*' \) -print)
  [ -z "$strays" ] || stop "cloud-sync duplicates under os-ui/ (delete them): $(echo "$strays" | paste -sd, -)"
  echo "   no cloud-sync duplicates under os-ui/"
}

tag_and_build() {
  say "tag, push, build"
  if [ -n "$DRY_RUN" ]; then
    [ -n "$RESUME" ] || would "git tag $TAG ${SHA:0:12} && git push $REMOTE refs/tags/$TAG"
    would "wait for build-images.yml to pass for $TAG"
    return
  fi
  if [ -z "$RESUME" ]; then
    [ -n "$(tag_commit local)" ] || git tag "$TAG" "$SHA"
    git push --quiet "$REMOTE" "refs/tags/$TAG" || stop "git push $REMOTE $TAG failed"
    echo "   pushed $TAG -> ${SHA:0:12}"
  fi
  if [ -n "${RELEASE_PROMOTE_IMAGE:-}" ]; then
    # The prod workflow: its tag push starts no other workflow, so give the dev image the version
    # tag here. Same digest, no rebuild; promote-image.sh refuses if the digests differ.
    [ -n "$DEV_DIGEST" ] || stop "RELEASE_PROMOTE_IMAGE needs the dev gate (no recorded digest)"
    bash scripts/lib/promote-image.sh "$IMAGE_REPO/os-ui@$DEV_DIGEST" "$IMAGE_REPO/os-ui:$VERSION" \
      || stop "the dev-tested digest $DEV_DIGEST could not be promoted to $VERSION"
    return
  fi
  workflows_green "$TAG" build-images.yml "${RELEASE_BUILD_WAIT_MINUTES:-60}" "the image build (build-images.yml)"
}

live_image() {
  kubectl --context "$CTX" -n "$NS" get deploy os-ui -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true
}

deploy() {
  say "deploy $VERSION"
  local image revision
  image=$(live_image)
  case $image in
    *":$VERSION" | *":$VERSION@"*)
      echo "   os-ui already runs $VERSION — not deploying again"; return ;;
  esac
  if [ -n "$DRY_RUN" ]; then
    would "run $DEPLOY_SCRIPT --env prod --from-registry $VERSION${VALUES_OVERLAY:+ (VALUES_OVERLAY=$VALUES_OVERLAY)}"
    return
  fi
  revision=$(helm --kube-context "$CTX" history "$REL" -n "$NS" --max 1 -o json 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)[-1]["revision"])' 2>/dev/null || true)
  [ -z "$revision" ] || ROLLBACK_HINT="to go back: helm --kube-context $CTX rollback $REL $revision -n $NS (see docs/ops/releasing.md)"
  echo "   live before: ${image:-unknown}, Helm revision ${revision:-unknown}"
  EXPECT_DIGEST=$DEV_DIGEST "$DEPLOY_SCRIPT" --env prod --from-registry "$VERSION" || stop "deploy.sh failed — read its output above"
}

deploy_dev() {
  local tag=main-$SHA
  say "deploy $tag to dev ($CTX)"
  VERSION=$tag
  if [ -n "$DRY_RUN" ]; then would "run $DEPLOY_SCRIPT --env dev --from-registry $tag"; return; fi
  "$DEPLOY_SCRIPT" --env dev --from-registry "$tag" || stop "deploy.sh --env dev failed — read its output above"
}

# 5b. Dev and production serve the same gateway models (models are created by hand in each LiteLLM; parity is
# checked, not enforced). Before the deploy, so a difference changes nothing on production.
check_gateway_parity() {
  say "gateway parity: dev and prod serve the same models (scripts/check-gateway-parity-live.mjs)"
  if [ -z "$GATEWAY_PARITY" ]; then
    echo "   !!! SKIPPED (--no-gateway-parity): dev and prod gateway catalogs were NOT compared by this release"; return
  fi
  if [ -n "$DRY_RUN" ]; then would "run node scripts/check-gateway-parity-live.mjs"; return; fi
  local out rc
  set +e
  out=$(node scripts/check-gateway-parity-live.mjs 2>&1); rc=$?
  set -e
  printf '%s\n' "$out" | sed 's/^/   /'
  case $rc in
    0) ;;
    2) stop "the gateway parity check could not read both environments (dev unreachable?) — give it DEV_KUBECONFIG and PROD_KUBECONFIG (prod.yml: the DEV_PARITY_KUBECONFIG secret), or run it by hand and pass --no-gateway-parity" ;;
    *) stop "dev and prod gateway catalogs differ (listed above) — create or fix the model by hand in the environment that is behind (docs/components/litellm.md \"Owner runbook\"), or pass --no-gateway-parity knowingly" ;;
  esac
}

smoke() {
  say "smoke test"
  if [ -n "$DRY_RUN" ]; then would "run $SMOKE_SCRIPT --env $ENV_NAME --expect-tag $VERSION"; return; fi
  "$SMOKE_SCRIPT" --env "$ENV_NAME" --expect-tag "$VERSION" || stop "the smoke test failed on the live release"
}

if [ "$ENV_NAME" = dev ]; then
  check_checkout
  check_ci
  check_tree
  deploy_dev
  smoke
  if [ -n "$DRY_RUN" ]; then echo "RELEASE_dev_DRY_RUN_OK $VERSION"; else echo "RELEASE_dev_OK $VERSION"; fi
  exit 0
fi
case $PHASE in
  check)
    check_checkout; check_tag; check_ci; check_dev; check_tree
    echo "RELEASE_${VERSION}_CHECKED sha=$SHA digest=${DEV_DIGEST:-none}"; exit 0 ;;
  promote)
    check_checkout; check_tag; check_ci; check_dev; tag_and_build
    echo "RELEASE_${VERSION}_PROMOTED sha=$SHA digest=${DEV_DIGEST:-none}"; exit 0 ;;
  deploy)
    check_checkout; check_ci; check_dev; check_gateway_parity; deploy; smoke ;;
  all)
    check_checkout; check_tag; check_ci; check_dev; check_tree; check_gateway_parity; tag_and_build; deploy; smoke ;;
esac
if [ -n "$DRY_RUN" ]; then echo "RELEASE_${VERSION}_DRY_RUN_OK"; else echo "RELEASE_${VERSION}_OK"; fi
