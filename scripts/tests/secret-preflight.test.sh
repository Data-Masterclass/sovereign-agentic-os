#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# scripts/lib/check-secrets-not-defaults.py — the deploy's secret preflight, on the paths the
# render does not cover: a Secret that exists only in the cluster (read through a fake kubectl),
# missing, unreadable, and a release whose rendered Secrets are clean. Never prints a value.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CHECK=scripts/lib/check-secrets-not-defaults.py
b64() { printf %s "$1" | base64 | tr -d '\n'; }

# A manifest whose os-ui reads every guarded secret from Secrets the render does NOT carry.
cat > "$TMP/after.yaml" <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata: { name: os-ui }
spec:
  template:
    spec:
      containers:
        - name: os-ui
          env:
            - { name: LITELLM_MASTER_KEY, valueFrom: { secretKeyRef: { name: gw, key: masterkey } } }
            - { name: AGENT_RUNTIME_TOKEN, valueFrom: { secretKeyRef: { name: rt, key: token } } }
            - { name: OS_SESSION_SECRET, valueFrom: { secretKeyRef: { name: sess, key: s } } }
            - { name: LANGFUSE_PUBLIC_KEY, value: "pk-lf-test-not-a-default" }
            - { name: LANGFUSE_SECRET_KEY, valueFrom: { secretKeyRef: { name: lf, key: sk } } }
YAML
# fake kubectl: `get secret <name> -o json` answers from $TMP/secrets/<name>.json
mkdir -p "$TMP/secrets" "$TMP/bin"
cat > "$TMP/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
[ "$1 $2" = "get secret" ] || exit 9
f="$SECRETS/$3.json"
[ -n "${KUBECTL_FAIL:-}" ] && { echo "connection refused" >&2; exit 1; }
[ -f "$f" ] || { echo "Error from server (NotFound): secrets \"$3\" not found" >&2; exit 1; }
cat "$f"
STUB
chmod +x "$TMP/bin/kubectl"
put() { printf '{"data":{"%s":"%s"}}' "$2" "$(b64 "$3")" > "$TMP/secrets/$1.json"; }
run() { out=$(SECRETS=$TMP/secrets KUBECTL="$TMP/bin/kubectl" python3 "$CHECK" "$TMP/after.yaml" 2>&1); rc=$?; }

put gw masterkey "sk-test-$(printf 'a%.0s' {1..32})"
put rt token "rt-test-$(printf 'b%.0s' {1..32})"
put sess s "session-test-$(printf 'c%.0s' {1..32})"
put lf sk "sk-lf-test-$(printf 'd%.0s' {1..16})"

echo "== cluster Secrets with their own values"
run; rc_is "clean exits 0" 0
check "it reports what it checked" "5 guarded values checked by hash" "$out"

echo "== the gateway key in the cluster equals the public default (negative twin)"
put gw masterkey "sk-litellm-local-dev-master"
run; rc_is "exits 1" 1
check "names the variable and its source" "os-ui: LITELLM_MASTER_KEY (Secret gw/masterkey) equals a public development default" "$out"
absent "never prints the value" "sk-litellm-local-dev-master" "$out"
put gw masterkey "sk-test-$(printf 'a%.0s' {1..32})"

echo "== the chart's runtime-token default (not only the code fallback)"
put rt token "agent-runtime-local-dev-token"
run; rc_is "exits 1" 1
check "names it" "AGENT_RUNTIME_TOKEN (Secret rt/token) equals a public development default" "$out"
put rt token "rt-test-$(printf 'b%.0s' {1..32})"

echo "== a Secret that does not exist"
rm "$TMP/secrets/lf.json"
run; rc_is "exits 1" 1
check "reports it missing" "LANGFUSE_SECRET_KEY (Secret lf/sk) is missing or empty" "$out"

echo "== kubectl cannot read the cluster"
out=$(KUBECTL_FAIL=1 SECRETS=$TMP/secrets KUBECTL="$TMP/bin/kubectl" python3 "$CHECK" "$TMP/after.yaml" 2>&1); rc=$?
rc_is "exits 2 (could not check — the deploy stops too)" 2

echo "== TERMINAL_ENABLED=true makes the broker secret required"
put lf sk "sk-lf-test-$(printf 'd%.0s' {1..16})"
python3 - "$TMP/after.yaml" <<'PY'
import sys; p=sys.argv[1]; s=open(p).read()
s=s.replace('            - { name: LANGFUSE_PUBLIC_KEY', '            - { name: TERMINAL_ENABLED, value: "true" }\n            - { name: LANGFUSE_PUBLIC_KEY')
open(p,'w').write(s)
PY
run; rc_is "exits 1" 1
check "reports it" "os-ui: TERMINAL_BROKER_SECRET is not set" "$out"

finish secret-preflight.test
