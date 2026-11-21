#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# mcp-token-secret-chart.test.sh — the MCP bearer-token signing key is its OWN key.
# =============================================================================
#   bash scripts/tests/mcp-token-secret-chart.test.sh
#
# Renders the chart (no cluster) and asserts:
#   * os-ui-session carries BOTH OS_SESSION_SECRET and OS_MCP_TOKEN_SECRET;
#   * os-ui reads OS_MCP_TOKEN_SECRET from the OS_MCP_TOKEN_SECRET key (not OS_SESSION_SECRET);
#   * explicit osUI.sessionSecret / osUI.mcpTokenSecret land on their own keys;
#   * negative twin: rotating osUI.sessionSecret alone does NOT change an explicit MCP key.
# The `lookup` migration (first upgrade keeps the stored session secret as the MCP key) needs an
# API server: scripts/tests/mcp-token-secret.kind.sh.
# Skips (exit 0) without helm or the subchart .tgz files — but FAILS when CI is set.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
CHART=charts/sovereign-agentic-os
skip() {
  if [ -n "${CI:-}" ]; then echo "mcp-token-secret-chart: $1 — FAILING because CI is set"; exit 1; fi
  echo "mcp-token-secret-chart: $1 — SKIPPED"; exit 0
}
command -v helm >/dev/null 2>&1 || skip "helm not on PATH"
ls "$CHART"/charts/*.tgz >/dev/null 2>&1 || skip "chart dependencies not built"
render() { out=$(helm template t "$CHART" "$@" 2>/dev/null); rc=$?; }

echo "1. default render"
render --show-only templates/base/os-ui/os-ui-session.yaml
rc_is "renders" 0
check "session key present" "OS_SESSION_SECRET:" "$out"
check "MCP key present" "OS_MCP_TOKEN_SECRET:" "$out"

echo "2. os-ui reads the MCP key from its own Secret key"
render --show-only templates/base/os-ui/os-ui.yaml
env=$(printf '%s\n' "$out" | grep -A4 -- '- name: OS_MCP_TOKEN_SECRET' | head -5)
check "MCP env sourced from os-ui-session" "name: os-ui-session" "$env"
check "MCP env uses the OS_MCP_TOKEN_SECRET key" "key: OS_MCP_TOKEN_SECRET" "$env"
absent "twin: MCP env no longer reuses OS_SESSION_SECRET" "key: OS_SESSION_SECRET" "$env"

echo "3. explicit values land on their own keys"
render --show-only templates/base/os-ui/os-ui-session.yaml --set osUI.sessionSecret=sess-one --set osUI.mcpTokenSecret=mcp-keep
check "session value" 'OS_SESSION_SECRET: "sess-one"' "$out"
check "mcp value" 'OS_MCP_TOKEN_SECRET: "mcp-keep"' "$out"

echo "4. negative twin: a session rotation leaves the MCP key alone"
render --show-only templates/base/os-ui/os-ui-session.yaml --set osUI.sessionSecret=sess-two --set osUI.mcpTokenSecret=mcp-keep
check "session rotated" 'OS_SESSION_SECRET: "sess-two"' "$out"
check "mcp unchanged" 'OS_MCP_TOKEN_SECRET: "mcp-keep"' "$out"

finish mcp-token-secret-chart
