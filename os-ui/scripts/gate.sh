#!/usr/bin/env bash
# Phase-0 regression gate: the five reviewed defects. `todo` while open; a phase
# that fixes one flips its test to a hard assertion. Fails CI only on real failures.
set -euo pipefail
cd "$(dirname "$0")/.."
node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test \
  lib/agents/build/os-tools.test.ts \
  lib/assistant/runtime.test.ts \
  lib/infra/os-mirror.test.ts \
  lib/agents/build/agentic-graph.test.ts
