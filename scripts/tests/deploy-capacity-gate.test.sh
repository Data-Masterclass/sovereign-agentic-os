#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# deploy-capacity-gate.test.sh — WP-47: deploy.sh runs the capacity gate on the values it
# applies (live release values + chart defaults + VALUES_OVERLAY) and stops before the backup and
# `helm upgrade` when they do not fit the node.
# =============================================================================
#   bash scripts/tests/deploy-capacity-gate.test.sh
#
# Runs the REAL deploy.sh, the REAL check-capacity.mjs and the REAL `helm template` of this chart
# inside a throwaway tree. Only the cluster side is faked: kubectl is a stub that logs; helm is a
# wrapper that answers `get values` from a fixture (the "live release"), `get manifest` with
# nothing, logs `upgrade` WITHOUT running it, and passes everything else (template) to the real
# helm. deploy/pre-upgrade-backup.sh is a stub that logs. The registry probe is a stub, so no
# Docker is needed (`--from-registry`). Needs helm, the subchart .tgz files and os-ui's js-yaml.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
REPO=$PWD
. scripts/tests/assert.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
REAL_HELM=$(command -v helm) || { echo "helm not on PATH"; exit 2; }
[ -d os-ui/node_modules/js-yaml ] || { echo "js-yaml missing (npm --prefix os-ui ci)"; exit 2; }
ls charts/sovereign-agentic-os/charts/*.tgz >/dev/null 2>&1 || { echo "no subchart .tgz (helm dependency build charts/sovereign-agentic-os)"; exit 2; }

# ---- the throwaway operator tree ------------------------------------------------------------
T=$TMP/tree
mkdir -p "$T/scripts/lib" "$T/deploy" "$T/os-ui" "$T/charts"
cp scripts/deploy.sh scripts/check-capacity.mjs "$T/scripts/"
cp scripts/lib/*.py scripts/lib/*.sh "$T/scripts/lib/"
cp -R charts/sovereign-agentic-os "$T/charts/"
cp os-ui/package.json "$T/os-ui/"
ln -s "$REPO/os-ui/node_modules" "$T/os-ui/node_modules"
cat > "$T/deploy/pre-upgrade-backup.sh" <<'STUB'
#!/usr/bin/env bash
echo "backup $*" >> "$FAKE_LOG"
STUB
chmod +x "$T/deploy/pre-upgrade-backup.sh"

BIN=$TMP/bin; mkdir -p "$BIN"
cat > "$BIN/kubectl" <<'STUB'
#!/usr/bin/env bash
echo "kubectl $*" >> "$FAKE_LOG"
STUB
cat > "$BIN/helm" <<STUB
#!/usr/bin/env bash
case "\$*" in
  *" get values "*)   echo "helm get values" >> "\$FAKE_LOG"; cat "\$FAKE_LIVE_VALUES" ;;
  *" get manifest "*) echo "helm get manifest" >> "\$FAKE_LOG" ;;
  *" history "*)      echo "[]" ;;
  *" upgrade "*)      echo "helm upgrade" >> "\$FAKE_LOG" ;;
  *)                  exec "$REAL_HELM" "\$@" ;;
esac
STUB
cat > "$BIN/probe" <<'STUB'
#!/usr/bin/env bash
echo sha256:2222222222222222222222222222222222222222222222222222222222222222
STUB
chmod +x "$BIN"/*

# deploy <live-values-fixture> [overlay] — sets out, rc; the log is in $FAKE_LOG.
deploy() {
  export FAKE_LOG=$TMP/calls.log FAKE_LIVE_VALUES=$1
  : > "$FAKE_LOG"
  local work; work=$(mktemp -d "$TMP/work.XXXX")
  out=$(cd "$T" && PATH="$BIN:$PATH" DEPLOY_REGISTRY_PROBE="$BIN/probe" IMAGE_REPO=registry.example.invalid/sovereign-os \
        VALUES_OVERLAY=${2:-} WORK="$work" bash scripts/deploy.sh --from-registry 9.9.9-test 2>&1); rc=$?
  log=$(cat "$FAKE_LOG")
}
FIX=$REPO/scripts/tests/fixtures
printf 'osUI:\n  image:\n    repository: registry.example.invalid/sovereign-os/os-ui\n' > "$TMP/live-defaults.yaml"
# A release with its own secrets (the secret preflight passes); the values are test-only strings.
{ cat "$TMP/live-defaults.yaml"
  printf 'litellmMasterKey: sk-test-%s\nagentRuntime:\n  token: rt-test-%s\n' "$(printf 'a%.0s' {1..32})" "$(printf 'b%.0s' {1..32})"
  printf 'langfuseInit:\n  publicKey: pk-lf-test-%s\n  secretKey: sk-lf-test-%s\n  userPassword: lf-admin-test-%s\n' "$(printf 'c%.0s' {1..16})" "$(printf 'd%.0s' {1..16})" "$(printf 'e%.0s' {1..16})"
} > "$TMP/live-ok.yaml"
# The live release itself over-commits: the gate must read the RELEASE values, not chart defaults.
{ cat "$TMP/live-ok.yaml"; cat "$FIX/capacity-overcommit-cpu.yaml"; } > "$TMP/live-overcommit.yaml"

echo "== release values that fit"
deploy "$TMP/live-ok.yaml"
check "the gate runs on the release values" "check-capacity: ok" "$out"
check "the deploy goes on to the backup" "backup" "$log"
check "and to helm upgrade" "helm upgrade" "$log"

echo "== a release still on the public development secrets (secret preflight)"
deploy "$TMP/live-defaults.yaml"
rc_is "deploy exits 1" 1
check "it says the secret preflight stopped it" "SECRET_PREFLIGHT_FAILED" "$out"
check "it names the variable" "LITELLM_MASTER_KEY" "$out"
check "it points at the rotation procedure" "docs/ops/secret-rotation.md" "$out"
absent "it prints no secret value" "sk-litellm-local-dev-master" "$out"
absent "no backup is taken" "backup" "$log"
absent "no helm upgrade runs" "helm upgrade" "$log"

echo "== live release values that over-commit"
deploy "$TMP/live-overcommit.yaml"
rc_is "deploy exits 1" 1
check "it says the gate stopped it" "CAPACITY_GATE_FAILED" "$out"
check "with the gate's reason" "CPU requests" "$out"
absent "no backup is taken" "backup" "$log"
absent "no helm upgrade runs" "helm upgrade" "$log"

echo "== a VALUES_OVERLAY that over-commits"
deploy "$TMP/live-ok.yaml" "$FIX/capacity-overcommit-memory-limits.yaml"
rc_is "deploy exits 1" 1
check "the overlay is gated too" "memory limits" "$out"
absent "no helm upgrade runs" "helm upgrade" "$log"

finish deploy-capacity-gate.test
