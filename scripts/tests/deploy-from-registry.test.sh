#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# deploy-from-registry.test.sh — the registry deploy mode and the widened
# conflict-copy check, tested without Docker, without a network and without a cluster.
# =============================================================================
#   bash scripts/tests/deploy-from-registry.test.sh
#
# WHY A SHELL TEST. `deploy.sh --from-registry` touches a production deploy path, and the only
# parts of it a unit suite could ever see are the ones that do not matter. So the two things
# that DO matter are asserted here: that the digest probe is pluggable and that `--verify-only`
# exits BEFORE the first `kubectl` (which is the whole reason the mode is testable at all), and
# that a bad or missing tag refuses rather than deploying something unpinned.
#
# The conflict-copy half runs the REAL `os-ui/scripts/gate.sh` inside a throwaway tree rather
# than against the repo: a gate run in the working tree would race the other sessions that run
# it. In the throwaway tree the gate exits at the conflict check (fail case) or prints
# `check-conflict-copies: ok` and then dies on the missing chart scripts (pass case) — so this
# asserts on that one line, which is exactly the line under test.
set -uo pipefail
cd "$(dirname "$0")/../.."
REPO=$PWD
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL %s\n     %s\n' "$1" "${2-}"; }
check(){ # check <name> <expected-substring> <actual>
  case $3 in *"$2"*) ok "$1" ;; *) bad "$1" "expected to contain: $2" ;; esac
}

echo "== deploy.sh --help"
out=$(bash scripts/deploy.sh --help 2>&1); rc=$?
[ $rc -eq 0 ] && ok "--help exits 0" || bad "--help exits 0" "exit $rc"
check "--help names --from-registry" "--from-registry" "$out"
check "--help names --verify-only"   "--verify-only"   "$out"
check "--help names IMAGE_REPO"      "IMAGE_REPO"      "$out"
check "--help names SKIP_BUILD"      "SKIP_BUILD"      "$out"
check "--help names both options"    "ghcr.io/data-masterclass/sovereign-os" "$out"

echo "== argument handling"
out=$(bash scripts/deploy.sh 2>&1); rc=$?
[ $rc -eq 2 ] && ok "no version exits 2" || bad "no version exits 2" "exit $rc"
out=$(bash scripts/deploy.sh --nonsense 0.0.1 2>&1); rc=$?
[ $rc -eq 2 ] && ok "unknown flag exits 2" || bad "unknown flag exits 2" "exit $rc"
check "unknown flag says so" "unknown option --nonsense" "$out"

echo "== --verify-only against a fake registry (DEPLOY_REGISTRY_PROBE)"
DIG=sha256:1111111111111111111111111111111111111111111111111111111111111111
probe=$TMP/probe.sh
printf '#!/usr/bin/env bash\necho "%s"\necho "probed $1" >> "%s"\n' "$DIG" "$TMP/probed" > "$probe"
chmod +x "$probe"

out=$(DEPLOY_REGISTRY_PROBE=$probe bash scripts/deploy.sh --verify-only 9.9.9-test 2>&1); rc=$?
[ $rc -eq 0 ] && ok "--verify-only exits 0" || bad "--verify-only exits 0" "exit $rc: $out"
check "--verify-only prints the default ref" \
  "ghcr.io/aborek/sovereign-os/os-ui:9.9.9-test" "$out"
check "--verify-only prints the probed digest" "$DIG" "$out"
check "--verify-only reports VERIFY_<version>_OK" "VERIFY_9.9.9-test_OK" "$out"
# The point of --verify-only: it stops before anything can reach a cluster.
case $out in *kubectl*|*"context "*) bad "--verify-only touches no cluster" "$out" ;; *) ok "--verify-only touches no cluster" ;; esac

echo "== IMAGE_REPO moves the reference"
out=$(IMAGE_REPO=ghcr.io/data-masterclass/sovereign-os DEPLOY_REGISTRY_PROBE=$probe \
      bash scripts/deploy.sh --verify-only 9.9.9-test 2>&1)
check "IMAGE_REPO changes the ref" "ghcr.io/data-masterclass/sovereign-os/os-ui:9.9.9-test" "$out"

echo "== IMAGE_FROM_REGISTRY / IMAGE_VERIFY_ONLY are the env twins of the flags"
out=$(IMAGE_FROM_REGISTRY=1 IMAGE_VERIFY_ONLY=1 DEPLOY_REGISTRY_PROBE=$probe \
      bash scripts/deploy.sh 9.9.9-test 2>&1); rc=$?
