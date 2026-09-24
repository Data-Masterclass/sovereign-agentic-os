#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
#
# Mint an MCP bearer token for a real OS account — automates the manual "log in,
# open the MCP tab, copy the token" flow documented in
# docs/components/mcp-test-agent.md. Prints the token (and a ready-to-run helm
# command) rather than writing the Secret directly: the chart's own template
# manages that Secret via Helm, so a plain `kubectl create/apply` here would
# fight Helm for ownership on the next `helm upgrade` (the exact conflict this
# repo already hit once — see PR39-REVIEW-SIMPLE-BASE-AGENT.md). Pass the
# printed token to `helm upgrade ... --set mcpTestAgent.mcpToken=<token>`
# instead, same as any other values.yaml field.
#
# Prereqs: a port-forward to os-ui already running (kubectl -n agentic-os
# port-forward svc/os-ui 8080:3000).
#
# Usage: ./scripts/get-mcp-token.sh <username> <password> [os-ui-url]
set -euo pipefail

USERNAME="${1:?Usage: $0 <username> <password> [os-ui-url]}"
PASSWORD="${2:?Usage: $0 <username> <password> [os-ui-url]}"
OS_UI_URL="${3:-http://localhost:8080}"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

echo "==> logging in as $USERNAME at $OS_UI_URL"
LOGIN_RESP=$(curl -sS -c "$COOKIE_JAR" -X POST "$OS_UI_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\": \"$USERNAME\", \"password\": \"$PASSWORD\"}")

if ! echo "$LOGIN_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if 'user' in d else 1)" 2>/dev/null; then
  echo "Login failed: $LOGIN_RESP" >&2
  exit 1
fi

echo "==> fetching MCP token"
TOKEN_RESP=$(curl -sS -b "$COOKIE_JAR" "$OS_UI_URL/api/mcp/token")
TOKEN=$(echo "$TOKEN_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")

if [ -z "$TOKEN" ]; then
  echo "Could not extract token: $TOKEN_RESP" >&2
  exit 1
fi

echo "==> token minted for $USERNAME:"
echo "$TOKEN"
echo
echo "==> apply it with (adjust the other --set flags to match your deploy):"
echo "    helm upgrade agentic-os charts/sovereign-agentic-os -n agentic-os --reuse-values \\"
echo "      --set mcpTestAgent.mcpToken='$TOKEN'"
