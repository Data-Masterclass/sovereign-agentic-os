#!/usr/bin/env bash
# URGENT prod fix: the os-ui session/MCP signing secret is the insecure DEV-DEFAULT, so the
# 0.6.88 security guard refuses to boot pages in production ("Refusing to boot in production
# with the insecure dev-default secret for: OS_SESSION_SECRET, OS_MCP_TOKEN_SECRET").
#
# Both env vars source the SAME key `os-ui-session/OS_SESSION_SECRET`, so rotating that one
# key to a strong random value fixes both. It's a plain k8s Secret (NOT managed by the image
# deploy), so this persists across future `deploy-*.sh` runs.
#
# SIDE EFFECT: rotating invalidates existing session cookies + MCP tokens — everyone must
# re-login ONCE. That is the correct security tradeoff (a dev-default session key is forgeable).
set -euo pipefail
cd "$(dirname "$0")/.."
export KUBECONFIG="${KUBECONFIG:-deploy/kubeconfig.yaml}"

NEW=$(openssl rand -hex 32)   # 64 hex chars, strong + unique
echo "==> rotating os-ui-session/OS_SESSION_SECRET to a strong 64-hex value"
kubectl -n agentic-os patch secret os-ui-session --type merge \
  -p "{\"stringData\":{\"OS_SESSION_SECRET\":\"$NEW\"}}"

echo "==> restarting os-ui to pick up the new secret"
kubectl -n agentic-os rollout restart deploy/os-ui
kubectl -n agentic-os rollout status deploy/os-ui --timeout=5m

echo "OS_SESSION_SECRET_ROTATED_OK — Dashboards/Metrics should render; everyone re-logins once."
