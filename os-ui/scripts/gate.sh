#!/usr/bin/env bash
# Phase-0 regression gate: the five reviewed defects. `todo` while open; a phase
# that fixes one flips its test to a hard assertion. Fails CI only on real failures.
set -euo pipefail
cd "$(dirname "$0")/.."
# A3 (checklist A28): the scoped key's allowlist covers every alias the OS can request —
# config defaults, agentRuntime models, router fallback targets — on both chart profiles.
node ../scripts/check-litellm-allowlist.mjs
node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test \
  tabs/agents/lib/build/os-tools.test.ts \
  core/runtime/runtime.test.ts \
  core/infra/os-mirror.test.ts \
  tabs/agents/lib/build/agentic-graph.test.ts \
  tabs/agents/lib/engine/attribution.test.ts \
  tabs/agents/lib/engine/observe.test.ts \
  core/infra/langfuse.test.ts \
  tabs/agents/lib/engine/jobs.test.ts \
  tabs/agents/lib/engine/jobs-postgres.test.ts \
  tabs/agents/lib/engine/jobs-resume.test.ts \
  tabs/agents/lib/engine/worker-loop.test.ts \
  tabs/agents/lib/engine/runner-identity.test.ts
