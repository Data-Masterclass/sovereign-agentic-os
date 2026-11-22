#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# smoke-test.test.sh — scripts/smoke-test.sh against a fake cluster: no kubectl, no network.
# =============================================================================
#   bash scripts/tests/smoke-test.test.sh
#
# kubectl, helm and curl are stubs on PATH. Each answers from a file in $FAKE (one per
# question), so every case below starts from a healthy fake cluster (`healthy`) and breaks
# exactly one thing. The release values the helm stub serves carry a FAKE password, and the
# output is checked never to contain it — the smoke test must only ever print the keys it uses.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
# shellcheck source=scripts/tests/assert.sh
. scripts/tests/assert.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
BIN=$TMP/bin FAKE=$TMP/fake
mkdir -p "$BIN" "$FAKE"
export FAKE

cat > "$BIN/kubectl" <<'STUB'
#!/usr/bin/env bash
# Answers: deploy-<name>, pods-<namespace>, ingress, worker-log, pvc, configmap.
ns=; prev=
for a in "$@"; do [ "$prev" = -n ] && ns=$a; prev=$a; done
case "$*" in
  *"get deploy "*)      name=$(printf '%s' "$*" | sed 's/.*get deploy \([^ ]*\).*/\1/')
                        cat "$FAKE/deploy-$name" 2>/dev/null || exit 1 ;;
  *"get endpointslices"*) cat "$FAKE/opa-endpoints" 2>/dev/null ;;
  *"get pods"*)         cat "$FAKE/pods-$ns" 2>/dev/null ;;
  *"get ingress"*)      cat "$FAKE/ingress" ;;
  *"logs deploy/os-ui-worker"*) cat "$FAKE/worker-log" ;;
  *"get pvc clickhouse-data"*)  cat "$FAKE/pvc" ;;
  *"get configmap agentic-os-litellm-config"*) cat "$FAKE/configmap" 2>/dev/null || exit 1 ;;
  *"exec deploy/agentic-os-dagster-daemon"*) cat "$FAKE/daemon-probe" 2>/dev/null || exit 1 ;;
  *"port-forward svc/agentic-os-langfuse-web"*)
                        [ -f "$FAKE/langfuse-health" ] || { echo "error: no such service" >&2; exit 1; }
                        echo "Forwarding from 127.0.0.1:41234 -> 3000"; exec sleep 30 ;;
  *) echo "fake kubectl: unexpected $*" >&2; exit 9 ;;
esac
STUB
cat > "$BIN/helm" <<'STUB'
#!/usr/bin/env bash
case "$*" in *"get values agentic-os"*"-a -o json"*) cat "$FAKE/values.json" ;; *) exit 9 ;; esac
STUB
cat > "$BIN/curl" <<'STUB'
#!/usr/bin/env bash
# The http code for a URL is the content of $FAKE/code-<host>; no file = no answer (000).
url=${*: -1}
case $url in
  # Langfuse through the port-forward: the body, a newline, the http code (curl -w '\n%{http_code}').
  http://127.0.0.1:41234/api/public/health*) printf '%s' "$url" > "$FAKE/langfuse-url"; cat "$FAKE/langfuse-health"; exit 0 ;;
