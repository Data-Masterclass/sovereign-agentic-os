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
check "--help names the default namespace" "default ghcr.io/data-masterclass/sovereign-os" "$out"
check "--help names the old namespace too" "IMAGE_REPO=ghcr.io/aborek/sovereign-os" "$out"
check "--help says a local build needs push rights" "PUSH_FAILED" "$out"

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
  "ghcr.io/data-masterclass/sovereign-os/os-ui:9.9.9-test" "$out"
check "--verify-only prints the probed digest" "$DIG" "$out"
check "--verify-only reports VERIFY_<version>_OK" "VERIFY_9.9.9-test_OK" "$out"
# The point of --verify-only: it stops before anything can reach a cluster.
case $out in *kubectl*|*"context "*) bad "--verify-only touches no cluster" "$out" ;; *) ok "--verify-only touches no cluster" ;; esac

echo "== IMAGE_REPO moves the reference"
out=$(IMAGE_REPO=ghcr.io/aborek/sovereign-os DEPLOY_REGISTRY_PROBE=$probe \
      bash scripts/deploy.sh --verify-only 9.9.9-test 2>&1)
check "IMAGE_REPO changes the ref" "ghcr.io/aborek/sovereign-os/os-ui:9.9.9-test" "$out"
case $out in *data-masterclass*) bad "IMAGE_REPO leaves no trace of the default" "$out" ;; *) ok "IMAGE_REPO leaves no trace of the default" ;; esac

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
# so CLOUD-SYNC-DUPLICATE is the only thing that can speak. Every invocation states the CI
# variable explicitly (see the H1b block below for why): never inherit it from the runner.
mkdir -p "$TMP/cs/docs" "$TMP/cs/os-ui" "$TMP/cs/charts" "$TMP/cs/scripts"
out=$(cd "$TMP/cs" && env -u CI node "$REPO/scripts/check-structure.mjs" 2>&1); rc=$?
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
out=$(cd "$TMP/cs" && env -u CI node "$REPO/scripts/check-structure.mjs" 2>&1); rc=$?
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
#
# `env -u CI` / `CI=true` are BOTH explicit, and that is the point: GitHub Actions exports
# CI=true to every step, so a "local mode" case that merely omitted the variable inherited the
# runner's and ran the hard branch — these three assertions failed on the first CI run of this
# file while passing on a laptop. A test of an environment-dependent branch has to set the
# environment itself, in both directions.
mkdir -p "$TMP/cs/os-ui/core 2"
out=$(cd "$TMP/cs" && env -u CI node "$REPO/scripts/check-structure.mjs" 2>&1); rc=$?
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

echo "== review L1: the gate's docs/ arm agrees with rule 7"
# Two doors that disagree are worse than one: whichever is stricter silently becomes the rule.
# Rule 7 permits prose `notes 2.md` under docs/, so the gate must too.
mkdir -p "$TMP/tree/docs"
echo x > "$TMP/tree/docs/notes 2.md"
out=$(cd "$TMP/tree" && bash os-ui/scripts/gate.sh 2>&1)
check "docs/'notes 2.md' does not fail the gate" "check-conflict-copies: ok" "$out"
# These assert the CONFLICT-COPY message, not merely a non-zero exit: the throwaway tree has no
# chart-check scripts, so the gate exits non-zero anyway once it gets past this check — a bare
# `rc != 0` would pass for the wrong reason.
echo x > "$TMP/tree/docs/helper 2.mjs"
out=$(cd "$TMP/tree" && bash os-ui/scripts/gate.sh 2>&1)
check "docs/'helper 2.mjs' DOES fail the gate" "docs/helper 2.mjs" "$out"
check "and it is reported as a conflict copy"  "conflict copies"   "$out"
rm -f "$TMP/tree/docs/helper 2.mjs"
mkdir -p "$TMP/tree/docs/plans 2"
out=$(cd "$TMP/tree" && bash os-ui/scripts/gate.sh 2>&1)
check "docs/'plans 2/' DOES fail the gate" "docs/plans 2" "$out"
rmdir "$TMP/tree/docs/plans 2"
# Only the TOP-LEVEL docs/ is relaxed — a nested docs/ elsewhere stays under the strict sweep,
# exactly as rule 7 scopes it.
mkdir -p "$TMP/tree/components/x/docs"
echo x > "$TMP/tree/components/x/docs/notes 2.md"
out=$(cd "$TMP/tree" && bash os-ui/scripts/gate.sh 2>&1)
check "a NESTED docs/'notes 2.md' still fails" "components/x/docs/notes 2.md" "$out"
rm -rf "$TMP/tree/components"
out=$(cd "$TMP/tree" && bash os-ui/scripts/gate.sh 2>&1)
check "the tree is clean again (prose kept)" "check-conflict-copies: ok" "$out"

