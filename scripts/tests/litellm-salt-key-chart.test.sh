#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# litellm-salt-key-chart.test.sh — chart test for LITELLM_SALT_KEY and the rotation values.
# =============================================================================
#   bash scripts/tests/litellm-salt-key-chart.test.sh
#
# Renders the chart (no cluster) and asserts:
#   * default profile, no value: litellm-credentials carries NO LITELLM_SALT_KEY (an existing
#     laptop install renders exactly as before);
#   * default profile, litellmSaltKey.value: rendered into litellm-credentials as
#     LITELLM_SALT_KEY, and the gateway container reads that Secret through envFrom;
#   * STACKIT profile: renders with litellmSaltKey.existingSecret (litellm-credentials, listed in
#     litellm.environmentSecrets) and the chart renders no litellm-credentials of its own;
#   * negative twins: a non-local profile with no existingSecret, with an existingSecret the
#     gateway does not read, or with a literal value fails; the local profile with an
#     existingSecret fails;
#   * langfuseInit.userPassword reaches langfuse-init as LANGFUSE_INIT_USER_PASSWORD;
#   * langfuseInit.{salt,nextauthSecret,encryptionKey} reach langfuse-core-secrets (unset = the
#     previous literals); an encryptionKey that is not 64 hex characters fails the render;
#   * the re-key overlays of rotate-secrets.sh through Helm's values merge: step 1 adds
#     LITELLM_MIGRATE_FROM_MASTER_KEY to the gateway with no salt key; step 2 layered over step 1's
#     values empties it (a null cannot delete a key an earlier values file set), sets the salt key S
#     and the new master key.
# The `lookup` change guard needs an API server: scripts/tests/litellm-salt-key-guard.kind.sh.
# Skips (exit 0) without helm or the subchart .tgz files — but FAILS when CI is set.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
CHART=charts/sovereign-agentic-os
skip() {
  if [ -n "${CI:-}" ]; then echo "litellm-salt-key-chart: $1 — FAILING because CI is set"; exit 1; fi
  echo "litellm-salt-key-chart: $1 — SKIPPED"; exit 0
}
command -v helm >/dev/null 2>&1 || skip "helm not on PATH"
ls "$CHART"/charts/*.tgz >/dev/null 2>&1 || skip "chart dependencies not built"

# stdout only is parsed (helm prints warnings on stderr); a failure's message is on stderr.
render() {
  local e; e=$(mktemp)
  out=$(helm template t "$CHART" -n agentic-os --skip-schema-validation "$@" 2>"$e"); rc=$?
  [ "$rc" -eq 0 ] || out="$out$(cat "$e")"
  rm -f "$e"
}
# inspect <python expression over `by` (kind,name)->doc> — prints the result
inspect() {
  printf '%s' "$out" | PYEXPR="$1" python3 -c '
import json, os, sys, yaml
docs = [d for d in yaml.safe_load_all(sys.stdin) if isinstance(d, dict) and d.get("kind")]
by = {(d["kind"], d["metadata"]["name"]): d for d in docs}
def sd(name): return ((by.get(("Secret", name)) or {}).get("stringData") or {})
def gw():
    d = by[("Deployment", "t-litellm")] if ("Deployment", "t-litellm") in by else next(x for (k, n), x in by.items() if k == "Deployment" and n.endswith("litellm"))
    c = d["spec"]["template"]["spec"]["containers"][0]
    return [e.get("secretRef", {}).get("name") for e in c.get("envFrom", [])]
print(eval(os.environ["PYEXPR"]))' 2>&1
}
H() { printf '%s' "$1" | shasum -a 256 | cut -c1-16; }   # compare by hash, never print a value

echo "default profile, no salt key"
render
rc_is "renders" 0
check "litellm-credentials has no LITELLM_SALT_KEY" "False" "$(inspect '"LITELLM_SALT_KEY" in sd("litellm-credentials")')"
check "langfuse-init password from langfuseInit.userPassword (default)" "$(H langfuse-local-dev-admin)" \
  "$(H "$(inspect 'sd("langfuse-init")["LANGFUSE_INIT_USER_PASSWORD"]')")"

echo "default profile, litellmSaltKey.value"
SALT="salt-$RANDOM-$RANDOM"
render --set "litellmSaltKey.value=$SALT" --set "langfuseInit.userPassword=pw-$SALT"
rc_is "renders" 0
check "LITELLM_SALT_KEY rendered into litellm-credentials" "$(H "$SALT")" \
  "$(H "$(inspect 'sd("litellm-credentials").get("LITELLM_SALT_KEY")')")"
check "gateway container reads litellm-credentials via envFrom" "litellm-credentials" "$(inspect 'gw()')"
check "LANGFUSE_INIT_USER_PASSWORD follows the value" "$(H "pw-$SALT")" \
  "$(H "$(inspect 'sd("langfuse-init")["LANGFUSE_INIT_USER_PASSWORD"]')")"

echo "STACKIT profile"
render -f values.stackit-managed.yaml
rc_is "renders with existingSecret=litellm-credentials" 0
check "the chart renders no litellm-credentials there" "False" "$(inspect '("Secret", "litellm-credentials") in by')"
check "gateway reads the existingSecret" "litellm-credentials" "$(inspect 'gw()')"

echo "negative twins"
render -f values.stackit-managed.yaml --set litellmSaltKey.existingSecret=
rc_is "non-local without existingSecret fails" 1
check "  ... naming the value to set" "litellmSaltKey.existingSecret is required" "$out"
render -f values.stackit-managed.yaml --set litellmSaltKey.existingSecret=some-other-secret
rc_is "existingSecret not read by the gateway fails" 1
check "  ... saying so" "is not listed in litellm.environmentSecrets" "$out"
render -f values.stackit-managed.yaml --set litellmSaltKey.value=x
rc_is "a literal value on a non-local profile fails" 1
check "  ... saying where it belongs" "rendered only on the local profile" "$out"
absent "  ... without printing the value" "value=x" "$out"
render --set litellmSaltKey.existingSecret=litellm-credentials
rc_is "existingSecret on the local profile fails" 1

echo "Langfuse core secrets from langfuseInit.{salt,nextauthSecret,encryptionKey}"
render
check "default salt unchanged" "$(H sovereign-os-local-dev-salt)" "$(H "$(inspect 'sd("langfuse-core-secrets")["salt"]')")"
EK=$(printf 'k%.0s' 1 | shasum -a 256 | cut -c1-64)
render --set "langfuseInit.salt=s-$SALT" --set "langfuseInit.nextauthSecret=n-$SALT" --set "langfuseInit.encryptionKey=$EK"
rc_is "renders with new values" 0
check "salt follows the value" "$(H "s-$SALT")" "$(H "$(inspect 'sd("langfuse-core-secrets")["salt"]')")"
check "nextauthSecret follows the value" "$(H "n-$SALT")" "$(H "$(inspect 'sd("langfuse-core-secrets")["nextauthSecret"]')")"
check "encryptionKey follows the value" "$(H "$EK")" "$(H "$(inspect 'sd("langfuse-core-secrets")["encryptionKey"]')")"
render --set langfuseInit.encryptionKey=not-hex
rc_is "an encryptionKey that is not 64 hex characters fails" 1
check "  ... saying how to make one" "openssl rand -hex 32" "$out"
absent "  ... without printing the value" "not-hex" "$out"

echo "re-key overlays (as scripts/lib/rotation-files.py writes them) through Helm's values merge"
OV=$(mktemp -d); trap 'rm -rf "$OV"' EXIT
OLDK="sk-old-$RANDOM"; SK1="sk-salt-$RANDOM$RANDOM"; MK2="sk-new-$RANDOM$RANDOM"
printf '{"path":"rekey","cluster":{"uid":"u","context":"c","namespace":"agentic-os","release":"t","version":"v"},"counts":{"columns":{},"total":{"effective":0}},"old":{"master":"%s"},"new":{"master":"%s","salt":"%s"}}' "$OLDK" "$MK2" "$SK1" \
  | python3 scripts/lib/rotation-files.py write "$OV" t >/dev/null
envnames() { inspect '[e["name"] for d in [x for (k, n), x in by.items() if k == "Deployment" and n.endswith("litellm")] for e in d["spec"]["template"]["spec"]["containers"][0].get("env", [])]'; }
render -f "$OV/rotation-t.step1.yaml"
rc_is "step 1 renders" 0
check "step 1: the gateway gets LITELLM_MIGRATE_FROM_MASTER_KEY" "LITELLM_MIGRATE_FROM_MASTER_KEY" "$(envnames)"
check "step 1: masterkey = S" "$(H "$SK1")" "$(H "$(inspect 'sd("litellm-credentials")["masterkey"]')")"
check "step 1: no salt key yet (the migration runs only without one)" "False" "$(inspect '"LITELLM_SALT_KEY" in sd("litellm-credentials")')"
# deploy.sh layers the overlay over the release values, which after step 1 hold the variable.
render -f "$OV/rotation-t.step1.yaml" -f "$OV/rotation-t.yaml"
rc_is "step 2 over step 1's values renders" 0
check "step 2: the variable is EMPTY on the gateway (the old key is gone from its env)" "['']" "$(inspect '[e.get("value") or "" for d in [x for (k, n), x in by.items() if k == "Deployment" and n.endswith("litellm")] for e in d["spec"]["template"]["spec"]["containers"][0].get("env", []) if e["name"] == "LITELLM_MIGRATE_FROM_MASTER_KEY"]')"
absent "  ... the old key is nowhere in the gateway Deployment" "$OLDK" "$(inspect 'json.dumps([x for (k, n), x in by.items() if k == "Deployment" and n.endswith("litellm")])' 2>/dev/null || true)"
check "step 2: salt key = S" "$(H "$SK1")" "$(H "$(inspect 'sd("litellm-credentials")["LITELLM_SALT_KEY"]')")"
check "step 2: masterkey = M" "$(H "$MK2")" "$(H "$(inspect 'sd("litellm-credentials")["masterkey"]')")"
render -f "$OV/rotation-t.step1.yaml" -f "$OV/rotation-t.rollback-step1.yaml"
check "rollback of step 1: migrates back from S" "LITELLM_MIGRATE_FROM_MASTER_KEY" "$(envnames)"
check "  ... to the old master key" "$(H "$OLDK")" "$(H "$(inspect 'sd("litellm-credentials")["masterkey"]')")"

finish litellm-salt-key-chart
