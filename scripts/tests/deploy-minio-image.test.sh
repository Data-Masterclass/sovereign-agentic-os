#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# deploy-minio-image.test.sh — "MinIO A" (2026-11-27): the chart's MinIO image (private org
# mirror, pinned by digest) WINS over a live release that pins the public personal package
# `ghcr.io/aborek/sovereign-os/minio`, and the minio pod gets the release's registry pull secret.
# =============================================================================
#   bash scripts/tests/deploy-minio-image.test.sh
#
# Same harness as deploy-dagster-image.test.sh: the REAL deploy.sh derives the values from a
# faked `helm get values` (shaped like the live prod release), then the REAL `helm template`
# renders them and the minio Deployment's image and pull secret are read from the output.
# Negative twin: without the reset in deploy.sh the live aborek repository would be carried over.
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

# The live prod release, as `helm get values` shows it (2026-11-27): objectStorage.image pins
# the aborek repository and the digest; global.imagePullSecrets names registry-pull-secret.
cat > "$TMP/live.yaml" <<'YAML'
global:
  imagePullSecrets:
    - name: registry-pull-secret
osUI:
  image:
    repository: registry.example.invalid/sovereign-os/os-ui
objectStorage:
  persistence:
    enabled: true
  resources:
    requests: { memory: 512Mi }
    limits: { memory: 1536Mi }
  image:
    repository: ghcr.io/aborek/sovereign-os/minio
    digest: sha256:1887982b34cc821a569fdc94c4d30ee01c2826184fe7d3a49aee37bb3bbb23a7
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
minio_of() { # prints "<image> pull=<secrets>" for the minio Deployment in $rendered
  printf '%s' "$rendered" | python3 -c '
import sys, yaml
for doc in yaml.safe_load_all(sys.stdin):
    if not isinstance(doc, dict) or doc.get("kind") != "Deployment" or doc["metadata"]["name"] != "minio": continue
    spec = doc["spec"]["template"]["spec"]
    secrets = ",".join(s["name"] for s in spec.get("imagePullSecrets") or [])
    c = next(c for c in spec["containers"] if c["name"] == "minio")
    print(c["image"], "pull=" + (secrets or "NONE"))
'
}

V=charts/sovereign-agentic-os/values.yaml
WANT=$(python3 -c 'import yaml;i=yaml.safe_load(open("'$V'"))["objectStorage"]["image"];print(i["repository"]+"@"+i["digest"])')

echo "== the chart's org-registry MinIO image wins over the live aborek pin"
check "the chart names the private org mirror" "ghcr.io/data-masterclass/sovereign-os/minio@sha256:1887982b34cc821a569fdc94c4d30ee01c2826184fe7d3a49aee37bb3bbb23a7" "$WANT"
tree "$TMP/t1"
derive_and_render "$TMP/t1"
check "deploy.sh derived the values and reached helm upgrade" "helm upgrade" "$(cat "$FAKE_LOG")"
check "deploy.sh reports the reset" "objectStorage.image.repository" "$out"
m=$(minio_of); echo "     $m"
check "minio runs the org image by digest" "$WANT pull=" "$m"
absent "minio no longer pulls from aborek" "aborek" "$m"
check "minio pulls with the release's registry-pull-secret" "pull=registry-pull-secret" "$m"
check "the operator's other objectStorage keys are kept" "enabled: true" "$(python3 -c 'import yaml,sys,glob;print(yaml.safe_dump(yaml.safe_load(open(glob.glob(sys.argv[1]+"/work.*/release-values.yaml")[0]))["objectStorage"]))' "$TMP")"

echo "== MinIO resources are chart-owned (memory rebalance #408): the live 512Mi request does not win"
WANT_REQ=$(python3 -c 'import yaml;print(yaml.safe_load(open("'$V'"))["objectStorage"]["resources"]["requests"]["memory"])')
mem_of() { printf '%s' "$rendered" | python3 -c '
import sys, yaml
for doc in yaml.safe_load_all(sys.stdin):
    if isinstance(doc, dict) and doc.get("kind") == "Deployment" and doc["metadata"]["name"] == "minio":
        c = next(c for c in doc["spec"]["template"]["spec"]["containers"] if c["name"] == "minio")
        print("req=" + str(c["resources"]["requests"]["memory"]), "lim=" + str(c["resources"]["limits"]["memory"]))
'; }
r=$(mem_of); echo "     $r"
check "deploy.sh reports the resources reset" "objectStorage.resources" "$out"
check "minio requests the chart's memory" "req=$WANT_REQ" "$r"
absent "the live 512Mi request is gone" "req=512Mi" "$r"

echo "== negative twin: without the resets the live aborek repository and the 512Mi request are carried over"
tree "$TMP/t2"
python3 - "$TMP/t2/scripts/deploy.sh" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
s = s.replace("    for k in ('repository', 'digest', 'tag'):\n        if os_img.pop(k, None) is not None:", "    for k in ():\n        if os_img.pop(k, None) is not None:")
assert "for k in ():" in s
s = s.replace("os_cfg.pop('resources', None) is not None", "False")
assert "os_cfg is not None and False" in s
open(p, "w").write(s)
PY
rm -rf "$TMP"/work.*
derive_and_render "$TMP/t2"
m=$(minio_of)
check "the twin would still pull from aborek" "ghcr.io/aborek/sovereign-os/minio@" "$m"
check "the twin would keep the live 512Mi request" "req=512Mi" "$(mem_of)"

finish deploy-minio-image
