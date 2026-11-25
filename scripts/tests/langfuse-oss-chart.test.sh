#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# langfuse-oss-chart.test.sh — Langfuse runs OUR images (images/extensions/langfuse-oss, no Enterprise
# Edition code) by default, pinned by digest, at the base path /tools/langfuse; the rollback overlay
# brings the upstream images back at the site root.
# =============================================================================
#   bash scripts/tests/langfuse-oss-chart.test.sh
#
# Renders the chart (no cluster) and asserts:
#   * default, STACKIT and dev: langfuse-web and langfuse-worker run
#     ghcr.io/data-masterclass/sovereign-os/langfuse-oss-{web,worker}:<tag>@sha256:<64 hex> with the pull
#     secret registry-pull-secret (the org packages are private);
#   * everything that talks to Langfuse uses the base path the web image is built with:
#     the web probes (/tools/langfuse/api/public/health|ready), os-ui LANGFUSE_URL, LiteLLM LANGFUSE_HOST,
#     the OTel collector's Langfuse exporter, and NEXTAUTH_URL (<url>/tools/langfuse);
#   * deploy/overlays/langfuse-oss-image.yaml equals the chart default;
#   * deploy/overlays/langfuse-upstream-image.yaml (rollback): the upstream 3.194.1 digests, no pull
#     secret, every address back at the site root, the EE queue consumers still off;
#   * telemetry off (owner, 2026-11-25: "telemetry off makes sense."): langfuse-web and langfuse-worker
#     carry exactly one TELEMETRY_ENABLED, "false", in every profile and in both overlays;
#   * negative twins: a tag without a digest is caught; the upstream image with the base-path addresses
#     (a half rollback) is caught; telemetry switched on is caught.
# Skips (exit 0) without helm or the subchart .tgz files — but FAILS when CI is set.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
CHART=charts/sovereign-agentic-os
skip() {
  if [ -n "${CI:-}" ]; then echo "langfuse-oss-chart: $1 — FAILING because CI is set"; exit 1; fi
  echo "langfuse-oss-chart: $1 — SKIPPED"; exit 0
}
command -v helm >/dev/null 2>&1 || skip "helm not on PATH"
ls "$CHART"/charts/*.tgz >/dev/null 2>&1 || skip "chart dependencies not built"

render() {
  local e; e=$(mktemp)
  out=$(helm template t "$CHART" -n agentic-os --skip-schema-validation "$@" 2>"$e"); rc=$?
  [ "$rc" -eq 0 ] || out="$out$(cat "$e")"
  rm -f "$e"
}
# facts: one "key=value" line per fact the assertions read
facts() {
  printf '%s' "$out" | python3 -c '
import sys, yaml
docs = [d for d in yaml.safe_load_all(sys.stdin) if isinstance(d, dict)]
def dep(suffix):
    return next(x for x in docs if x.get("kind") == "Deployment" and x["metadata"]["name"].endswith(suffix))
def env(c):
    return {e["name"]: e.get("value", "<valueFrom>") for e in c.get("env") or []}
for role in ("web", "worker"):
    s = dep("langfuse-" + role)["spec"]["template"]["spec"]
    c = s["containers"][0]
    print(role + ".image=" + c["image"])
    tel = [e.get("value", "<valueFrom>") for e in c.get("env") or [] if e["name"] == "TELEMETRY_ENABLED"]
    print(f"{role}.telemetry=" + ",".join(tel) if tel else f"{role}.telemetry=unset")
    print(f"{role}.pull=" + (",".join(p["name"] for p in s.get("imagePullSecrets") or []) or "none"))
    if role == "web":
        print("web.liveness=" + c["livenessProbe"]["httpGet"]["path"])
        print("web.readiness=" + c["readinessProbe"]["httpGet"]["path"])
        print("web.nextauth=" + env(c).get("NEXTAUTH_URL", "unset"))
    else:
        print("worker.retention=" + env(c).get("QUEUE_CONSUMER_DATA_RETENTION_QUEUE_IS_ENABLED", "unset"))
osui = dep("os-ui")["spec"]["template"]["spec"]["containers"][0]
print("osui.LANGFUSE_URL=" + env(osui).get("LANGFUSE_URL", "unset"))
sec = [x for x in docs if x.get("kind") == "Secret" and (x.get("stringData") or {}).get("LANGFUSE_HOST")]
print("litellm.LANGFUSE_HOST=" + (sec[0]["stringData"]["LANGFUSE_HOST"] if sec else "unset"))
' 2>&1
}
fact() { grep -m1 "^$1=" <<<"$F" | cut -d= -f2-; }
OURS_WEB='^ghcr\.io/data-masterclass/sovereign-os/langfuse-oss-web:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$'
OURS_WORKER='^ghcr\.io/data-masterclass/sovereign-os/langfuse-oss-worker:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$'
UP_WEB='langfuse/langfuse:3.194.1@sha256:571446cb16a5d66707f094e638bb156cb9cebaa992d76a7213d2150ce9e1ee18'
UP_WORKER='langfuse/langfuse-worker:3.194.1@sha256:90df7fbd475abd66b1a9a2e10c99f542a94670a6fc898ddd5809ac3147e601f8'
matches() { echo "$2" | grep -Eq "$1"; }
ends_bp() { case $1 in */tools/langfuse) return 0 ;; *) return 1 ;; esac; }