[ $rc -eq 0 ] && ok "env vars behave as the flags" || bad "env vars behave as the flags" "exit $rc: $out"

echo "== a tag that is not there must refuse, not deploy"
printf '#!/usr/bin/env bash\nexit 1\n' > "$TMP/missing.sh"; chmod +x "$TMP/missing.sh"
out=$(DEPLOY_REGISTRY_PROBE=$TMP/missing.sh bash scripts/deploy.sh --verify-only 0.0.0 2>&1); rc=$?
[ $rc -ne 0 ] && ok "a failing probe refuses" || bad "a failing probe refuses" "exit 0: $out"
check "a failing probe names the reason" "IMAGE_NOT_IN_REGISTRY" "$out"

printf '#!/usr/bin/env bash\necho "not-a-digest"\n' > "$TMP/garbage.sh"; chmod +x "$TMP/garbage.sh"
out=$(DEPLOY_REGISTRY_PROBE=$TMP/garbage.sh bash scripts/deploy.sh --verify-only 0.0.0 2>&1); rc=$?
[ $rc -ne 0 ] && ok "a non-sha256 answer refuses" || bad "a non-sha256 answer refuses" "exit 0: $out"

echo "== the gate's conflict-copy check, in a throwaway tree"
mkdir -p "$TMP/tree/os-ui/scripts"
cp os-ui/scripts/gate.sh "$TMP/tree/os-ui/scripts/gate.sh"
mkdir -p "$TMP/tree/docs/selftest 2"            # a DIRECTORY — the case that was missed
echo x > "$TMP/tree/docs/selftest 2/inner.ts"
mkdir -p "$TMP/tree/os-ui/node_modules 2/pkg"   # a duplicated node_modules — must not be walked
echo x > "$TMP/tree/os-ui/node_modules 2/pkg/index.js"
echo x > "$TMP/tree/os-ui/stray 2.ts"           # the shape the old check already caught
ln -s "$TMP/tree/os-ui/stray 2.ts" "$TMP/tree/os-ui/link 2"   # a SYMLINK

out=$(cd "$TMP/tree" && bash os-ui/scripts/gate.sh 2>&1); rc=$?
[ $rc -ne 0 ] && ok "a '* 2' entry fails the gate" || bad "a '* 2' entry fails the gate" "exit 0"
check "the directory is reported"  "docs/selftest 2"            "$out"
check "the stray file is reported" "os-ui/stray 2.ts"           "$out"
check "the symlink is reported"    "os-ui/link 2"               "$out"
check "a duplicated node_modules is reported" "os-ui/node_modules 2" "$out"
case $out in
  *"node_modules 2/pkg/index.js"*) bad "a matched directory is not descended into" "inner path listed" ;;
  *"selftest 2/inner.ts"*)         bad "a matched directory is not descended into" "inner path listed" ;;
  *) ok "a matched directory is not descended into" ;;
esac

rm -rf "$TMP/tree/docs/selftest 2" "$TMP/tree/os-ui/node_modules 2" \
       "$TMP/tree/os-ui/stray 2.ts" "$TMP/tree/os-ui/link 2"
out=$(cd "$TMP/tree" && bash os-ui/scripts/gate.sh 2>&1)
check "a clean tree passes the check" "check-conflict-copies: ok" "$out"

echo "== check-structure.mjs rule 7, in a throwaway tree"
# An isolated cwd: no components/, no os-ui/core|tabs (layout rules skip), no baseline file —
# so CLOUD-SYNC-DUPLICATE is the only thing that can speak.
mkdir -p "$TMP/cs/docs" "$TMP/cs/os-ui" "$TMP/cs/charts" "$TMP/cs/scripts"
out=$(cd "$TMP/cs" && node "$REPO/scripts/check-structure.mjs" 2>&1); rc=$?
[ $rc -eq 0 ] && ok "a clean tree passes check-structure" || bad "a clean tree passes check-structure" "$out"
mkdir -p "$TMP/cs/charts/values 2"
echo x > "$TMP/cs/scripts/thing 2.sh"
# CI=true: rule 7 is a hard failure there and only a warning locally (review H1b, asserted
# in both modes further down).
out=$(cd "$TMP/cs" && CI=true node "$REPO/scripts/check-structure.mjs" 2>&1); rc=$?
[ $rc -ne 0 ] && ok "check-structure fails on a '* 2' entry" || bad "check-structure fails on a '* 2' entry" "exit 0"
check "it names the rule"      "CLOUD-SYNC-DUPLICATE"   "$out"
check "it names the directory" "charts/values 2"        "$out"
check "it names the file"      "scripts/thing 2.sh"     "$out"
rm -rf "$TMP/cs/charts/values 2" "$TMP/cs/scripts/thing 2.sh"
out=$(cd "$TMP/cs" && node "$REPO/scripts/check-structure.mjs" 2>&1); rc=$?
[ $rc -eq 0 ] && ok "removing them passes again" || bad "removing them passes again" "$out"

