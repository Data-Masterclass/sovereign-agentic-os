#!/usr/bin/env bash
# Phase-0 regression gate: the five reviewed defects. `todo` while open; a phase
# that fixes one flips its test to a hard assertion. Fails CI only on real failures.
set -euo pipefail
cd "$(dirname "$0")/.."
# CONFLICT COPIES (F2-5). macOS/iCloud makes " 2" duplicates (`approvals.test 2.ts`,
# `_os-ui-env 2.tpl`) that git never tracks — but `docker build` copies the WORKING TREE and
# `next build` type-checks `*.test 2.ts`, because tsconfig excludes only `**/*.test.ts`. That
# combination failed a production image build with type errors in files nobody had edited.
# `.dockerignore` keeps them out of the image context; this keeps them out of the tree.
#
# WIDENED (2026-11-19): the check used to be `-type f -name '* 2.*'`, which missed the three
# shapes that hurt most — a DIRECTORY (`os-ui/node_modules 2`, `tabs/data 2`), whose contents
# then get type-checked and COPYed wholesale; a SYMLINK named `* 2`; and an extension-less file
# (`Dockerfile 2`, `gate 2`). So: files, directories AND symlinks, named `* 2` or `* 2.*`.
# `-print -prune` is load-bearing — print the match, then refuse to descend into it, so a
# duplicated `node_modules 2` is one line rather than one line per vendored file.
# `scripts/check-structure.mjs` carries the same rule (CLOUD-SYNC-DUPLICATE) as a second door,
# because it also runs as the PostToolUse hook and so catches a duplicate in-session.
#
# `.claude` MUST stay in the prune group (review H1): it holds `.claude/worktrees/*`, i.e. OTHER
# sessions' checkouts. Without it this scan walks into every sibling worktree and reports their
# copied `public/monaco/...` duplicates — ~28 of them — as if they were strays in this tree, and
# the gate fails for something no one here can fix. A worktree runs its own gate; this one only
# polices the tree it is in.
#
# `../docs` IS PRUNED FROM THE STRICT SWEEP AND SCANNED SEPARATELY (review L1). docs/ is prose,
# and a maintainer may legitimately write `notes 2.md` or `design 2.txt`; failing the gate on
# one made this door disagree with rule 7 in `scripts/check-structure.mjs`, which already
# permits it. Two doors that disagree are worse than one door: whichever is stricter becomes the
# real rule, by accident. So under docs/ only a DIRECTORY (or symlink) named `* 2` — always a
# sync artefact — and a duplicated SOURCE file count; the extension list below is the same one
# rule 7 uses. Note `-path '../docs'` pins the TOP-LEVEL docs only: a nested `*/docs` elsewhere
# stays under the strict sweep, exactly as rule 7 scopes it.
#
# Every pattern below is written out inline on purpose: a `* 2.ts` pattern held in a shell
# variable word-splits on its own space and find then reads it as `-name * ` plus a stray
# `2.ts`, which silently matches nothing.
strays="$(find .. \( -path '*/node_modules' -o -path '*/.next' -o -path '*/.git' -o -path '*/.claude' -o -path '../docs' \) -prune -o \
  \( -name '* 2' -o -name '* 2.*' \) \( -type f -o -type d -o -type l \) -print -prune)"
docs_strays="$(find ../docs \( -path '*/node_modules' -o -path '*/.next' \) -prune -o \
  \( -name '* 2' \( -type d -o -type l \) \) -print -prune -o \
  -type f \( -name '* 2.ts' -o -name '* 2.tsx' -o -name '* 2.mjs' -o -name '* 2.cjs' \
             -o -name '* 2.js' -o -name '* 2.json' -o -name '* 2.sh' -o -name '* 2.bash' \
             -o -name '* 2.py' -o -name '* 2.rego' -o -name '* 2.yaml' -o -name '* 2.yml' \
             -o -name '* 2.tpl' -o -name '* 2.sql' \) -print)"
strays="$(printf '%s\n%s' "$strays" "$docs_strays" | sed '/^$/d')"
if [ -n "$strays" ]; then
  echo "gate: FAIL — iCloud/Finder conflict copies in the tree. They are never tracked; delete them:" >&2
  printf '%s\n' "$strays" >&2
  echo "  (a listed DIRECTORY is reported once — delete the whole directory, contents and all)" >&2
  echo "  find . \( -path '*/node_modules' -o -path '*/.next' -o -path '*/.claude' \) -prune -o \\" >&2
  echo "       \( -name '* 2' -o -name '* 2.*' \) -print -prune" >&2
  exit 1
fi
echo "check-conflict-copies: ok — no '* 2' / '* 2.*' file, directory or symlink in the tree"
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
# WHOLE registry (all 114 tools, not just the data tab): advertised + schema, dispatches, an
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
  core/mcp/mcp-conformance.test.ts \
  tabs/agents/lib/engine/run-agent-graph-cli.test.ts
