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
out=$(cd "$TMP/cs" && node "$REPO/scripts/check-structure.mjs" 2>&1); rc=$?
[ $rc -ne 0 ] && ok "check-structure fails on a '* 2' entry" || bad "check-structure fails on a '* 2' entry" "exit 0"
check "it names the rule"      "CLOUD-SYNC-DUPLICATE"   "$out"
check "it names the directory" "charts/values 2"        "$out"
check "it names the file"      "scripts/thing 2.sh"     "$out"
rm -rf "$TMP/cs/charts/values 2" "$TMP/cs/scripts/thing 2.sh"
out=$(cd "$TMP/cs" && node "$REPO/scripts/check-structure.mjs" 2>&1); rc=$?
[ $rc -eq 0 ] && ok "removing them passes again" || bad "removing them passes again" "$out"

echo "== the workflow parses, and the smoke matches deploy.sh byte-for-byte"
for wf in .github/workflows/*.yml; do
  python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" "$wf" \
    && ok "YAML parses: $wf" || bad "YAML parses: $wf"
done
# The one line that must never drift: the worker smoke. deploy.sh is the original.
smoke=$(grep -F "register('./worker/resolve-hook.mjs'" scripts/deploy.sh | sed 's/^ *//;s/ *\\$//')
grep -qF "$smoke" .github/workflows/build-images.yml \
  && ok "the CI worker smoke is deploy.sh's, verbatim" \
  || bad "the CI worker smoke is deploy.sh's, verbatim" "it has drifted — re-copy it from scripts/deploy.sh"

echo
echo "deploy-from-registry.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
echo "DEPLOY_FROM_REGISTRY_TESTS_OK"