GUARD=(--set-string litellmMasterKey=t1 --set-string litellmUI.password=t2 --set-string agentRuntime.token=t3
  --set-string langfuseInit.publicKey=t4 --set-string langfuseInit.secretKey=t5 --set-string langfuseInit.userPassword=t6
  --set-string langfuseInit.salt=t7 --set-string langfuseInit.nextauthSecret=t8 --set-string langfuseInit.encryptionKey=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef)

DEF_WEB=""; DEF_WORKER=""
for prof in default values.stackit-managed.yaml values.dev.yaml; do
  echo "$prof"
  case $prof in default) render ;; values.dev.yaml) render -f "$prof" "${GUARD[@]}" ;; *) render -f "$prof" ;; esac
  rc_is "$prof: renders" 0
  F=$(facts)
  holds "$prof: web runs our image, pinned by digest ($(fact web.image))" matches "$OURS_WEB" "$(fact web.image)"
  holds "$prof: worker runs our image, pinned by digest ($(fact worker.image))" matches "$OURS_WORKER" "$(fact worker.image)"
  check "$prof: web pull secret" "registry-pull-secret" "$(fact web.pull)"
  check "$prof: worker pull secret" "registry-pull-secret" "$(fact worker.pull)"
  check "$prof: liveness under the base path" "/tools/langfuse/api/public/health" "$(fact web.liveness)"
  check "$prof: readiness under the base path" "/tools/langfuse/api/public/ready" "$(fact web.readiness)"
  holds "$prof: NEXTAUTH_URL ends with the base path ($(fact web.nextauth))" ends_bp "$(fact web.nextauth)"
  holds "$prof: os-ui LANGFUSE_URL ends with the base path ($(fact osui.LANGFUSE_URL))" ends_bp "$(fact osui.LANGFUSE_URL)"
  if [ "$prof" = values.stackit-managed.yaml ]; then
    # STACKIT: litellm-credentials comes from the secret store; its LANGFUSE_HOST must carry the base path
    # (docs/components/langfuse-oss.md "Base path"). The chart renders no value to check.
    check "$prof: LiteLLM LANGFUSE_HOST is the secret store's (not rendered)" "unset" "$(fact litellm.LANGFUSE_HOST)"
  else
    holds "$prof: LiteLLM LANGFUSE_HOST ends with the base path ($(fact litellm.LANGFUSE_HOST))" ends_bp "$(fact litellm.LANGFUSE_HOST)"
  fi
  check "$prof: EE queue consumers still off" "false" "$(fact worker.retention)"
  check "$prof: web telemetry off" "false" "$(fact web.telemetry)"
  check "$prof: worker telemetry off" "false" "$(fact worker.telemetry)"
  if [ "$prof" = default ]; then DEF_WEB=$(fact web.image); DEF_WORKER=$(fact worker.image); fi