echo "== review M2: the build context excludes directories too"
for pat in '**/* 2.*' '**/* 2'; do
  grep -qxF "$pat" .dockerignore && ok ".dockerignore has $pat" || bad ".dockerignore has $pat"
done
# `**/* 2/` would be redundant: a .dockerignore pattern matches a path element whether it is a
# file or a directory, and excluding a directory excludes everything under it.
grep -qxF '**/* 2/' .dockerignore \
  && bad ".dockerignore carries no redundant '**/* 2/'" || ok ".dockerignore carries no redundant '**/* 2/'"
grep -q 'would be\s*$\|redundant' .dockerignore \
  && ok ".dockerignore says why there is no third pattern" || bad ".dockerignore says why there is no third pattern"

echo "== review M3: a split-namespace deploy is refused"
vals=$TMP/vals.yaml
printf 'osUI:\n  image:\n    repository: ghcr.io/aborek/sovereign-os/os-ui\n    tag: "0.9.5"\n' > "$vals"
out=$(python3 scripts/lib/check-image-repo.py "$vals" ghcr.io/data-masterclass/sovereign-os/os-ui 2>&1); rc=$?
[ $rc -ne 0 ] && ok "a mismatched repository refuses" || bad "a mismatched repository refuses" "exit 0"
check "it names the failure"      "IMAGE_REPOSITORY_MISMATCH" "$out"
check "it names what the release pulls" "ghcr.io/aborek/sovereign-os/os-ui" "$out"
check "it offers the IMAGE_REPO fix"    "IMAGE_REPO=ghcr.io/aborek/sovereign-os" "$out"
out=$(python3 scripts/lib/check-image-repo.py "$vals" ghcr.io/aborek/sovereign-os/os-ui 2>&1); rc=$?
[ $rc -eq 0 ] && ok "a matching repository passes" || bad "a matching repository passes" "$out"
printf 'osUI:\n  enabled: true\n' > "$TMP/norepo.yaml"
out=$(python3 scripts/lib/check-image-repo.py "$TMP/norepo.yaml" ghcr.io/data-masterclass/sovereign-os/os-ui 2>&1); rc=$?
[ $rc -eq 0 ] && ok "no repository and no chart values passes" || bad "no repository and no chart values passes" "$out"
out=$(python3 scripts/lib/check-image-repo.py "$TMP/absent.yaml" ghcr.io/data-masterclass/sovereign-os/os-ui 2>&1); rc=$?
[ $rc -eq 0 ] && ok "an absent values file passes" || bad "an absent values file passes" "$out"
# deploy.sh must actually call it, and only when IMAGE_REPO was not given.
grep -q 'check-image-repo.py' scripts/deploy.sh \
  && ok "deploy.sh runs the repository check" || bad "deploy.sh runs the repository check"
# "Given" is recorded before the default is applied, never inferred by comparing against it:
# otherwise IMAGE_REPO=<the default> is a no-op and the guard's advice cannot be followed.
grep -q '^IMAGE_REPO_GIVEN=\${IMAGE_REPO:+1}$' scripts/deploy.sh \
  && ok "deploy.sh records whether IMAGE_REPO was given" || bad "deploy.sh records whether IMAGE_REPO was given"
