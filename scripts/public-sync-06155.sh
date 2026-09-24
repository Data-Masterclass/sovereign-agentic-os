#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# Sync os-ui 0.6.141→0.6.155 to the PUBLIC repo (github.com/Data-Masterclass/sovereign-agentic-os).
# Public tip was last synced at 0.6.140 (6dfbfb17). This bundles the whole wave:
#   0.6.141–0.6.145  materialization self-heal + Trino-gated probes/builds + promote/demote round-trip
#   0.6.146–0.6.151  Talk-to-Data reasoning tier, folder-name wrap, app write-back, durable agent runs,
#                    dataset-id in title, promote-as-view (flagged OFF; needs query-tool 0.6.2)
#   0.6.152          agent-build reach-END fix + autonomous-agents platform gate (default OFF)
#   0.6.153          agent context-scoping (grant-scoped tool brief), DQ rule-cards + auto-advance,
#                    Software "Reconnect git" heal + assistant spec fallback, query-tool 0.6.2 pinned
#   0.6.154          Agents-tab redesign (Define·Grant·Design·Build&Run·Evaluate + ChooseContextShell
#                    shared with Software + auto-suggest team + per-stage assistant)
#   0.6.155          Agents builder iteration: six stages (Build/Run split), trigger→Define,
#                    assistant-top + auto-suggest-on-entry, View vs Edit mode
# Method: one clean public-line commit whose TREE == private HEAD tree, parented on the current public
# tip, then fast-forward push. Secrets are never tracked in the private repo; we re-verify + byte-compare.
set -euo pipefail
cd "$(dirname "$0")/.."

PUBLIC_TIP=6dfbfb1          # current public main (last synced at 0.6.140); 7 chars to match ${REMOTE:0:7}
MSG="release: sync to os-ui 0.6.155 — materialization self-heal + promote/demote round-trip + promote-as-view (flagged); Talk-to-Data reasoning tier; durable agent runs; agent-build reach-END fix + autonomous-agents gate (OFF by default); agent run-context scoped to grants; Data DQ rule-cards + auto-advance-on-upload; Software git-heal + assistant spec fallback; Agents-tab builder redesign (Define·Grant·Design·Build·Run·Evaluate) with a shared Choose-Context primitive, per-stage assistant, auto-suggested team, and View/Edit mode. Bundles 0.6.141→0.6.155."

echo "==> safety gate: no secret files tracked in HEAD"
if git ls-tree -r HEAD --name-only | grep -qE "^(deploy/kubeconfig|\.env\.stackit|deploy/terraform/.*tfstate)"; then
  echo "ABORT — a secret-bearing path is tracked in HEAD"; exit 1
fi

echo "==> public tip is still $PUBLIC_TIP?"
REMOTE=$(git ls-remote public refs/heads/main | awk '{print $1}')
if [ -z "$REMOTE" ]; then
  echo "ABORT — could not read public/main tip (ls-remote empty)"; exit 1
fi
if [ "${REMOTE:0:7}" != "$PUBLIC_TIP" ]; then
  echo "ABORT — public/main moved to $REMOTE (expected $PUBLIC_TIP); re-derive parent"; exit 1
fi

echo "==> create public-line commit (tree = private HEAD, parent = $PUBLIC_TIP)"
NEW=$(GIT_AUTHOR_NAME="Data Masterclass"    GIT_AUTHOR_EMAIL="contact@datamasterclass.com" \
      GIT_COMMITTER_NAME="Data Masterclass" GIT_COMMITTER_EMAIL="contact@datamasterclass.com" \
      git commit-tree "HEAD^{tree}" -p "$REMOTE" -m "$MSG")
echo "==> new commit: $NEW"

echo "==> fast-forward push to public/main"
git push public "$NEW:refs/heads/main"

echo "==> verify public tree is byte-identical to private HEAD tree"
REMOTE_AFTER=$(git ls-remote public refs/heads/main | awk '{print $1}')
if [ "$(git rev-parse "$NEW^{tree}")" = "$(git rev-parse "HEAD^{tree}")" ] \
   && [ "$REMOTE_AFTER" = "$NEW" ]; then
  echo "TREE_IDENTICAL"
  echo "$PUBLIC_TIP..$NEW  ->  public/main"
  echo "DONE_06155_AND_SYNCED"
else
  echo "VERIFY_FAILED — public tree differs from private HEAD"; exit 1
fi
