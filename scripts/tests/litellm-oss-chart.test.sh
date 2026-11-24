#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# litellm-oss-chart.test.sh — the gateway runs OUR image (images/extensions/litellm-oss) by default,
# pinned by digest, and the rollback overlay brings the upstream image back.
# =============================================================================
#   bash scripts/tests/litellm-oss-chart.test.sh
#
# Renders the chart (no cluster) and asserts:
#   * default: the gateway container AND its db-migrate initContainer run
#     ghcr.io/data-masterclass/sovereign-os/litellm-oss@sha256:<64 hex>, with the pull secret
#     registry-pull-secret (the org package is private; the subchart ignores global.imagePullSecrets);
#   * STACKIT and dev profiles: the same image and pull secret;
#   * deploy/overlays/litellm-oss-image.yaml equals the chart default (so the "return" overlay
#     cannot drift from the default it restores);
#   * deploy/overlays/litellm-upstream-image.yaml (rollback): the upstream litellm-database 1.109.1
#     digest in both places, no pull secret;
#   * the laptop profile (values.local.yaml) runs the locally built sovereign-os/litellm-oss:local;
#   * negative twin: a tag without a digest is caught by the digest assertion.
# Skips (exit 0) without helm or the subchart .tgz files — but FAILS when CI is set.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
CHART=charts/sovereign-agentic-os
skip() {
  if [ -n "${CI:-}" ]; then echo "litellm-oss-chart: $1 — FAILING because CI is set"; exit 1; fi
  echo "litellm-oss-chart: $1 — SKIPPED"; exit 0
}
command -v helm >/dev/null 2>&1 || skip "helm not on PATH"
ls "$CHART"/charts/*.tgz >/dev/null 2>&1 || skip "chart dependencies not built"

render() {
  local e; e=$(mktemp)
  out=$(helm template t "$CHART" -n agentic-os --skip-schema-validation "$@" 2>"$e"); rc=$?
  [ "$rc" -eq 0 ] || out="$out$(cat "$e")"
  rm -f "$e"
}
# images: "<container image> <db-migrate image> <pull secrets>" of the gateway Deployment
images() {
  printf '%s' "$out" | python3 -c '
import sys, yaml
docs = [d for d in yaml.safe_load_all(sys.stdin) if isinstance(d, dict) and d.get("kind") == "Deployment"]
d = next(x for x in docs if x["metadata"]["name"].endswith("litellm"))
s = d["spec"]["template"]["spec"]
mig = next((c["image"] for c in s.get("initContainers", []) if c["name"] == "db-migrate"), "none")
print(s["containers"][0]["image"], mig, ",".join(p["name"] for p in s.get("imagePullSecrets") or []) or "no-pull-secret")' 2>&1
}
OURS='^ghcr\.io/data-masterclass/sovereign-os/litellm-oss:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$'
UP='ghcr.io/berriai/litellm-database:1.109.1@sha256:932c54440654f8f8466a85887612d95dcfb04ae2fc01257844332f4bf3b96986'
pinned() { echo "$1" | grep -Eq "$OURS"; }

echo "default profile"
render
rc_is "renders" 0
read -r gw mig ps <<<"$(images)"
holds "gateway runs our image, pinned by digest ($gw)" pinned "$gw"
check "db-migrate runs the same image" "$gw" "$mig"
check "the private package's pull secret reaches the gateway pod" "registry-pull-secret" "$ps"

# dev refuses the chart's published default secrets (secret-defaults-guard), so its render sets its own
# test literals (the same set scripts/tests/dagster-launcher-lockdown.test.sh uses).
GUARD=(--set-string litellmMasterKey=t1 --set-string litellmUI.password=t2 --set-string agentRuntime.token=t3
  --set-string langfuseInit.publicKey=t4 --set-string langfuseInit.secretKey=t5 --set-string langfuseInit.userPassword=t6
  --set-string langfuseInit.salt=t7 --set-string langfuseInit.nextauthSecret=t8 --set-string langfuseInit.encryptionKey=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef)
for prof in values.stackit-managed.yaml values.dev.yaml; do
  echo "$prof"
  if [ "$prof" = values.dev.yaml ]; then render -f "$prof" "${GUARD[@]}"; else render -f "$prof"; fi
  rc_is "renders" 0
  read -r g m p <<<"$(images)"
  check "$prof: our image" "$gw" "$g"
  check "$prof: db-migrate same image" "$gw" "$m"
  check "$prof: pull secret" "registry-pull-secret" "$p"
done

echo "deploy/overlays/litellm-oss-image.yaml (return after a rollback)"
render -f deploy/overlays/litellm-oss-image.yaml
read -r g m p <<<"$(images)"
check "the overlay equals the chart default" "$gw" "$g"

echo "deploy/overlays/litellm-upstream-image.yaml (rollback)"
render -f deploy/overlays/litellm-upstream-image.yaml
rc_is "renders" 0
read -r g m p <<<"$(images)"
check "gateway back on the upstream image" "$UP" "$g"
check "db-migrate back on the upstream image" "$UP" "$m"
check "no pull secret for the public upstream image" "no-pull-secret" "$p"

echo "laptop profile"
render -f values.local.yaml
read -r g m p <<<"$(images)"
check "the locally built image" "sovereign-os/litellm-oss:local" "$g"
check "db-migrate too" "sovereign-os/litellm-oss:local" "$m"

echo "negative twin: a tag without a digest"
render --set litellm.image.tag=1.109.1-soa.1
read -r g m p <<<"$(images)"
if pinned "$g"; then bad "an unpinned tag must not pass the digest assertion" "$g"; else ok "an unpinned tag is caught ($g)"; fi

finish litellm-oss-chart
