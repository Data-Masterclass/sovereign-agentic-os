#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# langfuse-ee-queues-chart.test.sh — the Langfuse worker starts none of the queue consumers whose
# job handlers live under worker/src/ee/ (Langfuse Enterprise License).
# =============================================================================
#   bash scripts/tests/langfuse-ee-queues-chart.test.sh
#
# Upstream registers the data-retention consumer whenever QUEUE_CONSUMER_DATA_RETENTION_QUEUE_IS_ENABLED
# is "true", which is its default (worker/src/env.ts at v3.194.1), so EE code ran on every install.
# Renders the chart (no cluster) and asserts, for the default, STACKIT and dev profiles, that the
# langfuse-worker container sets each flag below to "false":
#   QUEUE_CONSUMER_DATA_RETENTION_QUEUE_IS_ENABLED             -> ee/dataRetention
#   QUEUE_CONSUMER_CLOUD_USAGE_METERING_QUEUE_IS_ENABLED       -> ee/cloudUsageMetering
#   QUEUE_CONSUMER_CLOUD_SPEND_ALERT_QUEUE_IS_ENABLED          -> ee/cloudSpendAlerts
#   QUEUE_CONSUMER_FREE_TIER_USAGE_THRESHOLD_QUEUE_IS_ENABLED  -> ee/usageThresholds
#   LANGFUSE_POSTGRES_METERING_DATA_EXPORT_IS_ENABLED          -> ee/meteringDataPostgresExport
# Negative twin: with the worker env removed the assertion fails.
# Skips (exit 0) without helm or the subchart .tgz files — but FAILS when CI is set.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
CHART=charts/sovereign-agentic-os
skip() {
  if [ -n "${CI:-}" ]; then echo "langfuse-ee-queues-chart: $1 — FAILING because CI is set"; exit 1; fi
  echo "langfuse-ee-queues-chart: $1 — SKIPPED"; exit 0
}
command -v helm >/dev/null 2>&1 || skip "helm not on PATH"
ls "$CHART"/charts/*.tgz >/dev/null 2>&1 || skip "chart dependencies not built"

FLAGS="QUEUE_CONSUMER_DATA_RETENTION_QUEUE_IS_ENABLED QUEUE_CONSUMER_CLOUD_USAGE_METERING_QUEUE_IS_ENABLED QUEUE_CONSUMER_CLOUD_SPEND_ALERT_QUEUE_IS_ENABLED QUEUE_CONSUMER_FREE_TIER_USAGE_THRESHOLD_QUEUE_IS_ENABLED LANGFUSE_POSTGRES_METERING_DATA_EXPORT_IS_ENABLED"

render() {
  local e; e=$(mktemp)
  out=$(helm template t "$CHART" -n agentic-os --skip-schema-validation "$@" 2>"$e"); rc=$?
  [ "$rc" -eq 0 ] || out="$out$(cat "$e")"
  rm -f "$e"
}
# container_env <deployment-name-suffix>: "NAME=value" lines (last definition wins, like Kubernetes)
container_env() {
  printf '%s' "$out" | python3 -c '
import sys, yaml
suffix = sys.argv[1]
docs = [d for d in yaml.safe_load_all(sys.stdin) if isinstance(d, dict) and d.get("kind") == "Deployment"]
d = next(x for x in docs if x["metadata"]["name"].endswith(suffix))
env = {}
for e in d["spec"]["template"]["spec"]["containers"][0].get("env") or []:
    env[e["name"]] = e.get("value", "<valueFrom>")
for k, v in env.items():
    print(f"{k}={v}")' "$1" 2>&1
}
all_off() {  # every flag is present with the value "false"
  local envs=$1 f
  for f in $FLAGS; do grep -qx "$f=false" <<<"$envs" || return 1; done
}

# dev refuses the chart's published default secrets (secret-defaults-guard), so its render sets its own
# test literals (the same set scripts/tests/litellm-oss-chart.test.sh uses).
GUARD=(--set-string litellmMasterKey=t1 --set-string litellmUI.password=t2 --set-string agentRuntime.token=t3
  --set-string langfuseInit.publicKey=t4 --set-string langfuseInit.secretKey=t5 --set-string langfuseInit.userPassword=t6
  --set-string langfuseInit.salt=t7 --set-string langfuseInit.nextauthSecret=t8 --set-string langfuseInit.encryptionKey=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef)

for prof in default values.stackit-managed.yaml values.dev.yaml; do
  echo "$prof"
  case $prof in
    default) render ;;
    values.dev.yaml) render -f "$prof" "${GUARD[@]}" ;;
    *) render -f "$prof" ;;
  esac
  rc_is "$prof: renders" 0
  envs=$(container_env langfuse-worker)
  for f in $FLAGS; do check "$prof: worker $f=false" "$f=false" "$envs"; done
  holds "$prof: all EE queue consumers off" all_off "$envs"
done

echo "web is unaffected (the flags are worker-only)"
render
web=$(container_env langfuse-web)
absent "web carries no queue-consumer flag" "QUEUE_CONSUMER_DATA_RETENTION" "$web"

echo "negative twin: worker env removed"
render --set 'langfuse.langfuse.worker.pod.additionalEnv=null'
envs=$(container_env langfuse-worker)
if all_off "$envs"; then bad "removing the worker env must fail the assertion"; else ok "missing flags are caught"; fi

finish langfuse-ee-queues-chart
