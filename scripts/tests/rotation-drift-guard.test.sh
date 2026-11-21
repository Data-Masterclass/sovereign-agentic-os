#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# rotation-drift-guard.test.sh — scripts/lib/rotation-drift-guard.py, and deploy.sh / rollback.sh
# refusing to undo a rotation (docs/ops/WP-secret-rotation.md, "Between ds-rekey and the deploy").
# =============================================================================
#   bash scripts/tests/rotation-drift-guard.test.sh
#
# `ds-rekey` writes Secret keys with the field manager `rotate-secrets`. Until the overlay is
# deployed, the RELEASE still renders the older values: a deploy or a rollback from them would put
# the old credential back and silently undo the rotation. The guard compares, by sha256 only, every
# Secret key the cluster says `rotate-secrets` manages with the same key in the render, and refuses
# when they differ — naming the overlay that holds the cluster's value — unless ROTATION_IN_PROGRESS
# is set. Negative twins: the same value passes; a difference in a key `rotate-secrets` does not
# manage is not this guard's business; a Secret the render does not carry cannot be overwritten.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
G="python3 scripts/lib/rotation-drift-guard.py"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; chmod 700 "$T"
LIVE_PW=live-rotated-$(openssl rand -hex 8); OLD_PW=chart-older-$(openssl rand -hex 8); OTHER=other-$(openssl rand -hex 8)
b64() { printf %s "$1" | base64 | tr -d '\n'; }
h12() { printf %s "$1" | shasum -a 256 | cut -c1-12; }

# The cluster: valkey-credentials/password managed by rotate-secrets (ds-rekey wrote it) AND by helm;
# litellm-credentials/UI_PASSWORD managed by helm only; dagster-postgresql (outside the chart) by
# rotate-secrets.
cat > "$T/secrets.json" <<JSON
{"apiVersion":"v1","kind":"List","items":[
 {"metadata":{"name":"valkey-credentials","managedFields":[
   {"manager":"helm","operation":"Apply","fieldsV1":{"f:data":{"f:password":{}}}},
   {"manager":"rotate-secrets","operation":"Apply","fieldsV1":{"f:data":{"f:password":{}}}}]},
  "data":{"password":"$(b64 "$LIVE_PW")"}},
 {"metadata":{"name":"litellm-credentials","managedFields":[
   {"manager":"helm","operation":"Apply","fieldsV1":{"f:data":{"f:UI_PASSWORD":{},"f:masterkey":{}}}}]},
  "data":{"UI_PASSWORD":"$(b64 "$OTHER")","masterkey":"$(b64 "$OTHER")"}},
 {"metadata":{"name":"dagster-postgresql","managedFields":[
   {"manager":"rotate-secrets","operation":"Apply","fieldsV1":{"f:data":{"f:postgresql-password":{}}}}]},
  "data":{"postgresql-password":"$(b64 "$LIVE_PW")"}}
]}
JSON
render() { # <valkey password in the render> <UI password in the render>
  cat <<YAML
apiVersion: v1
kind: Secret
metadata: {name: valkey-credentials}
stringData: {password: "$1"}
---
apiVersion: v1
kind: Secret
metadata: {name: litellm-credentials}
data: {UI_PASSWORD: "$(b64 "$2")", masterkey: "$(b64 "$OTHER")"}
YAML
}
printf '#!/usr/bin/env bash\n[ -n "${FAKE_FAIL:-}" ] && { echo "connection refused" >&2; exit 1; }\ncase "$*" in *"get secrets"*) cat "%s" ;; *) exit 1 ;; esac\n' "$T/secrets.json" > "$T/kubectl"; chmod +x "$T/kubectl"
# The private overlays: the round-2 overlay whose value is the cluster's, and an unrelated one.
SD=$T/secrets-dir; mkdir -p "$SD/overlays"; chmod -R 700 "$SD"
printf 'valkey:\n  local:\n    password: %s\n' "$LIVE_PW" > "$SD/overlays/datastores-20261121T000000Z.yaml"
printf '{"path":"datastores","items":[["valkey","valkey-credentials","password","valkey.local.password","",""]]}' > "$SD/overlays/datastores-20261121T000000Z.state.json"
printf 'valkey:\n  local:\n    password: %s\n' "$OTHER" > "$SD/overlays/datastores-20261120T000000Z.yaml"
printf '{"path":"datastores","items":[["valkey","valkey-credentials","password","valkey.local.password","",""]]}' > "$SD/overlays/datastores-20261120T000000Z.state.json"
guard() { out=$(KUBECTL="$T/kubectl" SOVEREIGN_SECRETS_DIR="$SD" ROTATION_IN_PROGRESS=${RIP:-} GITHUB_ACTIONS=${GHA:-} FAKE_FAIL=${FAKE_FAIL:-} $G --what "${WHAT:-deploy}" "$T/render.yaml" 2>&1); rc=$?; }

