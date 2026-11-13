#!/usr/bin/env bash
# Phase-0 regression gate: the five reviewed defects. `todo` while open; a phase
# that fixes one flips its test to a hard assertion. Fails CI only on real failures.
set -euo pipefail
cd "$(dirname "$0")/.."
# A3 (checklist A28): the scoped key's allowlist covers every alias the OS can request —
# config defaults, agentRuntime models, router fallback targets — on both chart profiles.
node ../scripts/check-litellm-allowlist.mjs
# A4 review M-4: the os-ui-worker pod (which executes agent runs and serves no HTTP) must not
# carry the LiteLLM master key, the session-signing secret or the mail secret. Skips when helm is
# not installed — docs/components/os-ui.md carries the same check by hand.
node ../scripts/check-worker-env.mjs
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
  tabs/agents/lib/engine/runner-identity.test.ts \
  tabs/agents/lib/engine/run-visibility.test.ts \
  tabs/agents/lib/engine/jobs-lease.test.ts \
  tabs/agents/lib/build/run-stream-client.test.ts \
  tabs/agents/lib/build/worker-resolve-hook.test.ts \
  tabs/agents/lib/engine/parity.test.ts \
  tabs/agents/lib/engine/fixtures.test.ts \
  tabs/agents/lib/engine/build-graph.test.ts \
  core/mcp/agent-run-surface.test.ts