esac
host=${url#https://}; host=${host%%/*}
cat "$FAKE/code-$host" 2>/dev/null || printf '000'
STUB
chmod +x "$BIN"/*

healthy() {
  rm -f "$FAKE"/*
  for d in os-ui os-ui-worker; do echo "ghcr.io/x/os-ui:1.2.3@sha256:aaa|1|1|1" > "$FAKE/deploy-$d"; done
  printf 'os-ui-abc \npg-0 \n' > "$FAKE/pods-agentic-os"
  printf 'app-ok \n' > "$FAKE/pods-agentic-apps"
  printf 'os-ui\nagentic-os-dagster-webserver\n' > "$FAKE/ingress"
  echo 'boot: checkpointer=postgres jobs=on resumeHook=on approvals=on langfuse=on systems=hydrated' > "$FAKE/worker-log"
  echo 30Gi > "$FAKE/pvc"
  printf 'model_list:\n- model_name: a\n  model_info: {mode: chat}\n- model_name: b\n  model_info: {mode: chat}\n' > "$FAKE/configmap"
  cat > "$FAKE/values.json" <<'JSON'
{"ingress": {"hosts": {"osUI": "os.example.test", "litellm": "litellm.example.test", "langfuse": "langfuse.example.test"}},
 "clickhouse": {"persistence": {"enabled": true, "size": "30Gi"}, "local": {"password": "FAKE_SECRET_PASSWORD_123"}},
 "softwareRunner": {"enabled": true, "namespace": "agentic-apps"},
 "langfuse": {"enabled": true},
 "litellmMasterKey": "sk-FAKE_MASTER_KEY"}
JSON
  echo 200 > "$FAKE/code-os.example.test"
  echo 404 > "$FAKE/code-litellm.example.test"
  printf '{"status":"OK","version":"3.194.1"}\n200' > "$FAKE/langfuse-health"
  echo "ghcr.io/x/dagster:0.4.0|1|1|1" > "$FAKE/deploy-agentic-os-dagster-daemon"
  echo "connected api.example.internal 443" > "$FAKE/daemon-probe"
  echo "ghcr.io/x/opa:1.0@sha256:bbb|1|1|1" > "$FAKE/deploy-opa"
  echo "10.0.0.7" > "$FAKE/opa-endpoints"
}
smoke() { out=$(PATH="$BIN:$PATH" bash scripts/smoke-test.sh "$@" 2>&1); rc=$?; }

echo "== a healthy release"
healthy; smoke --expect-tag 1.2.3
rc_is "a healthy release exits 0" 0
check "it ends with SMOKE_OK" "SMOKE_OK" "$(echo "$out" | tail -1)"
check "both deployments are on the tag" "os-ui-worker runs tag 1.2.3" "$out"
check "the health URL comes from the release values" "https://os.example.test/api/health answers 200" "$out"
check "the gateway hostname comes from the values, and 404 passes" "https://litellm.example.test is not served (404)" "$out"
check "no answer at all also passes" "https://langfuse.example.test is not served (000)" "$out"
check "the model count is reported" "all 2 LiteLLM models carry model_info" "$out"
absent "no secret value from the release is printed" "FAKE_SECRET_PASSWORD" "$out"
absent "no key from the release is printed" "sk-FAKE_MASTER_KEY" "$out"
smoke; rc_is "--expect-tag is optional" 0

echo "== each broken thing fails, and is named"
healthy; smoke --expect-tag 9.9.9
rc_is "a wrong tag exits 1" 1
check "a wrong tag is named" "FAIL  os-ui runs tag 9.9.9 (it runs os-ui:1.2.3@sha256:aaa)" "$out"
check "the summary counts the failures" "SMOKE_FAILED (2)" "$out"

healthy; echo "ghcr.io/x/os-ui:1.2.3|0|1|1" > "$FAKE/deploy-os-ui-worker"; smoke --expect-tag 1.2.3
check "a worker that is not Ready fails" "FAIL  os-ui-worker Ready (ready 0" "$out"
healthy; rm "$FAKE/deploy-os-ui-worker"; smoke
check "a missing worker fails" "FAIL  deployment os-ui-worker exists" "$out"

healthy; printf 'os-ui-abc \nlangfuse-web-1 CrashLoopBackOff \n' > "$FAKE/pods-agentic-os"; smoke
check "a crash-looping platform pod fails" "FAIL  pods stuck in agentic-os: langfuse-web-1 CrashLoopBackOff" "$out"
healthy; printf 'pg-0 ImagePullBackOff \n' > "$FAKE/pods-agentic-os"; smoke
check "an ImagePullBackOff platform pod fails" "pg-0 ImagePullBackOff" "$out"

healthy; printf 'app-a ImagePullBackOff \napp-b CrashLoopBackOff \n' > "$FAKE/pods-agentic-apps"; smoke
rc_is "stuck user-app pods do NOT fail the smoke test" 0
check "but they are listed" "app-a ImagePullBackOff,app-b CrashLoopBackOff" "$out"

healthy; echo 502 > "$FAKE/code-os.example.test"; smoke
check "an unhealthy public URL fails" "FAIL  https://os.example.test/api/health answers 200 (got 502)" "$out"
healthy; smoke --host other.example.test
check "--host overrides the values" "https://other.example.test/api/health" "$out"

healthy; printf 'os-ui\nagentic-os-litellm\n' > "$FAKE/ingress"; smoke
check "an Ingress to the gateway fails, whatever the hostname" "FAIL  no Ingress routes to agentic-os-litellm" "$out"
healthy; echo 200 > "$FAKE/code-langfuse.example.test"; smoke
check "a served Langfuse hostname fails" "FAIL  https://langfuse.example.test is not served (it answers 200)" "$out"

# The operator route (#276): Langfuse behind nginx basic auth from a Secret passes; an open one fails.
healthy; printf '||os-ui,\nbasic|langfuse-basic-auth|agentic-os-langfuse-web,\n' > "$FAKE/ingress"; echo 401 > "$FAKE/code-langfuse.example.test"; smoke
check "Langfuse behind basic auth (operator route) passes" "ok    agentic-os-langfuse-web is routed only behind basic auth (operator route)" "$out"
check "its host answering 401 passes" "ok    https://langfuse.example.test asks for credentials (operator route)" "$out"
healthy; printf '||os-ui,\n||agentic-os-langfuse-web,\n' > "$FAKE/ingress"; smoke
check "an open Ingress to Langfuse fails" "FAIL  no Ingress routes to agentic-os-langfuse-web without basic auth" "$out"
healthy; printf '||os-ui,\nbasic||agentic-os-langfuse-web,\n' > "$FAKE/ingress"; smoke
check "basic auth without a Secret still fails" "FAIL  no Ingress routes to agentic-os-langfuse-web without basic auth" "$out"
healthy; echo 401 > "$FAKE/code-langfuse.example.test"; smoke
check "a 401 on the Langfuse host without the operator route fails" "FAIL  https://langfuse.example.test is not served (it answers 401)" "$out"

healthy; echo 'boot: checkpointer=postgres systems=failed' > "$FAKE/worker-log"; smoke
check "a worker without systems=hydrated fails" "FAIL  os-ui-worker logged its boot line with systems=hydrated" "$out"

healthy; echo 10Gi > "$FAKE/pvc"; smoke
check "a ClickHouse volume below the chart value fails" "FAIL  ClickHouse volume 10Gi >= chart 30Gi" "$out"
healthy; sed -i.bak 's/"size": "30Gi"/"size": "10Gi"/' "$FAKE/values.json"; smoke
check "a release that pins a smaller size than the chart is reported" "the release pins clickhouse.persistence.size=10Gi; the chart asks for 30Gi" "$out"
healthy; echo 32212254720 > "$FAKE/pvc"; smoke
check "a plain byte count is understood" "ClickHouse volume 32212254720 >= chart 30Gi" "$out"

healthy; printf 'model_list:\n- model_name: a\n  model_info: {mode: chat}\n- model_name: unpriced\n' > "$FAKE/configmap"; smoke
check "a model without model_info fails, by name" "missing: unpriced" "$out"
healthy; rm "$FAKE/configmap"; smoke
check "a missing LiteLLM ConfigMap fails" "FAIL  LiteLLM ConfigMap agentic-os-litellm-config readable" "$out"

echo "== Langfuse reads its ClickHouse tables (upstream /api/public/health, deep checks)"
healthy; smoke
check "recent traces pass" "Langfuse reads ClickHouse: OK (Langfuse 3.194.1)" "$out"
check "the health call asks for both deep checks" "failIfDatabaseUnavailable=true&failIfNoRecentEvents=true" "$(cat "$FAKE/langfuse-url")"
healthy; printf '{"status":"No traces within the last 3 minutes","version":"3.194.1"}\n503' > "$FAKE/langfuse-health"; smoke
rc_is "an idle Langfuse (tables there, no recent trace) passes" 0
check "idle is said as such" "Langfuse reads ClickHouse: the tables answer, no trace in the last 3 minutes" "$out"
healthy; printf '{"status":"Couldn'"'"'t fetch recent events","version":"3.194.1"}\n503' > "$FAKE/langfuse-health"; smoke
rc_is "missing ClickHouse tables fail" 1
check "the upstream status is named" "FAIL  Langfuse reads ClickHouse (503: Couldn't fetch recent events)" "$out"
healthy; printf '{"status":"Database not available","version":"3.194.1"}\n503' > "$FAKE/langfuse-health"; smoke
check "a database outage fails" "FAIL  Langfuse reads ClickHouse (503: Database not available)" "$out"
healthy; rm "$FAKE/langfuse-health"; smoke
check "no port-forward fails" "FAIL  Langfuse reachable through kubectl port-forward" "$out"
healthy; sed -i.bak 's/"langfuse": {"enabled": true}/"langfuse": {"enabled": false}/' "$FAKE/values.json"; rm "$FAKE/langfuse-health"; smoke
rc_is "Langfuse off: nothing to check" 0
check "and it is noted" "Langfuse is off: no trace store to check" "$out"

echo "== the Dagster daemon reaches the API server address its pod uses"
healthy; smoke
check "a connected daemon passes" "Dagster daemon reaches the API server (api.example.internal 443)" "$out"
healthy; echo "refused api.example.internal 443 TimeoutError" > "$FAKE/daemon-probe"; smoke
rc_is "a daemon that cannot connect fails the smoke test" 1
check "and the value to fix is named" "FAIL  Dagster daemon reaches the API server (api.example.internal 443 TimeoutError; networkPolicies.apiserver.extraCidrs)" "$out"
healthy; rm "$FAKE/daemon-probe"; smoke
check "no answer from exec fails" "FAIL  Dagster daemon reaches the API server (kubectl exec gave no answer)" "$out"
healthy; rm "$FAKE/deploy-agentic-os-dagster-daemon" "$FAKE/daemon-probe"; smoke
rc_is "no Dagster at all: nothing to check" 0
check "and it is noted" "no Dagster daemon: no run launcher to check" "$out"

echo "== OPA has a ready endpoint behind its Service (dev ran 16 h with none, 21-22 Nov 2026)"
healthy; smoke
check "an OPA with a ready endpoint passes" "ok    opa Service has a ready endpoint" "$out"
healthy; : > "$FAKE/opa-endpoints"; smoke
rc_is "an OPA Service with no ready endpoint fails the smoke test" 1
check "and it says so" "FAIL  opa Service has a ready endpoint (none: every OPA-checked action answers opa-unreachable)" "$out"
healthy; echo "ghcr.io/x/opa:1.0|0|1|1" > "$FAKE/deploy-opa"; smoke
check "an OPA Deployment that is not Ready fails" "FAIL  opa Ready (ready 0" "$out"
healthy; rm "$FAKE/deploy-opa" "$FAKE/opa-endpoints"; smoke
rc_is "no OPA deployed at all: nothing to check" 0
check "and it is noted" "no OPA Deployment: no policy decision point to check" "$out"

echo "== arguments"
smoke --nonsense; rc_is "an unknown argument exits 2" 2

finish smoke-test.test.sh || exit 1
echo "SMOKE_TESTS_OK"