[ "$(grep -c 'IMAGE_REPO" = "\$IMAGE_REPO_DEFAULT"' scripts/deploy.sh)" = 0 ] \
  && ok "deploy.sh never infers 'given' from the value" || bad "deploy.sh never infers 'given' from the value"
[ "$(grep -c '\[ -z "\$IMAGE_REPO_GIVEN" \]' scripts/deploy.sh)" = 2 ] \
  && ok "the guard and the --set hang off the same switch" || bad "the guard and the --set hang off the same switch"
# The default itself, and the one place it may appear in a cloud overlay. Only os-ui moved.
grep -q '^IMAGE_REPO_DEFAULT=ghcr.io/data-masterclass/sovereign-os$' scripts/deploy.sh \
  && ok "the default is the org namespace" || bad "the default is the org namespace"
[ "$(grep -c 'ghcr.io/data-masterclass/' values.stackit-managed.yaml)" = 1 ] \
  && grep -q '^    repository: ghcr.io/data-masterclass/sovereign-os/os-ui$' values.stackit-managed.yaml \
  && ok "the managed overlay moves os-ui and nothing else" || bad "the managed overlay moves os-ui and nothing else"
# The exceptions are docling (WP-40), dagster (WP-03 0.3.2), backup-tools (WP-56, its digest
# set by the owner when the feature is switched on), litellm-oss (the gateway image without
# litellm-enterprise, 2026-11-24) and langfuse-oss-web/-worker (Langfuse without the Enterprise
# Edition, 2026-11-24): each image is only ever built by
# build-images.yml, which pushes to the org namespace. Dagster is
# named in its four places (user-deployment, repo-sync sidecar, webserver, daemon) and nowhere else.
[ "$(grep -v -e '^    repository: ghcr.io/data-masterclass/sovereign-os/docling$' \
             -e '^      repository: ghcr.io/data-masterclass/sovereign-os/backup-tools$' \
             -e '^    repository: ghcr.io/data-masterclass/sovereign-os/litellm-oss$' \
             -e '^        repository: ghcr.io/data-masterclass/sovereign-os/langfuse-oss-web$' \
             -e '^        repository: ghcr.io/data-masterclass/sovereign-os/langfuse-oss-worker$' \
             -e '^ *repository: ghcr.io/data-masterclass/sovereign-os/dagster$' \
             -e '^ *image: ghcr.io/data-masterclass/sovereign-os/dagster:[0-9.]*@sha256:[0-9a-f]\{64\}$' \
        charts/sovereign-agentic-os/values.yaml | grep -c 'ghcr.io/data-masterclass/')" = 0 ] \
  && [ "$(grep -c 'ghcr.io/data-masterclass/sovereign-os/dagster' charts/sovereign-agentic-os/values.yaml)" = 4 ] \
  && ok "the chart's own defaults did not move (docling, dagster, backup-tools, litellm-oss and langfuse-oss excepted)" || bad "the chart's own defaults did not move (docling, dagster, backup-tools, litellm-oss and langfuse-oss excepted)"

echo "== the guard and the override, driven through deploy.sh with a fake kubectl and helm"
# deploy.sh up to (not past) `helm get manifest`: the fake helm serves the "live" values and
# then fails on the manifest read, so nothing later — backup, build, upgrade — can run. The
# context is one that does not exist, so a REAL kubectl/helm could not reach a cluster either.
fk=$TMP/fakekube; mkdir -p "$fk"
# apiserver-cidrs.py reads the pods: none carries an injected KUBERNETES_SERVICE_HOST here.
printf '#!/usr/bin/env bash\ncase "$*" in *"get pods -o json"*) echo "{\\"items\\":[]}" ;; esac\nexit 0\n' > "$fk/kubectl"
cat > "$fk/helm" <<'FAKE'
#!/usr/bin/env bash
[ "$1" = version ] && { echo v4.2.2; exit 0; }   # helm-version-guard.sh
case "$*" in
  *"get values"*)   printf 'osUI:\n  image:\n    repository: %s\n    tag: "0.9.5"\n' "$FAKE_LIVE_REPO" ;;
  *"get manifest"*) echo reached >> "$FAKE_REACHED"; exit 97 ;;
  *) echo "fake helm: unexpected: $*" >&2; exit 98 ;;