echo "== review H1a: the gate does not police other sessions' worktrees"
# `.claude/worktrees/*` holds OTHER sessions' checkouts. Walking into them reported ~28 copied
# monaco duplicates as strays in this tree — a failure nobody here could fix.
mkdir -p "$TMP/tree/.claude/worktrees/w/os-ui/public/monaco 2/vs"
echo x > "$TMP/tree/.claude/worktrees/w/os-ui/public/monaco 2/vs/loader.js"
out=$(cd "$TMP/tree" && bash os-ui/scripts/gate.sh 2>&1)
check "a clean tree still passes with .claude present" "check-conflict-copies: ok" "$out"
case $out in *".claude"*) bad "the gate ignores .claude/worktrees" "reported a sibling worktree" ;; *) ok "the gate ignores .claude/worktrees" ;; esac

echo "== review H1b: rule 7 is hard in CI, a warning locally"
# check-structure is the PostToolUse hook, so a stray dropped by cloud sync mid-edit must not
# wedge every tool call — but CI must never let one through.
mkdir -p "$TMP/cs/os-ui/core 2"
out=$(cd "$TMP/cs" && node "$REPO/scripts/check-structure.mjs" 2>&1); rc=$?
[ $rc -eq 0 ] && ok "locally a duplicate does NOT fail" || bad "locally a duplicate does NOT fail" "exit $rc"
check "locally it warns"             "WARNING"          "$out"
check "locally it prints the path"   "os-ui/core 2"     "$out"
check "locally it says CI is hard"   "hard failure in CI" "$out"
out=$(cd "$TMP/cs" && CI=true node "$REPO/scripts/check-structure.mjs" 2>&1); rc=$?
[ $rc -ne 0 ] && ok "in CI the same duplicate fails" || bad "in CI the same duplicate fails" "exit 0"
check "in CI it names the rule" "CLOUD-SYNC-DUPLICATE" "$out"
rm -rf "$TMP/cs/os-ui/core 2"

echo "== review L12: docs/ keeps prose, refuses source and directories"
echo x > "$TMP/cs/docs/design 2.md"
out=$(cd "$TMP/cs" && CI=true node "$REPO/scripts/check-structure.mjs" 2>&1); rc=$?
[ $rc -eq 0 ] && ok "docs/'design 2.md' is not a failure" || bad "docs/'design 2.md' is not a failure" "$out"
echo x > "$TMP/cs/docs/helper 2.mjs"
out=$(cd "$TMP/cs" && CI=true node "$REPO/scripts/check-structure.mjs" 2>&1); rc=$?
[ $rc -ne 0 ] && ok "docs/'helper 2.mjs' IS a failure" || bad "docs/'helper 2.mjs' IS a failure" "exit 0"
rm -f "$TMP/cs/docs/helper 2.mjs"
mkdir -p "$TMP/cs/docs/plans 2"
out=$(cd "$TMP/cs" && CI=true node "$REPO/scripts/check-structure.mjs" 2>&1); rc=$?
[ $rc -ne 0 ] && ok "docs/'plans 2/' IS a failure" || bad "docs/'plans 2/' IS a failure" "exit 0"
rm -rf "$TMP/cs/docs/plans 2" "$TMP/cs/docs/design 2.md"

echo "== review M2: the build context excludes directories too"
for pat in '**/* 2.*' '**/* 2' '**/* 2/'; do
  grep -qxF "$pat" .dockerignore && ok ".dockerignore has $pat" || bad ".dockerignore has $pat"
done

