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
# B3 review H-1/H-5/H-6: the reconciler must run on a DEFAULT install, the Dagster run pod must
# connect as the user rules.json allows, and the os-ui Role must not grant namespace-wide Secrets.
# B4 review H-2 rides on the same check: the os-ui Role must carry `batch`/`cronjobs` in EVERY
# render, or agent schedule CronJobs and the pre-B2 data-sync cleanup both 403 silently.
# These live in rendered YAML, so a unit test cannot see them. Skips when helm or the subchart
# .tgz files are absent — docs/components/trino.md carries the commands by hand.
node ../scripts/check-trino-rules-chart.mjs
# The reviewed-defect tests themselves. Among them, B4 (checklist X7/X8) — the data half of the
# MCP contract: `mcp-conformance.test.ts` asserts every data tool dispatches with a schema and
# refuses a foreign object in the documented code (`forbidden` for an existing invisible dataset,
# `not_found` for a missing one, with the flag off AND on), and `mcp-parity.test.ts` that each
# mutating tool produces the SAME commit and the SAME Dagster launch as the UI route's service.
# `sync-schedule-view.test.ts` (B4-review H-3) pins that the opt-out's "nothing schedules this"
# always reaches the user. This comment sat above the chart checks, which it never described
# (B4-review L-8). Part F adds `core/mcp/mcp-conformance.test.ts` — the SAME contract over the
# WHOLE registry (all 113 tools, not just the data tab): advertised + schema, dispatches, an
# absent object is `not_found` from every object-addressed tool, an existing invisible one is
# refused per the OS convention, a role gate names its role, and no tool answers the `error`
# catch-all (which is how `suggest_metrics`'s raw `fetch failed` was found).
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
  core/mcp/agent-run-surface.test.ts \
  core/infra/trino-rules.test.ts \
  core/infra/trino-rules-server.test.ts \
  core/kernel/events.test.ts \
  tabs/admin/lib/directory-events.test.ts \
  tabs/admin/lib/components-extra.test.ts \
  tabs/data/lib/dbt/parity.test.ts \
  tabs/data/lib/dbt/boot-reconcile.test.ts \
  core/infra/git-store-subtree.test.ts \
  core/infra/git-mirror.test.ts \
  tabs/admin/lib/components-git-mirror.test.ts \
  tabs/agents/lib/git/generate.test.ts \
  tabs/agents/lib/git/commit.test.ts \
  tabs/agents/lib/git/repo.test.ts \
  tabs/agents/lib/engine/data-context.test.ts \
  tabs/data/lib/sync-schedule-view.test.ts \
  tabs/data/lib/mcp-parity.test.ts \
  tabs/data/lib/mcp-conformance.test.ts \
  core/mcp/mcp-conformance.test.ts