esac
FAKE
chmod +x "$fk/kubectl" "$fk/helm"
drive() { # drive <live-repo> [IMAGE_REPO] — sets $out, $rc and $reached
  rm -f "$TMP/reached"; mkdir -p "$TMP/work"
  out=$(env -u IMAGE_REPO ${2:+IMAGE_REPO=$2} PATH="$fk:$PATH" KUBE_CONTEXT=no-such-context-test \
        WORK="$TMP/work" FAKE_LIVE_REPO="$1" FAKE_REACHED="$TMP/reached" DEPLOY_REGISTRY_PROBE=$probe \
        bash scripts/deploy.sh --from-registry 9.9.9-test 2>&1); rc=$?
  reached=no; [ -f "$TMP/reached" ] && reached=yes
}
drive ghcr.io/aborek/sovereign-os/os-ui
[ $rc -eq 1 ] && ok "a release still on the old namespace is refused by default" || bad "a release still on the old namespace is refused by default" "exit $rc: $out"
check "the refusal is the repository guard" "IMAGE_REPOSITORY_MISMATCH" "$out"
check "it advises the default namespace"    "IMAGE_REPO=ghcr.io/data-masterclass/sovereign-os ./scripts/deploy.sh" "$out"
[ $reached = no ] && ok "nothing after the guard ran" || bad "nothing after the guard ran"
# …and that advice must WORK: the default, passed explicitly, is an override, not a no-op.
drive ghcr.io/aborek/sovereign-os/os-ui ghcr.io/data-masterclass/sovereign-os
[ $rc -eq 97 ] && [ $reached = yes ] && ok "IMAGE_REPO=<the default> gets past the guard" || bad "IMAGE_REPO=<the default> gets past the guard" "exit $rc: $out"
case $out in *IMAGE_REPOSITORY_MISMATCH*) bad "an explicit IMAGE_REPO is not second-guessed" "$out" ;; *) ok "an explicit IMAGE_REPO is not second-guessed" ;; esac
drive ghcr.io/data-masterclass/sovereign-os/os-ui
[ $rc -eq 97 ] && [ $reached = yes ] && ok "a release on the default namespace passes with nothing set" || bad "a release on the default namespace passes with nothing set" "exit $rc: $out"
check "the guard ran and agreed" "osUI.image.repository matches the image being deployed (ghcr.io/data-masterclass/sovereign-os/os-ui)" "$out"
drive ghcr.io/data-masterclass/sovereign-os/os-ui ghcr.io/aborek/sovereign-os
[ $rc -eq 97 ] && [ $reached = yes ] && ok "IMAGE_REPO=<the old namespace> is honoured too" || bad "IMAGE_REPO=<the old namespace> is honoured too" "exit $rc: $out"
check "it deploys the old-namespace image" "ghcr.io/aborek/sovereign-os/os-ui:9.9.9-test" "$out"

echo "== review L3: no repository in the release means the CHART DEFAULT applies"
# The chart default is the laptop/kind profile — a bare `sovereign-os/os-ui` no registry serves.
# Deploying a ghcr.io digest against it is the same ImagePullBackOff by another route.
chart=$TMP/chart-values.yaml
printf 'osUI:\n  image:\n    repository: sovereign-os/os-ui\n    tag: "0.1.0"\n' > "$chart"
out=$(python3 scripts/lib/check-image-repo.py "$TMP/norepo.yaml" ghcr.io/data-masterclass/sovereign-os/os-ui "$chart" 2>&1); rc=$?
[ $rc -ne 0 ] && ok "a ghcr digest against the laptop default refuses" || bad "a ghcr digest against the laptop default refuses" "exit 0"
check "it names the mismatch"       "IMAGE_REPOSITORY_MISMATCH" "$out"
check "it names the chart default"  "sovereign-os/os-ui"        "$out"
check "it says the values pin none" "pin NO osUI.image.repository" "$out"
out=$(python3 scripts/lib/check-image-repo.py "$TMP/norepo.yaml" sovereign-os/os-ui "$chart" 2>&1); rc=$?
[ $rc -eq 0 ] && ok "matching the chart default passes" || bad "matching the chart default passes" "$out"
# The real chart must still agree with the real default IMAGE_REPO — i.e. this guard would fire
# on a live cluster whose values carry no repository, which is the point.
grep -q 'CHART/values.yaml' scripts/deploy.sh \
  && ok "deploy.sh passes the chart values in" || bad "deploy.sh passes the chart values in"