echo "== review M3: a split-namespace deploy is refused"
vals=$TMP/vals.yaml
printf 'osUI:\n  image:\n    repository: ghcr.io/data-masterclass/sovereign-os/os-ui\n    tag: "0.9.5"\n' > "$vals"
out=$(python3 scripts/lib/check-image-repo.py "$vals" ghcr.io/aborek/sovereign-os/os-ui 2>&1); rc=$?
[ $rc -ne 0 ] && ok "a mismatched repository refuses" || bad "a mismatched repository refuses" "exit 0"
check "it names the failure"      "IMAGE_REPOSITORY_MISMATCH" "$out"
check "it names what the release pulls" "ghcr.io/data-masterclass/sovereign-os/os-ui" "$out"
check "it offers the IMAGE_REPO fix"    "IMAGE_REPO=ghcr.io/data-masterclass/sovereign-os" "$out"
out=$(python3 scripts/lib/check-image-repo.py "$vals" ghcr.io/data-masterclass/sovereign-os/os-ui 2>&1); rc=$?
[ $rc -eq 0 ] && ok "a matching repository passes" || bad "a matching repository passes" "$out"
printf 'osUI:\n  enabled: true\n' > "$TMP/norepo.yaml"
out=$(python3 scripts/lib/check-image-repo.py "$TMP/norepo.yaml" ghcr.io/aborek/sovereign-os/os-ui 2>&1); rc=$?
[ $rc -eq 0 ] && ok "no repository in the values passes" || bad "no repository in the values passes" "$out"
out=$(python3 scripts/lib/check-image-repo.py "$TMP/absent.yaml" ghcr.io/aborek/sovereign-os/os-ui 2>&1); rc=$?
[ $rc -eq 0 ] && ok "an absent values file passes" || bad "an absent values file passes" "$out"
# deploy.sh must actually call it, and only when IMAGE_REPO was not given.
grep -q 'check-image-repo.py' scripts/deploy.sh \
  && ok "deploy.sh runs the repository check" || bad "deploy.sh runs the repository check"

echo "== review M4/L8/L9: the curl fallback classifies status, and keeps the token out of argv"
fake=$TMP/fakecurl/curl
mkdir -p "$TMP/fakecurl"
cat > "$fake" <<'FAKE'
#!/usr/bin/env bash
# A stand-in for curl: records argv and stdin, answers with $FAKE_CODE.
printf '%s\n' "$*" >> "$FAKE_ARGV"
cat >> "$FAKE_STDIN"
hdr=; url=; prev=
for a in "$@"; do
  [ "$prev" = "-D" ] && hdr=$a
  case $a in https://*) url=$a ;; esac
  prev=$a
done
case $url in
  */token\?*)
    if [ "${FAKE_TOKEN_DENY:-}" = 1 ]
      then echo '{"errors":[{"code":"DENIED"}]}'
      else echo '{"token":"faketoken"}'
    fi ;;
  *)
    if [ "${FAKE_CODE:-200}" = 200 ] && [ -n "$hdr" ]; then
      printf 'HTTP/2 200\r\ndocker-content-digest: sha256:%s\r\n\r\n' \
        "2222222222222222222222222222222222222222222222222222222222222222" > "$hdr"
    elif [ -n "$hdr" ]; then
      printf 'HTTP/2 %s\r\n\r\n' "${FAKE_CODE}" > "$hdr"
    fi
    printf '%s' "${FAKE_CODE:-200}" ;;
esac
FAKE
chmod +x "$fake"
# No gh on PATH: the probe must never touch the owner's real token in a test.
fakepath=$TMP/fakecurl:/usr/bin:/bin
export FAKE_ARGV=$TMP/argv.log FAKE_STDIN=$TMP/stdin.log
: > "$FAKE_ARGV"; : > "$FAKE_STDIN"

out=$(PATH=$fakepath REGISTRY_CURL=curl FAKE_CODE=200 \
      bash scripts/lib/registry-digest.sh ghcr.io/x/y/os-ui:1.0.0 2>&1); rc=$?
[ $rc -eq 0 ] && ok "200 yields the digest" || bad "200 yields the digest" "exit $rc: $out"
check "the digest is the header's" "sha256:2222222222222222222222222222222222222222222222222222222222222222" "$out"
check "both calls carry --max-time 30" "--max-time 30" "$(cat "$FAKE_ARGV")"
case $(cat "$FAKE_ARGV") in
  *faketoken*) bad "the bearer token stays out of argv" "found in argv" ;;
  *) ok "the bearer token stays out of argv" ;;
esac
check "the bearer token goes in on stdin" "faketoken" "$(cat "$FAKE_STDIN")"
check "stdin is a curl config, not a flag" 'header = "Authorization: Bearer' "$(cat "$FAKE_STDIN")"

