#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# apiserver-egress.test.sh — the API server address the pods really use is admitted.
# =============================================================================
#   bash scripts/tests/apiserver-egress.test.sh
#
# On Gardener (STACKIT SKE) every pod's KUBERNETES_SERVICE_HOST is the API server's DOMAIN
# (gardener-resource-manager webhook kubernetes-service-host), so in-cluster clients connect to
# the address it resolves to, not to the `kubernetes` endpoint. Dev's Dagster daemon timed out on
# every run Job (21 Nov 2026) because `allow-apiserver-egress` admitted the endpoint only.
#   1. chart: networkPolicies.apiserver.extraCidrs is added to the narrowed rule; the twin without
#      it does NOT admit the address; with no known endpoint the rule stays un-narrowed.
#   2. scripts/lib/apiserver-cidrs.py: reads the injected host from the pods (fake kubectl),
#      resolves it, prints the overlay; no injected host = exit 1; an unresolvable one = exit 2.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
CHART=charts/sovereign-agentic-os
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
EP=240.0.0.9/32 GW=198.51.100.7/32

cidrs() { # cidrs <helm args...> -> the ipBlocks of allow-apiserver-egress, one per line ("none" when un-narrowed)
  helm template agentic-os "$CHART" -n agentic-os --skip-schema-validation "$@" 2>/dev/null | python3 -c '
import sys, yaml
for d in yaml.safe_load_all(sys.stdin):
    if d and d.get("kind") == "NetworkPolicy" and d["metadata"]["name"] == "allow-apiserver-egress":
        to = d["spec"]["egress"][0].get("to")
        print("\n".join(t["ipBlock"]["cidr"] for t in to) if to else "none")'
}

echo "== chart"
both=$(cidrs --set "networkPolicies.apiserver.cidrs={$EP}" --set "networkPolicies.apiserver.extraCidrs={$GW}")
check "extraCidrs is admitted next to the endpoint" "$GW" "$both"
check "the endpoint stays admitted" "$EP" "$both"
twin=$(cidrs --set "networkPolicies.apiserver.cidrs={$EP}")
absent "twin: without extraCidrs the injected address is NOT admitted" "$GW" "$twin"
offline=$(cidrs --set "networkPolicies.apiserver.extraCidrs={$GW}")
check "no known endpoint: the rule stays un-narrowed (extraCidrs alone never narrows it)" "none" "$offline"

echo "== scripts/lib/apiserver-cidrs.py"
mkdir -p "$TMP/bin"
cat > "$TMP/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
cat "$FAKE_PODS"
STUB
chmod +x "$TMP/bin/kubectl"
pods() { printf '{"items":[{"spec":{"containers":[{"name":"a","env":[%s]}]}}]}' "$1" > "$TMP/pods.json"; }
run() { out=$(FAKE_PODS="$TMP/pods.json" PATH="$TMP/bin:$PATH" python3 scripts/lib/apiserver-cidrs.py --context x --namespace y 2>"$TMP/err"); rc=$?; }
pods '{"name":"KUBERNETES_SERVICE_HOST","value":"localhost"}'; run
rc_is "an injected host resolves: exit 0" 0
check "its address is printed as extraCidrs" 'extraCidrs: ["127.0.0.1/32"]' "$out"
pods '{"name":"KUBERNETES_SERVICE_HOST","value":"203.0.113.5"}'; run
check "an injected IP literal is used as it is" '"203.0.113.5/32"' "$out"
pods '{"name":"OTHER","value":"x"}'; run
rc_is "no injected host (not Gardener): exit 1" 1
[ -z "$out" ] && ok "and nothing is printed" || bad "and nothing is printed" "got: $out"
pods '{"name":"KUBERNETES_SERVICE_HOST","value":"no-such-host.invalid"}'; run
rc_is "an injected host that does not resolve: exit 2 (the deploy stops)" 2
check "and it is named" "APISERVER_HOST_UNRESOLVED" "$(cat "$TMP/err")"

finish apiserver-egress.test.sh || exit 1
echo "APISERVER_EGRESS_TESTS_OK"