echo "== review M4/L8/L9: the curl fallback classifies status, and keeps the token out of argv"
fake=$TMP/fakecurl/curl
mkdir -p "$TMP/fakecurl"
cat > "$fake" <<'FAKE'
#!/usr/bin/env bash
# A stand-in for curl: records argv and stdin, answers with $FAKE_CODE.
printf '%s\n' "$*" >> "$FAKE_ARGV"
cat >> "$FAKE_STDIN"
hdr=; out=; url=; prev=
for a in "$@"; do
  [ "$prev" = "-D" ] && hdr=$a
  [ "$prev" = "-o" ] && out=$a
  case $a in https://*) url=$a ;; esac
  prev=$a
done
case $url in
  */token\?*)
    if [ "${FAKE_TOKEN_DENY:-}" = 1 ]
      then body='{"errors":[{"code":"DENIED"}]}'
      else body='{"token":"faketoken"}'
    fi
    if [ -n "$out" ] && [ "$out" != /dev/null ]; then printf '%s' "$body" > "$out"; fi
    printf '%s' "${FAKE_TOKEN_CODE:-200}" ;;
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

echo "== review L2: the TOKEN leg is classified, not assumed to be an auth problem"
# It used to be judged only by whether a token came back, so a DNS failure or a registry 500 on
# this call reported "not authorised / the package is private" — the wrong thing to go fix.
out=$(PATH=$fakepath REGISTRY_CURL=curl FAKE_TOKEN_CODE=000 \
      bash scripts/lib/registry-digest.sh ghcr.io/x/y/os-ui:1.0.0 2>&1); rc=$?
[ $rc -ne 0 ] && ok "token leg 000 refuses" || bad "token leg 000 refuses" "exit 0"
check "token leg 000 says unreachable" "REGISTRY_UNREACHABLE" "$out"
case $out in *NOT_AUTHORISED*) bad "token leg 000 is not called an auth problem" "$out" ;; *) ok "token leg 000 is not called an auth problem" ;; esac

for code in 500 503; do
  out=$(PATH=$fakepath REGISTRY_CURL=curl FAKE_TOKEN_CODE=$code \
        bash scripts/lib/registry-digest.sh ghcr.io/x/y/os-ui:1.0.0 2>&1); rc=$?
  [ $rc -ne 0 ] && ok "token leg $code refuses" || bad "token leg $code refuses" "exit 0"
  check "token leg $code is a registry error" "REGISTRY_ERROR" "$out"
  case $out in *NOT_AUTHORISED*) bad "token leg $code is not called an auth problem" "$out" ;; *) ok "token leg $code is not called an auth problem" ;; esac
done

for code in 401 403; do
  out=$(PATH=$fakepath REGISTRY_CURL=curl FAKE_TOKEN_CODE=$code \
        bash scripts/lib/registry-digest.sh ghcr.io/x/y/os-ui:1.0.0 2>&1); rc=$?
  [ $rc -ne 0 ] && ok "token leg $code refuses" || bad "token leg $code refuses" "exit 0"
  check "token leg $code IS an auth problem" "REGISTRY_NOT_AUTHORISED" "$out"
  check "token leg $code names read:packages" "read:packages" "$out"
done

out=$(PATH=$fakepath REGISTRY_CURL=curl FAKE_TOKEN_CODE=418 \
      bash scripts/lib/registry-digest.sh ghcr.io/x/y/os-ui:1.0.0 2>&1); rc=$?
[ $rc -ne 0 ] && ok "an unexpected token status refuses" || bad "an unexpected token status refuses" "exit 0"
check "it names the status" "REGISTRY_TOKEN_HTTP_418" "$out"
check "both token-leg calls carry --max-time 30" "--max-time 30" "$(cat "$FAKE_ARGV")"

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