for code in 401 403; do
  out=$(PATH=$fakepath REGISTRY_CURL=curl FAKE_CODE=$code \
        bash scripts/lib/registry-digest.sh ghcr.io/x/y/os-ui:1.0.0 2>&1); rc=$?
  [ $rc -ne 0 ] && ok "$code refuses" || bad "$code refuses" "exit 0"
  check "$code says not authorised"      "REGISTRY_NOT_AUTHORISED" "$out"
  check "$code names read:packages"      "read:packages"           "$out"
  case $out in *REGISTRY_TAG_NOT_FOUND*) bad "$code is not reported as a 404" "$out" ;; *) ok "$code is not reported as a 404" ;; esac
done

out=$(PATH=$fakepath REGISTRY_CURL=curl FAKE_CODE=404 \
      bash scripts/lib/registry-digest.sh ghcr.io/x/y/os-ui:1.0.0 2>&1); rc=$?
[ $rc -ne 0 ] && ok "404 refuses" || bad "404 refuses" "exit 0"
check "404 says the tag is not there" "REGISTRY_TAG_NOT_FOUND" "$out"
case $out in *read:packages*) bad "404 is not reported as an auth problem" "$out" ;; *) ok "404 is not reported as an auth problem" ;; esac

out=$(PATH=$fakepath REGISTRY_CURL=curl FAKE_TOKEN_DENY=1 \
      bash scripts/lib/registry-digest.sh ghcr.io/x/y/os-ui:1.0.0 2>&1); rc=$?
[ $rc -ne 0 ] && ok "a denied pull token refuses" || bad "a denied pull token refuses" "exit 0"
check "a denied token says not authorised" "REGISTRY_NOT_AUTHORISED" "$out"

out=$(PATH=$fakepath REGISTRY_CURL=curl FAKE_CODE=500 \
      bash scripts/lib/registry-digest.sh ghcr.io/x/y/os-ui:1.0.0 2>&1); rc=$?
[ $rc -ne 0 ] && ok "a 500 refuses" || bad "a 500 refuses" "exit 0"
check "a 500 names its status" "REGISTRY_HTTP_500" "$out"

echo "== the workflow parses, and the smoke matches deploy.sh byte-for-byte"
for wf in .github/workflows/*.yml; do
  python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" "$wf" \
    && ok "YAML parses: $wf" || bad "YAML parses: $wf"
done
# review L6 / L7 / L10: the pushed image is the smoked one, the job cannot hang for an hour,
# and the registry login user can be pinned to the PAT's owner.
wf=.github/workflows/build-images.yml
python3 -c "
import sys, yaml
j = yaml.safe_load(open('$wf'))['jobs']['build']
assert j['timeout-minutes'] == 45, j.get('timeout-minutes')
names = [s.get('name','') for s in j['steps']]
assert any('smoked' in n for n in names), names
" && ok "the build job has timeout-minutes: 45 and the smoked==pushed step" \
  || bad "the build job has timeout-minutes: 45 and the smoked==pushed step"
grep -q 'vars.IMAGE_REGISTRY_USER' "$wf" \
  && ok "the login user can be pinned (IMAGE_REGISTRY_USER)" || bad "the login user can be pinned (IMAGE_REGISTRY_USER)"
grep -q 'IMAGE_REGISTRY_USER' CONTRIBUTING.md \
  && ok "CONTRIBUTING documents IMAGE_REGISTRY_USER" || bad "CONTRIBUTING documents IMAGE_REGISTRY_USER"
# review M5: a dockerconfigjson secret is keyed by HOST, so "re-point the pull secret" was wrong.
grep -q 're-pointed' CONTRIBUTING.md \
  && bad "CONTRIBUTING no longer says the pull secret is re-pointed" || ok "CONTRIBUTING no longer says the pull secret is re-pointed"
grep -q 'keyed by registry \*\*host\*\*' CONTRIBUTING.md \
  && ok "CONTRIBUTING explains host-keyed pull credentials" || bad "CONTRIBUTING explains host-keyed pull credentials"
# The one line that must never drift: the worker smoke. deploy.sh is the original.
smoke=$(grep -F "register('./worker/resolve-hook.mjs'" scripts/deploy.sh | sed 's/^ *//;s/ *\\$//')
grep -qF "$smoke" .github/workflows/build-images.yml \
  && ok "the CI worker smoke is deploy.sh's, verbatim" \
  || bad "the CI worker smoke is deploy.sh's, verbatim" "it has drifted — re-copy it from scripts/deploy.sh"

echo
echo "deploy-from-registry.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
echo "DEPLOY_FROM_REGISTRY_TESTS_OK"
