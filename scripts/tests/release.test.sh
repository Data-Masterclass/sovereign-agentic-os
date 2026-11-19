#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# release.test.sh — scripts/release.sh against fakes: no GitHub, no cluster, no network.
# =============================================================================
#   bash scripts/tests/release.test.sh
#
# Each case builds a throwaway "operator checkout" with a local bare repository as its `public`
# remote, so the git half is REAL git on real commits and tags (a stubbed git would only prove
# the script calls the commands it calls). gh, kubectl, helm, deploy.sh and smoke-test.sh are
# stubs that log their arguments: gh answers the workflow-run query from a file per branch, so
# a test decides what CI "said". check-structure.mjs and check-consoles-not-public.mjs are stubs
# in the throwaway tree, steered by FAKE_STRUCTURE_RC / FAKE_CONSOLES_RC.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
REPO=$PWD
# shellcheck source=scripts/tests/assert.sh
. scripts/tests/assert.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid

# ---- stubs on PATH --------------------------------------------------------------------------
BIN=$TMP/bin; mkdir -p "$BIN"
cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
# gh api "repos/<r>/actions/runs?head_sha=..&event=push&branch=<b>&.." --jq ... -> runs-<b>.tsv
echo "gh $*" >> "$FAKE_LOG"
[ "${FAKE_GH_FAIL:-}" = 1 ] && exit 1
branch=$(printf '%s' "$2" | sed -n 's/.*[?&]branch=\([^&]*\).*/\1/p')
# A runs-<b>.json fixture is the raw API answer: apply the script's OWN --jq filter to it with
# jq, so the newest-run-wins sort is tested too. A runs-<b>.tsv is the already-filtered answer.
if [ -f "$FAKE_DIR/runs-$branch.json" ]; then jq -r "$4" "$FAKE_DIR/runs-$branch.json"; exit; fi
cat "$FAKE_DIR/runs-$branch.tsv" 2>/dev/null || true
STUB
cat > "$BIN/kubectl" <<'STUB'
#!/usr/bin/env bash
echo "kubectl $*" >> "$FAKE_LOG"
case "$*" in *"get deploy os-ui"*) printf '%s' "${FAKE_LIVE_IMAGE:-}" ;; esac
STUB
cat > "$BIN/helm" <<'STUB'
#!/usr/bin/env bash
echo "helm $*" >> "$FAKE_LOG"
case "$*" in *history*) echo '[{"revision":414,"status":"deployed"}]' ;; esac
STUB
cat > "$BIN/deploy.sh" <<'STUB'
#!/usr/bin/env bash
echo "deploy $* overlay=${VALUES_OVERLAY:-none}" >> "$FAKE_LOG"
exit "${FAKE_DEPLOY_RC:-0}"
STUB
cat > "$BIN/smoke.sh" <<'STUB'
#!/usr/bin/env bash
echo "smoke $*" >> "$FAKE_LOG"
exit "${FAKE_SMOKE_RC:-0}"
STUB
chmod +x "$BIN"/*

# ---- a fresh operator checkout per case ------------------------------------------------------
# new_checkout — sets OP (the checkout), SHA (public/main) and resets the fakes.
new_checkout() {
  rm -rf "$TMP/case"; mkdir -p "$TMP/case"
  export FAKE_DIR=$TMP/case/fake FAKE_LOG=$TMP/case/calls.log
  mkdir -p "$FAKE_DIR"; : > "$FAKE_LOG"
  git init -q --bare "$TMP/case/public.git"
  OP=$TMP/case/op
  git init -q -b main "$OP"
  mkdir -p "$OP/scripts/lib" "$OP/os-ui"
  cp "$REPO/scripts/release.sh" "$OP/scripts/"
  cp "$REPO/scripts/lib/workflow-status.sh" "$OP/scripts/lib/"
  echo 'process.exit(Number(process.env.FAKE_STRUCTURE_RC || 0))' > "$OP/scripts/check-structure.mjs"
  echo 'process.exit(Number(process.env.FAKE_CONSOLES_RC || 0))' > "$OP/scripts/check-consoles-not-public.mjs"
  echo 'export {}' > "$OP/os-ui/a.ts"
  git -C "$OP" add -A && git -C "$OP" commit -qm init
  git -C "$OP" remote add public "$TMP/case/public.git"
  git -C "$OP" push -q public main
  SHA=$(git -C "$OP" rev-parse HEAD)
}
green_ci()    { printf 'ci.yml\tcompleted\tsuccess\tu1\nlicense-gate.yml\tcompleted\tsuccess\tu2\n' > "$FAKE_DIR/runs-main.tsv"; }
green_build() { printf 'build-images.yml\tcompleted\tsuccess\tu3\n' > "$FAKE_DIR/runs-os-ui-v$1.tsv"; }

# release <args...> — run the copy in $OP with the stubs; sets $out and $rc.
release() {
  out=$(cd "$OP" && PATH="$BIN:$PATH" WORKFLOW_POLL_SECONDS=0 RELEASE_CI_WAIT_MINUTES=0 \
        RELEASE_BUILD_WAIT_MINUTES=0 DEPLOY_SCRIPT=deploy.sh SMOKE_SCRIPT=smoke.sh \
        GH_TOKEN=ghp_FAKE_TOKEN_MUST_NOT_PRINT bash scripts/release.sh "$@" 2>&1); rc=$?
}
remote_tag() { git -C "$TMP/case/public.git" rev-parse -q --verify "refs/tags/os-ui-v$1" || true; }

echo "== arguments"
new_checkout
release; rc_is "no version exits 2" 2
release --bogus 1.0.0; rc_is "unknown option exits 2" 2
release 'v1;rm'; check "a non-version is refused" "RELEASE_v1;rm_STOPPED" "$out"

echo "== --dry-run: every check, no change"
new_checkout; green_ci
git -C "$OP" reset -q --hard HEAD   # main == public/main
release --dry-run 1.0.0
rc_is "dry run exits 0" 0
check "dry run ends with DRY_RUN_OK" "RELEASE_1.0.0_DRY_RUN_OK" "$out"
check "dry run says it would tag" "would git tag os-ui-v1.0.0" "$out"
check "dry run says it would deploy" "would run deploy.sh --from-registry 1.0.0" "$out"
check "dry run says it would smoke-test" "would run smoke.sh --expect-tag 1.0.0" "$out"
holds "dry run pushes no tag" [ -z "$(remote_tag 1.0.0)" ]
absent "dry run does not deploy" "deploy --from-registry" "$(cat "$FAKE_LOG")"
absent "dry run does not smoke" "smoke " "$(cat "$FAKE_LOG")"
check "CI is asked about main for this exact SHA" "head_sha=$SHA&event=push&branch=main" "$(cat "$FAKE_LOG")"
absent "no token is printed" "ghp_FAKE_TOKEN" "$out"

echo "== --dry-run does not fast-forward"
new_checkout; green_ci
(cd "$TMP/case" && git clone -q public.git other && cd other && echo b > os-ui/b.ts && git add -A && git commit -qm b && git push -q origin main)
before=$(git -C "$OP" rev-parse HEAD)
release --dry-run 1.0.1
check "dry run reports the fast-forward it would do" "would fast-forward main" "$out"
holds "dry run leaves main where it was" [ "$(git -C "$OP" rev-parse HEAD)" = "$before" ]

echo "== the full release"
new_checkout; green_ci; green_build 1.1.0
(cd "$TMP/case" && git clone -q public.git other && cd other && echo b > os-ui/b.ts && git add -A && git commit -qm b && git push -q origin main)
SHA=$(git -C "$TMP/case/public.git" rev-parse main)
green_ci   # CI green for the NEW head
out=$(cd "$OP" && PATH="$BIN:$PATH" WORKFLOW_POLL_SECONDS=0 RELEASE_CI_WAIT_MINUTES=0 RELEASE_BUILD_WAIT_MINUTES=0 \
      DEPLOY_SCRIPT=deploy.sh SMOKE_SCRIPT=smoke.sh VALUES_OVERLAY=deploy/overlays/x.yaml \
      bash scripts/release.sh 1.1.0 2>&1); rc=$?
rc_is "a green release exits 0" 0
check "it ends with RELEASE_<v>_OK" "RELEASE_1.1.0_OK" "$(echo "$out" | tail -1)"
holds "local main fast-forwarded to public/main" [ "$(git -C "$OP" rev-parse HEAD)" = "$SHA" ]
holds "the tag is pushed and points at the tested SHA" [ "$(remote_tag 1.1.0)" = "$SHA" ]
check "it waits on build-images for the tag" "branch=os-ui-v1.1.0" "$(cat "$FAKE_LOG")"
check "it deploys from the registry, passing VALUES_OVERLAY" "deploy --from-registry 1.1.0 overlay=deploy/overlays/x.yaml" "$(cat "$FAKE_LOG")"
check "it smoke-tests the version" "smoke --expect-tag 1.1.0" "$(cat "$FAKE_LOG")"
check "it records the Helm revision to roll back to" "Helm revision 414" "$out"

echo "== re-running after it is live is safe"
FAKE_LIVE_IMAGE=ghcr.io/x/os-ui:1.1.0@sha256:abc; export FAKE_LIVE_IMAGE
: > "$FAKE_LOG"
release 1.1.0; unset FAKE_LIVE_IMAGE
rc_is "a re-run exits 0" 0
check "a re-run resumes on the existing tag" "already points at" "$out"
check "a re-run does not deploy again" "already runs 1.1.0" "$out"
absent "deploy.sh was not called" "deploy --from-registry" "$(cat "$FAKE_LOG")"
check "the smoke test still runs" "smoke --expect-tag 1.1.0" "$(cat "$FAKE_LOG")"

echo "== the gates stop the release"
new_checkout; green_ci; echo dirty >> "$OP/os-ui/a.ts"
release 2.0.0; check "a dirty tree stops" "STOPPED: uncommitted changes" "$out"

new_checkout; green_ci; git -C "$OP" checkout -q -b feature
release 2.0.0; check "a branch other than main stops" "STOPPED: not on branch main" "$out"

new_checkout; green_ci; echo c > "$OP/os-ui/c.ts"; git -C "$OP" add -A; git -C "$OP" commit -qm local
release 2.0.0; check "local commits not on public/main stop" "STOPPED: local main has commits" "$out"

new_checkout; green_ci
release --remote nosuch 2.0.0; check "a wrong remote name says so" "pass --remote" "$out"

new_checkout; green_ci
git -C "$OP" remote rename public upstream
release --remote upstream --dry-run 2.0.0; check "--remote names another remote" "RELEASE_2.0.0_DRY_RUN_OK" "$out"

new_checkout
printf 'ci.yml\tcompleted\tfailure\tu1\nlicense-gate.yml\tcompleted\tsuccess\tu2\n' > "$FAKE_DIR/runs-main.tsv"
release 2.0.0
check "red CI stops" "STOPPED: CI (ci.yml + license-gate.yml) is RED" "$out"
holds "red CI pushes no tag" [ -z "$(remote_tag 2.0.0)" ]

new_checkout   # no runs at all: CI never ran (the old main) or has not started
release 2.0.0; check "missing CI stops as not finished" "CI (ci.yml + license-gate.yml) has not finished" "$out"

new_checkout; printf 'ci.yml\tin_progress\tnone\tu1\nlicense-gate.yml\tcompleted\tsuccess\tu2\n' > "$FAKE_DIR/runs-main.tsv"
release 2.0.0; check "running CI stops when the wait runs out" "CI (ci.yml + license-gate.yml) has not finished" "$out"

echo "== workflow-status.sh: the NEWEST run of each workflow decides (the real --jq filter)"
# run_json <ci conclusion, older> <ci conclusion, newer> — two ci.yml runs plus a green license-gate.
run_json() {
  cat > "$FAKE_DIR/runs-main.json" <<JSON
{"workflow_runs": [
 {"path": ".github/workflows/ci.yml", "status": "completed", "conclusion": "$2", "html_url": "new", "created_at": "2026-11-19T12:00:00Z"},
 {"path": ".github/workflows/license-gate.yml", "status": "completed", "conclusion": "success", "html_url": "lg", "created_at": "2026-11-19T10:00:00Z"},
 {"path": ".github/workflows/ci.yml", "status": "completed", "conclusion": "$1", "html_url": "old", "created_at": "2026-11-19T11:00:00Z"}
]}
JSON
}
ws() { out=$(PATH="$BIN:$PATH" bash "$REPO/scripts/lib/workflow-status.sh" --sha "$SHA" --branch main \
             --workflows "ci.yml license-gate.yml" 2>&1); rc=$?; }
new_checkout
run_json success failure; ws
rc_is "an older green run under a newer red one is RED" 1
run_json failure success; ws
rc_is "a newer green re-run over an older red one is GREEN" 0
run_json success cancelled; ws
check "a cancelled newest run is RED, by name" "WORKFLOWS_RED: ci.yml=cancelled" "$out"
out=$(bash "$REPO/scripts/lib/workflow-status.sh" --sha x 2>&1); rc=$?
rc_is "missing arguments exit 2" 2

new_checkout; green_ci; FAKE_GH_FAIL=1 release 2.0.0
check "an unreadable GitHub API stops" "could not read the workflow runs" "$out"

new_checkout; green_ci; git -C "$OP" tag os-ui-v2.0.0 HEAD~0
echo x > "$OP/os-ui/x.ts"; git -C "$OP" add -A; git -C "$OP" commit -qm x; git -C "$OP" push -q public main
git -C "$OP" push -q public refs/tags/os-ui-v2.0.0
release 2.0.0; check "a tag on another commit stops" "already exists on another commit" "$out"

new_checkout; green_ci; FAKE_STRUCTURE_RC=1 release 2.0.0
check "check-structure failing stops" "STOPPED: node scripts/check-structure.mjs fails" "$out"
new_checkout; green_ci; FAKE_CONSOLES_RC=1 release 2.0.0
check "check-consoles-not-public failing stops" "STOPPED: node scripts/check-consoles-not-public.mjs fails" "$out"

new_checkout; green_ci; mkdir -p "$OP/os-ui/tabs"; echo x > "$OP/os-ui/tabs/page 2.tsx"
release 2.0.0; check "a '* 2.*' duplicate under os-ui stops" "os-ui/tabs/page 2.tsx" "$out"
new_checkout; green_ci; mkdir -p "$OP/os-ui/core 2"
release 2.0.0; check "a '* 2' directory under os-ui stops" "os-ui/core 2" "$out"

new_checkout; green_ci; printf 'build-images.yml\tcompleted\tfailure\tu3\n' > "$FAKE_DIR/runs-os-ui-v2.0.0.tsv"
release 2.0.0
check "a red image build stops" "STOPPED: the image build (build-images.yml) is RED" "$out"
absent "a red image build deploys nothing" "deploy --from-registry" "$(cat "$FAKE_LOG")"

new_checkout; green_ci; green_build 2.0.0; FAKE_DEPLOY_RC=1 release 2.0.0
check "a failed deploy stops" "STOPPED: deploy.sh failed" "$out"
absent "a failed deploy is not smoke-tested" "smoke " "$(cat "$FAKE_LOG")"

new_checkout; green_ci; green_build 2.0.0; FAKE_SMOKE_RC=1 release 2.0.0
check "a failed smoke test stops" "STOPPED: the smoke test failed" "$out"
check "and prints the rollback command" "rollback agentic-os 414 -n agentic-os" "$out"

finish release.test.sh || exit 1
echo "RELEASE_TESTS_OK"
