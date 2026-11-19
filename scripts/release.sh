#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# release.sh — the release gate: one commit, tested, tagged, built, deployed, smoke-tested.
# =============================================================================
#   ./scripts/release.sh [--dry-run] [--remote <name>] <version>      e.g. 0.9.18
#
# WHY. Releases were gated by a shell sequence typed by hand, and twice a PR merged with a red
# check went out because the sequence did not look at CI on the merged commit. This script IS
# that sequence, in order, and it stops at the first gate that is not green:
#
#   1. on `main`, no uncommitted changes to tracked files, `main` fast-forwards to <remote>/main
#   2. the tag os-ui-v<version> does not exist (or already points at this exact commit: resume)
#   3. ci.yml AND license-gate.yml passed on a push to main for this SHA (waits while running)
#   4. node scripts/check-structure.mjs and node scripts/check-consoles-not-public.mjs pass
#   5. no cloud-sync duplicate (`* 2`, `* 2.*`) anywhere under os-ui/
#   6. tag the SHA and push the tag; wait for build-images.yml to pass for it
#   7. ./scripts/deploy.sh --from-registry <version>  (VALUES_OVERLAY is passed through)
#      — skipped when os-ui already runs <version>, so a re-run after a smoke failure is safe
#   8. ./scripts/smoke-test.sh --expect-tag <version>
#
# The last line is always one of:
#   RELEASE_<version>_OK                 every step passed
#   RELEASE_<version>_DRY_RUN_OK         --dry-run: every check passed; nothing was changed
#   RELEASE_<version>_STOPPED: <reason>  the first gate that failed, and what to do
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
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) DRY_RUN=1 ;;
    --remote)  REMOTE=${2:?--remote needs a name}; shift ;;
    -h|--help) sed -n '7p' "$0" | sed 's/^# //'; exit 0 ;;
    -*)        echo "release.sh: unknown option $1" >&2; exit 2 ;;
    *)         [ -z "$VERSION" ] || { echo "release.sh: unexpected argument $1" >&2; exit 2; }
               VERSION=$1 ;;
  esac
  shift
done
[ -n "$VERSION" ] || { sed -n '7p' "$0" | sed 's/^# //' >&2; exit 2; }

export WORKFLOW_REPO=${RELEASE_REPO:-Data-Masterclass/sovereign-agentic-os}
CTX=${KUBE_CONTEXT:-dmagenticos}
NS=${NS:-agentic-os}
REL=${REL:-agentic-os}
DEPLOY_SCRIPT=${DEPLOY_SCRIPT:-./scripts/deploy.sh}
SMOKE_SCRIPT=${SMOKE_SCRIPT:-./scripts/smoke-test.sh}
TAG=os-ui-v$VERSION
ROLLBACK_HINT=''

say()  { printf '\n==> %s\n' "$*"; }
stop() { echo "RELEASE_${VERSION}_STOPPED: $*${ROLLBACK_HINT:+ — $ROLLBACK_HINT}"; exit 1; }
would(){ echo "   [dry-run] would $*"; }

case $VERSION in
  *[!A-Za-z0-9._-]* | [!0-9]*) stop "'$VERSION' is not a version (expected e.g. 0.9.18)" ;;
esac

check_checkout() {
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

check_tree() {
  say "repository checks"
  node scripts/check-structure.mjs >/dev/null || stop "node scripts/check-structure.mjs fails — run it to see why"
  echo "   check-structure: ok"
  node scripts/check-consoles-not-public.mjs >/dev/null || stop "node scripts/check-consoles-not-public.mjs fails — run it to see why"
  echo "   check-consoles-not-public: ok"
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
    would "run $DEPLOY_SCRIPT --from-registry $VERSION${VALUES_OVERLAY:+ (VALUES_OVERLAY=$VALUES_OVERLAY)}"
    return
  fi
  revision=$(helm --kube-context "$CTX" history "$REL" -n "$NS" --max 1 -o json 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)[-1]["revision"])' 2>/dev/null || true)
  [ -z "$revision" ] || ROLLBACK_HINT="to go back: helm --kube-context $CTX rollback $REL $revision -n $NS (see docs/ops/releasing.md)"
  echo "   live before: ${image:-unknown}, Helm revision ${revision:-unknown}"
  "$DEPLOY_SCRIPT" --from-registry "$VERSION" || stop "deploy.sh failed — read its output above"
}

smoke() {
  say "smoke test"
  if [ -n "$DRY_RUN" ]; then would "run $SMOKE_SCRIPT --expect-tag $VERSION"; return; fi
  "$SMOKE_SCRIPT" --expect-tag "$VERSION" || stop "the smoke test failed on the live release"
}

check_checkout
check_tag
check_ci
check_tree
tag_and_build
deploy
smoke
if [ -n "$DRY_RUN" ]; then echo "RELEASE_${VERSION}_DRY_RUN_OK"; else echo "RELEASE_${VERSION}_OK"; fi
