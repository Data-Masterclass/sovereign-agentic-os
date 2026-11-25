#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# deploy-dagster-image.test.sh — WP-03 0.3.2: the chart's Dagster image (org registry, pinned by
# digest) WINS over a live release that pins `ghcr.io/aborek/sovereign-os/dagster` at 0.3.1, in
# all four places, and the pods keep the release's registry pull secret.
# =============================================================================
#   bash scripts/tests/deploy-dagster-image.test.sh
#
# Runs the REAL deploy.sh (values derivation) in a throwaway tree with a faked cluster, the same
# harness as deploy-capacity-gate.test.sh: helm answers `get values` from a fixture shaped like the
# live release (image paths read from the live pods, 2026-11-20) and logs `upgrade` without running
# it. Then the REAL `helm template` renders the chart with the values deploy.sh derived, and every
# Dagster container image and pull secret is read from the rendered pods.
# Negative twin: with the chart's repository unqualified (the old laptop default) the live
# repository is still carried over, exactly as before.
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
  cp deploy/gateway-no-config-models.yaml "$T/deploy/"   # deploy.sh layers it on every deploy
  cp scripts/lib/*.py scripts/lib/*.sh "$T/scripts/lib/"
  cp -R charts/sovereign-agentic-os "$T/charts/"
  cp os-ui/package.json "$T/os-ui/"
  ln -s "$REPO/os-ui/node_modules" "$T/os-ui/node_modules"
  printf '#!/usr/bin/env bash\necho "backup $*" >> "$FAKE_LOG"\n' > "$T/deploy/pre-upgrade-backup.sh"
  chmod +x "$T/deploy/pre-upgrade-backup.sh"
}
BIN=$TMP/bin; mkdir -p "$BIN"
# The rotation drift guard lists the Secrets: none is managed by rotate-secrets.sh here.
printf '#!/usr/bin/env bash\necho "kubectl $*" >> "$FAKE_LOG"\ncase "$*" in *"get pods -o json"*) echo "{\\"items\\":[]}" ;; *"get secrets -o json"*) echo "{\\"items\\":[]}" ;; esac\n' > "$BIN/kubectl"
cat > "$BIN/helm" <<STUB
#!/usr/bin/env bash
[ "\$1" = version ] && { echo v4.2.2; exit 0; }   # helm-version-guard.sh
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

# The live release, as its pods show it: aborek repository and 0.3.1 in the user-deployment and
# the repo-sync sidecar; webserver/daemon carry the repository (tag popped by deploy.sh anyway);
# the registry pull secret every Dagster pod uses, on the subchart's own two keys (the only keys
# that render it; `global.imagePullSecrets` does not reach Dagster pods).
cat > "$TMP/live.yaml" <<'YAML'
osUI:
  image:
    repository: registry.example.invalid/sovereign-os/os-ui
dagster:
  imagePullSecrets:
    - name: registry-pull-secret
  dagsterWebserver:
    image: {repository: ghcr.io/aborek/sovereign-os/dagster, tag: "0.3.1"}
  dagsterDaemon:
    image: {repository: ghcr.io/aborek/sovereign-os/dagster, tag: "0.3.1"}
  dagster-user-deployments:
    imagePullSecrets:
      - name: registry-pull-secret
    deployments:
      - name: sovereign
        image: {repository: ghcr.io/aborek/sovereign-os/dagster, tag: "0.3.1", pullPolicy: IfNotPresent}
        sidecarContainers:
          - name: repo-sync
            image: ghcr.io/aborek/sovereign-os/dagster:0.3.1
# Release-owned secrets (test-only strings), so deploy.sh's secret preflight passes.
litellmMasterKey: sk-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
agentRuntime:
  token: rt-test-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
langfuseInit:
  publicKey: pk-lf-test-cccccccccccccccc
  secretKey: sk-lf-test-dddddddddddddddd
  userPassword: lf-admin-test-eeeeeeeeeeeeeeee
YAML

derive_and_render() { # <tree> — sets out, rc, rendered
  export FAKE_LOG=$TMP/calls.log FAKE_LIVE_VALUES=$TMP/live.yaml
  : > "$FAKE_LOG"
  local work; work=$(mktemp -d "$TMP/work.XXXX")
  out=$(cd "$1" && PATH="$BIN:$PATH" DEPLOY_REGISTRY_PROBE="$BIN/probe" IMAGE_REPO=registry.example.invalid/sovereign-os \
        WORK="$work" GATEWAY_PREFLIGHT=skip bash scripts/deploy.sh --from-registry 9.9.9-test 2>&1); rc=$?
  # stdout only: helm prints warnings on stderr, which are not YAML.
  rendered=$("$REAL_HELM" template agentic-os "$1/charts/sovereign-agentic-os" -n agentic-os --skip-schema-validation \
             -f "$work/release-values.yaml" 2>"$TMP/template.err") \
    || { echo "helm template failed:"; sed 's/^/     | /' "$TMP/template.err"; }
}
images_of() { # prints "<component> <image>" for each Dagster container in $rendered
  printf '%s' "$rendered" | python3 -c '
import sys, yaml
for doc in yaml.safe_load_all(sys.stdin):
    if not isinstance(doc, dict) or doc.get("kind") != "Deployment": continue
    comp = (doc["spec"]["template"]["metadata"].get("labels") or {}).get("component", "")
    if comp not in ("user-deployments", "dagster-webserver", "dagster-daemon"): continue
    spec = doc["spec"]["template"]["spec"]
    secrets = ",".join(s["name"] for s in spec.get("imagePullSecrets") or [])
    for c in spec["containers"]:
        print(comp, c["name"], c["image"], "pull=" + (secrets or "NONE"))
'
}

D=$(python3 -c 'import yaml;print(yaml.safe_load(open("charts/sovereign-agentic-os/values.yaml"))["dagster"]["dagsterWebserver"]["image"]["digest"])')
WANT="ghcr.io/data-masterclass/sovereign-os/dagster@$D"
SIDECAR="ghcr.io/data-masterclass/sovereign-os/dagster:0.4.2@$D"

echo "== the chart's org-registry image wins over the live aborek/0.3.1 pins"
tree "$TMP/t1"
derive_and_render "$TMP/t1"
# The faked cluster cannot satisfy the post-upgrade verify, so the proof is the upgrade call itself.
check "deploy.sh derived the values and reached helm upgrade" "helm upgrade" "$(cat "$FAKE_LOG")"
imgs=$(images_of)
echo "$imgs" | sed 's/^/     /'
check "user-deployment runs the org image by digest" "user-deployments dagster-user-deployments $WANT" "$imgs"
check "repo-sync sidecar runs the org image by digest" "user-deployments repo-sync $SIDECAR" "$imgs"
check "webserver runs the org image by digest" "dagster-webserver dagster $WANT" "$imgs"
check "daemon runs the org image by digest" "dagster-daemon dagster $WANT" "$imgs"
absent "no container still pulls from aborek" "aborek" "$imgs"
absent "no container still runs 0.3.1" "0.3.1" "$imgs"
absent "every Dagster pod has a pull secret" "pull=NONE" "$imgs"
check "the pull secret is the release's registry-pull-secret" "pull=registry-pull-secret" "$imgs"

echo "== negative twin: an unqualified chart repository still carries the live repository"
tree "$TMP/t2"
python3 - "$TMP/t2/charts/sovereign-agentic-os/values.yaml" <<'PY'
import sys, re
p = sys.argv[1]; s = open(p).read()
s = s.replace("ghcr.io/data-masterclass/sovereign-os/dagster", "sovereign-os/dagster")
s = re.sub(r'\n\s*digest: "sha256:[0-9a-f]{64}"', "", s)
s = re.sub(r"(sovereign-os/dagster:[0-9.]+)@sha256:[0-9a-f]{64}", r"\1", s)
open(p, "w").write(s)
PY
derive_and_render "$TMP/t2"
imgs=$(images_of)
check "the user-deployment keeps the operator's repository" "user-deployments dagster-user-deployments ghcr.io/aborek/sovereign-os/dagster:" "$imgs"
check "the sidecar keeps the operator's repository" "user-deployments repo-sync ghcr.io/aborek/sovereign-os/dagster:" "$imgs"

finish deploy-dagster-image
