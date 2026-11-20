#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# deploy-data-runner-image.test.sh — the chart's data-runner image (pinned by digest, chart-owned)
# WINS over whatever the live release carries for it, the chart refuses an empty digest, and
# `localBuild` (kind only) is refused with any production signal.
# =============================================================================
#   bash scripts/tests/deploy-data-runner-image.test.sh
#
# Runs the REAL deploy.sh (values derivation) in a throwaway tree with a faked cluster (the
# deploy-dagster-image.test.sh harness), then the REAL `helm template` on the derived values, and
# reads the data-runner container image from the rendered Deployment.
# Negative twin: with the chart's repository unqualified the live repository is carried over.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
REPO=$PWD
. scripts/tests/assert.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
REAL_HELM=$(command -v helm) || { echo "helm not on PATH"; exit 2; }
[ -d os-ui/node_modules/js-yaml ] || { echo "js-yaml missing (npm --prefix os-ui ci)"; exit 2; }
ls charts/sovereign-agentic-os/charts/*.tgz >/dev/null 2>&1 || { echo "no subchart .tgz (helm dependency build charts/sovereign-agentic-os)"; exit 2; }

tree() { # <dir> — a throwaway operator tree with this chart
  local T=$1
  mkdir -p "$T/scripts/lib" "$T/deploy" "$T/os-ui" "$T/charts"
  cp scripts/deploy.sh scripts/check-capacity.mjs "$T/scripts/"
  cp scripts/lib/*.py scripts/lib/*.sh "$T/scripts/lib/"
  cp -R charts/sovereign-agentic-os "$T/charts/"
  cp os-ui/package.json "$T/os-ui/"
  ln -s "$REPO/os-ui/node_modules" "$T/os-ui/node_modules"
  printf '#!/usr/bin/env bash\necho "backup $*" >> "$FAKE_LOG"\n' > "$T/deploy/pre-upgrade-backup.sh"
  chmod +x "$T/deploy/pre-upgrade-backup.sh"
}
BIN=$TMP/bin; mkdir -p "$BIN"
printf '#!/usr/bin/env bash\necho "kubectl $*" >> "$FAKE_LOG"\n' > "$BIN/kubectl"
cat > "$BIN/helm" <<STUB
#!/usr/bin/env bash
case "\$*" in
  *" get values "*)   cat "\$FAKE_LIVE_VALUES" ;;
  *" get manifest "*) if [ -n "\${FAKE_LIVE_MANIFEST:-}" ]; then cat "\$FAKE_LIVE_MANIFEST"; fi ;;
  *" history "*)      echo "[]" ;;
  *" upgrade "*)      echo "helm upgrade \$*" >> "\$FAKE_LOG" ;;
  *)                  exec "$REAL_HELM" "\$@" ;;
esac
STUB
printf '#!/usr/bin/env bash\necho sha256:2222222222222222222222222222222222222222222222222222222222222222\n' > "$BIN/probe"
chmod +x "$BIN"/*

# The live release carries a hand-built runner from another repository at an older tag.
cat > "$TMP/live.yaml" <<'YAML'
osUI:
  image:
    repository: registry.example.invalid/sovereign-os/os-ui
dataRunner:
  image: {repository: registry.example.invalid/hand-built/data-runner, tag: "0.2.1", digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111"}
YAML

derive_and_render() { # <tree> — sets out, rc, rendered
  export FAKE_LOG=$TMP/calls.log FAKE_LIVE_VALUES=$TMP/live.yaml
  : > "$FAKE_LOG"
  local work; work=$(mktemp -d "$TMP/work.XXXX")
  out=$(cd "$1" && PATH="$BIN:$PATH" DEPLOY_REGISTRY_PROBE="$BIN/probe" IMAGE_REPO=registry.example.invalid/sovereign-os \
        DEPLOY_MAPPED_COLUMNS_PROBE="$TMP/mapped-probe" DEPLOY_IMAGE_LABEL_PROBE="$TMP/label-probe" WORK="$work" bash scripts/deploy.sh --from-registry 9.9.9-test ${DEPLOY_EXTRA:-} 2>&1); rc=$?
  rendered=$("$REAL_HELM" template agentic-os "$1/charts/sovereign-agentic-os" -n agentic-os --skip-schema-validation \
             -f "$work/release-values.yaml" 2>"$TMP/template.err") \
    || { echo "helm template failed:"; sed 's/^/     | /' "$TMP/template.err"; }
  # The annotation the upgrade would write: the same values plus the capability deploy.sh passed.
  local cap; cap=$(grep -o 'dataRunner.verifiedCapability=[a-z]*' "$FAKE_LOG" | tail -1 || true)
  rendered_cap=$("$REAL_HELM" template agentic-os "$1/charts/sovereign-agentic-os" -n agentic-os --skip-schema-validation \
             -f "$work/release-values.yaml" ${cap:+--set-string "$cap"} --show-only templates/extensions/lakehouse/data-runner.yaml 2>/dev/null || true)
}
runner_image() { # the data-runner container image in $rendered
  printf '%s' "$rendered" | python3 -c '
import sys, yaml
for doc in yaml.safe_load_all(sys.stdin):
    if isinstance(doc, dict) and doc.get("kind") == "Deployment" and doc["metadata"]["name"] == "data-runner":
        print(doc["spec"]["template"]["spec"]["containers"][0]["image"])
'
}
V=charts/sovereign-agentic-os/values.yaml
read -r R T D < <(python3 -c 'import yaml;i=yaml.safe_load(open("'"$V"'"))["dataRunner"]["image"];print(i["repository"],i["tag"],i["digest"])')
WANT="$R:$T@$D"

echo "== the chart's pinned runner wins over the live release's"
tree "$TMP/t1"
derive_and_render "$TMP/t1"
check "deploy.sh derived the values and reached helm upgrade" "helm upgrade" "$(cat "$FAKE_LOG")"
img=$(runner_image)
check "the data-runner runs the chart's image by digest" "$WANT" "$img"
absent "the live hand-built repository does not win" "hand-built" "$img"
absent "the live digest does not win" "sha256:1111" "$img"

echo "== the chart refuses an empty digest"
e=$("$REAL_HELM" template x charts/sovereign-agentic-os --skip-schema-validation --set dataRunner.image.digest= 2>&1 >/dev/null)
check "empty digest refuses to render" "dataRunner.image.digest must be set" "$e"

echo "== localBuild: kind only"
o=$("$REAL_HELM" template x charts/sovereign-agentic-os --skip-schema-validation --set dataRunner.image.localBuild=true --set docling.image.localBuild=true 2>&1)
check "localBuild renders tag-only for a local cluster" "image: \"$R:$T\"" "$o"
e=$("$REAL_HELM" template x charts/sovereign-agentic-os --skip-schema-validation --set dataRunner.image.localBuild=true --set docling.image.localBuild=false --set osUI.publicUrl=https://os.example.com 2>&1 >/dev/null)
check "localBuild is refused for a public host" "dataRunner.image.localBuild=true is for a local kind cluster only" "$e"

echo "== negative twin: an unqualified chart repository keeps the operator's repository"
tree "$TMP/t2"
python3 - "$TMP/t2/$V" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
s = s.replace("repository: ghcr.io/aborek/sovereign-os/data-runner", "repository: sovereign-os/data-runner")
open(p, "w").write(s)
PY
derive_and_render "$TMP/t2"
check "the live repository is carried with the chart's tag and digest" "registry.example.invalid/hand-built/data-runner:$T@$D" "$(runner_image)"

echo "== re-pin guard: a legacy runner pinned over a column-name runner while mapped names exist"
cat > "$TMP/mapped-probe" <<'STUB'
#!/usr/bin/env bash
echo "probe $*" >> "$FAKE_LOG.probe"
[ "$FAKE_MAPPED" = fail ] && exit 1
echo "$FAKE_MAPPED"
STUB
chmod +x "$TMP/mapped-probe"
"$REAL_HELM" template agentic-os charts/sovereign-agentic-os -n agentic-os --skip-schema-validation \
  --set dataRunner.image.digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --show-only templates/extensions/lakehouse/data-runner.yaml > "$TMP/live-new-runner.yaml" 2>/dev/null
check "a non-legacy digest renders applies-column-names true" 'applies-column-names: "true"' "$(cat "$TMP/live-new-runner.yaml")"
check "the chart's legacy pin renders false" 'applies-column-names: "false"' "$("$REAL_HELM" template x charts/sovereign-agentic-os --skip-schema-validation --show-only templates/extensions/lakehouse/data-runner.yaml 2>/dev/null)"
tree "$TMP/t3"
export FAKE_LIVE_MANIFEST=$TMP/live-new-runner.yaml
FAKE_MAPPED=3 derive_and_render "$TMP/t3"
check "refused while 3 datasets store mapped names" "RUNNER_DOWNGRADE_REFUSED" "$out"
absent "...before any helm upgrade" "helm upgrade" "$(cat "$FAKE_LOG")"
FAKE_MAPPED=fail derive_and_render "$TMP/t3"
check "refused when the count cannot be read" "unknown dataset(s) store mapped column names" "$out"
FAKE_MAPPED=3 DEPLOY_EXTRA=--allow-runner-downgrade derive_and_render "$TMP/t3"
check "the override lets it through" "helm upgrade" "$(cat "$FAKE_LOG")"
check "...with a warning" "WARNING: --allow-runner-downgrade: 3 dataset(s)" "$out"
echo "== negative twins"
FAKE_MAPPED=0 derive_and_render "$TMP/t3"
check "no mapped dataset: allowed" "helm upgrade" "$(cat "$FAKE_LOG")"
: > "$FAKE_LOG.probe"
unset FAKE_LIVE_MANIFEST
FAKE_MAPPED=3 derive_and_render "$TMP/t3"
check "the live runner is legacy too: allowed" "helm upgrade" "$(cat "$FAKE_LOG")"
[ ! -s "$FAKE_LOG.probe" ] && ok "...and the store is not probed" || bad "...and the store is not probed" "$(cat "$FAKE_LOG.probe")"
echo 'kind: Deployment
metadata: {name: data-runner' > "$TMP/broken.yaml"
FAKE_LIVE_MANIFEST=$TMP/broken.yaml FAKE_MAPPED=0 derive_and_render "$TMP/t3"
check "fail closed: an unparsable live manifest refuses" "RUNNER_CAPABILITY_UNKNOWN" "$out"

echo "== capability from the IMAGE LABEL (registry), not from the digest alone"
cat > "$TMP/label-probe" <<'STUB'
#!/usr/bin/env bash
echo "label $*" >> "$FAKE_LOG.label"
case "$FAKE_LABEL" in
  fail)   exit 1 ;;
  absent) echo '{"config":{"Labels":{"org.opencontainers.image.title":"data-runner"}}}' ;;
  *)      echo "{\"config\":{\"Labels\":{\"org.sovereign-os.applies-column-names\":\"$FAKE_LABEL\"}}}" ;;
esac
STUB
chmod +x "$TMP/label-probe"
tree "$TMP/t4"
# A runner build that is NOT on the legacy list (an older hand-built 0.2.1, say).
python3 - "$TMP/t4/$V" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
s = s.replace("digest: sha256:8f7b8a3287368c915af90ee37e6053dfd77326d98fea450f87b97f4835a2e482", "digest: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 1)
open(p, "w").write(s)
PY
export FAKE_LIVE_MANIFEST=$TMP/live-new-runner.yaml
: > "$FAKE_LOG.label"
FAKE_LABEL=absent FAKE_MAPPED=3 derive_and_render "$TMP/t4"
check "an unlabelled, unlisted runner over a capable one is refused" "RUNNER_DOWNGRADE_REFUSED" "$out"
check "...because its registry label says it does not apply column names" "label org.sovereign-os.applies-column-names='' -> applies column names: false" "$out"
check "the label was read from the pinned digest" "label ghcr.io/aborek/sovereign-os/data-runner:0.2.2@sha256:bbbb" "$(cat "$FAKE_LOG.label")"
FAKE_LABEL=fail FAKE_MAPPED=0 derive_and_render "$TMP/t4"
check "fail closed: an unreadable label refuses the deploy" "RUNNER_LABEL_UNREADABLE" "$out"
absent "...before any helm upgrade" "helm upgrade" "$(cat "$FAKE_LOG")"
FAKE_LABEL=true FAKE_MAPPED=3 derive_and_render "$TMP/t4"
check "negative twin: a labelled runner is capable and deploys" "helm upgrade" "$(cat "$FAKE_LOG")"
check "...and the release records the label's verdict" "dataRunner.verifiedCapability=true" "$(cat "$FAKE_LOG")"
check "...so the release annotation is true" 'applies-column-names: "true"' "$rendered_cap"
echo "== the legacy list stays an extra guard"
: > "$FAKE_LOG.label"
FAKE_LABEL=true FAKE_MAPPED=3 derive_and_render "$TMP/t3"
check "a legacy digest is not capable even if it claimed the label" "RUNNER_DOWNGRADE_REFUSED" "$out"
[ ! -s "$FAKE_LOG.label" ] && ok "...and its label is not even read" || bad "...and its label is not even read" "$(cat "$FAKE_LOG.label")"
unset FAKE_LIVE_MANIFEST

finish deploy-data-runner-image