done

echo "OTel collector (observability.collector.litellmLangfuse) exports to the base path"
render --set observability.collector.litellmLangfuse.enabled=true
check "collector exporter endpoint" "/tools/langfuse/api/public/otel" "$out"

echo "deploy/overlays/langfuse-oss-image.yaml (return after a rollback)"
render -f deploy/overlays/langfuse-oss-image.yaml
F=$(facts)
check "web equals the chart default" "$DEF_WEB" "$(fact web.image)"
check "worker equals the chart default" "$DEF_WORKER" "$(fact worker.image)"
check "web telemetry off" "false" "$(fact web.telemetry)"
check "worker telemetry off" "false" "$(fact worker.telemetry)"

echo "deploy/overlays/langfuse-upstream-image.yaml (rollback)"
render -f deploy/overlays/langfuse-upstream-image.yaml
rc_is "renders" 0
F=$(facts)
check "web back on the upstream image" "$UP_WEB" "$(fact web.image)"
check "worker back on the upstream image" "$UP_WORKER" "$(fact worker.image)"
check "no pull secret for the public web image" "none" "$(fact web.pull)"
check "no pull secret for the public worker image" "none" "$(fact worker.pull)"
check "liveness at the root" "/api/public/health" "$(fact web.liveness)"
absent "liveness not under the base path" "/tools/langfuse" "$(fact web.liveness)"
absent "os-ui LANGFUSE_URL at the root" "/tools/langfuse" "$(fact osui.LANGFUSE_URL)"
absent "LiteLLM LANGFUSE_HOST at the root" "/tools/langfuse" "$(fact litellm.LANGFUSE_HOST)"
absent "NEXTAUTH_URL at the root" "/tools/langfuse" "$(fact web.nextauth)"
check "EE queue consumers still off on the upstream worker" "false" "$(fact worker.retention)"
check "telemetry off on the upstream web" "false" "$(fact web.telemetry)"
check "telemetry off on the upstream worker" "false" "$(fact worker.telemetry)"
render -f deploy/overlays/langfuse-upstream-image.yaml --set observability.collector.litellmLangfuse.enabled=true
absent "collector exporter at the root" "/tools/langfuse/api/public/otel" "$out"

echo "laptop profile (values.local.yaml): the locally built images, no pull secret"
render -f values.local.yaml
F=$(facts)
check "web: the local build" "sovereign-os/langfuse-oss-web:local" "$(fact web.image)"
check "worker: the local build" "sovereign-os/langfuse-oss-worker:local" "$(fact worker.image)"
check "no pull secret on the laptop" "none" "$(fact web.pull)"
holds "laptop LANGFUSE_URL still under the base path" ends_bp "$(fact osui.LANGFUSE_URL)"
check "laptop web telemetry off" "false" "$(fact web.telemetry)"
check "laptop worker telemetry off" "false" "$(fact worker.telemetry)"

echo "negative twin: a tag without a digest"
render --set langfuse.langfuse.web.image.tag=3.194.1-soa.1
F=$(facts)
if matches "$OURS_WEB" "$(fact web.image)"; then bad "an unpinned tag must not pass" "$(fact web.image)"; else ok "an unpinned tag is caught ($(fact web.image))"; fi

echo "negative twin: upstream image with the base-path addresses (a half rollback)"
render --set langfuse.langfuse.web.image.repository=langfuse/langfuse --set langfuse.langfuse.web.image.tag=3.194.1
F=$(facts)
if matches "$OURS_WEB" "$(fact web.image)"; then bad "the upstream image must not pass as ours"; else ok "the upstream image is caught ($(fact web.image))"; fi

echo "negative twin: telemetry switched on"
render --set langfuse.langfuse.features.telemetryEnabled=true
F=$(facts)
if [ "$(fact web.telemetry)" = false ] || [ "$(fact worker.telemetry)" = false ]; then bad "telemetry on must not read as off" "$(fact web.telemetry)/$(fact worker.telemetry)"
else ok "telemetry on is caught (web $(fact web.telemetry), worker $(fact worker.telemetry))"; fi

finish langfuse-oss-chart