echo "red: the render would put the older value back into a key ds-rekey wrote"
render "$OLD_PW" "$OTHER" > "$T/render.yaml"; guard
rc_is "refused" 1
check "  with the refusal code" "ROTATION_DRIFT_REFUSED" "$out"
check "  naming the Secret key" "valkey-credentials/password" "$out"
check "  with both fingerprints (cluster, render)" "$(h12 "$LIVE_PW")" "$out"
check "  ... render" "$(h12 "$OLD_PW")" "$out"
check "  naming the overlay that holds the cluster's value" "VALUES_OVERLAY=$SD/overlays/datastores-20261121T000000Z.yaml" "$out"
absent "  not the unrelated overlay" "datastores-20261120T000000Z.yaml" "$out"
check "  and the way out" "ROTATION_IN_PROGRESS=1" "$out"
for v in "$LIVE_PW" "$OLD_PW" "$OTHER"; do absent "  no value printed" "$v" "$out"; done
WHAT=rollback guard
check "  a rollback says so" "this rollback" "$out"

echo "ROTATION_IN_PROGRESS: the operator says the window is open"
RIP=1 guard
rc_is "passes" 0
check "  loudly" "WARNING" "$out"
check "  naming the key" "valkey-credentials/password" "$out"

echo "never from a pipeline: ROTATION_IN_PROGRESS inside CI (GITHUB_ACTIONS=true) is refused"
RIP=1 GHA=true guard
rc_is "refused" 1
check "  saying why" "ROTATION_IN_PROGRESS is set inside a CI pipeline" "$out"
GHA=true render "$LIVE_PW" "$OTHER" > "$T/render.yaml"; RIP=1 GHA=true guard
rc_is "  twin: in CI without drift, nothing to override: passes" 0
render "$OLD_PW" "$OTHER" > "$T/render.yaml"
wf=$(grep -rln 'ROTATION_IN_PROGRESS' .github/ 2>/dev/null || true)
holds "no workflow sets or passes ROTATION_IN_PROGRESS (dev.yml, prod.yml, …): [${wf}]" [ -z "$wf" ]

echo "negative twins"
render "$LIVE_PW" "$OTHER" > "$T/render.yaml"; guard
rc_is "the render carries the cluster's value (the overlay is in the values): passes" 0
check "  and says how many keys it compared" "1 key(s) managed by rotate-secrets" "$out"
render "$LIVE_PW" "changed-by-values-$(openssl rand -hex 4)" > "$T/render.yaml"; guard
rc_is "a difference in a key rotate-secrets does not manage (UI_PASSWORD, helm only): passes" 0
check "  dagster-postgresql (not in the render) cannot be overwritten: noted" "dagster-postgresql/postgresql-password: not in the render" "$out"
printf 'valkey:\n  local:\n    password: nope\n' > "$SD/overlays/datastores-20261121T000000Z.yaml"
render "$OLD_PW" "$OTHER" > "$T/render.yaml"; guard
rc_is "no overlay holds the cluster's value: still refused" 1
check "  and says where to look" "no overlay under $SD/overlays holds the cluster's value" "$out"

echo "fail closed"
FAKE_FAIL=1 guard
rc_is "kubectl fails: refused (exit 2)" 2
check "  says it could not read the Secrets" "cannot read the Secrets" "$out"
printf '#!/usr/bin/env bash\nexit 0\n' > "$T/kubectl-empty"; chmod +x "$T/kubectl-empty"
out=$(KUBECTL="$T/kubectl-empty" $G --what deploy "$T/render.yaml" 2>&1); rc=$?
rc_is "kubectl answers nothing: refused (exit 2)" 2

echo "wired into deploy.sh and rollback.sh, before anything changes"
check "deploy.sh runs the guard on the render it applies" 'rotation-drift-guard.py --what deploy "$WORK/after.yaml"' "$(cat scripts/deploy.sh)"
check "rollback.sh runs it on the target revision's manifest" 'rotation-drift-guard.py --what rollback "$CAPF.tgt"' "$(cat scripts/rollback.sh)"
dl=$(grep -n 'rotation-drift-guard.py' scripts/deploy.sh | head -1 | cut -d: -f1); hl=$(grep -n '^helm --kube-context "$CTX" upgrade' scripts/deploy.sh | head -1 | cut -d: -f1);
before() { python3 -c 'import sys; a, b = sys.argv[1:]; sys.exit(0 if a and b and int(a) < int(b) else 1)' "$1" "$2"; }
holds "  deploy.sh: before the helm upgrade" before "$dl" "$hl"
rl=$(grep -n 'rotation-drift-guard.py' scripts/rollback.sh | head -1 | cut -d: -f1); rr=$(grep -n 'rollback "$REL" "$TARGET"' scripts/rollback.sh | head -1 | cut -d: -f1)
holds "  rollback.sh: before the helm rollback" before "$rl" "$rr"
finish rotation-drift-guard
