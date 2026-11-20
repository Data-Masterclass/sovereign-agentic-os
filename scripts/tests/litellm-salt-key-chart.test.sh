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
#   * langfuseInit.userPassword reaches langfuse-init as LANGFUSE_INIT_USER_PASSWORD.
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
import os, sys, yaml
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

finish litellm-salt-key-chart
