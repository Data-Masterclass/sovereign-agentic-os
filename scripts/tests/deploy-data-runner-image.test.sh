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
  *" get manifest "*) ;;
  *" history "*)      echo "[]" ;;
  *" upgrade "*)      echo "helm upgrade" >> "\$FAKE_LOG" ;;
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
        WORK="$work" bash scripts/deploy.sh --from-registry 9.9.9-test 2>&1); rc=$?
  rendered=$("$REAL_HELM" template agentic-os "$1/charts/sovereign-agentic-os" -n agentic-os --skip-schema-validation \
             -f "$work/release-values.yaml" 2>"$TMP/template.err") \
    || { echo "helm template failed:"; sed 's/^/     | /' "$TMP/template.err"; }
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

finish deploy-data-runner-image
