#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# Sync os-ui 0.6.158→0.6.160 to the PUBLIC repo (github.com/Data-Masterclass/sovereign-agentic-os).
# Public tip was last synced at 0.6.159 (ac539d6). 0.6.160 = MCP + documentation alignment for
# the 0.6.158 Software/Generate + grounding fixes (docs/guidance only, no behaviour change):
#   - generate_app_spec MCP description: failure issues[] are machine-actionable {path,reason,fix};
#     act + retry, bind an existing granted dataset before creating a new one.
#   - software.guide.md Design/Choose-Context: reuse before you create (list_datasets + bind).
#   - OS Guide (MD + regenerated PDF): inline blockers on a failed auto-generate; reuse-before-create.
# Method: one clean public-line commit whose TREE == private HEAD tree, parented on the public tip,
# then fast-forward push. Secrets are never tracked; we re-verify + byte-compare.
set -euo pipefail
cd "$(dirname "$0")/.."

PUBLIC_TIP=ac539d6
MSG="release: sync to os-ui 0.6.160 — tutorials refreshed for the 0.6.158 Software/Generate fixes (Build App lists the exact {path,reason,fix} blockers inline and never dead-ends; Choose Context reuses an existing dataset before proposing a new one; the Agents Design step notes the grounded team proposal), plus a Home front-door \"Talk to the OS — What do you want to build or do today?\" entry that opens the one global OS Assistant (a decoupled os-assistant:open event, no duplicate assistant)."

echo "==> safety gate: no secret files tracked in HEAD"
if git ls-tree -r HEAD --name-only | grep -qE "^(deploy/kubeconfig|\.env\.stackit|deploy/terraform/.*tfstate)"; then
  echo "ABORT — a secret-bearing path is tracked in HEAD"; exit 1
fi

echo "==> public tip is still $PUBLIC_TIP?"
REMOTE=$(git ls-remote public refs/heads/main | awk '{print $1}')
if [ -z "$REMOTE" ]; then echo "ABORT — could not read public/main tip"; exit 1; fi
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
if [ "$(git rev-parse "$NEW^{tree}")" = "$(git rev-parse "HEAD^{tree}")" ] && [ "$REMOTE_AFTER" = "$NEW" ]; then
  echo "TREE_IDENTICAL"; echo "$PUBLIC_TIP..$NEW  ->  public/main"; echo "DONE_06160_AND_SYNCED"
else
  echo "VERIFY_FAILED — public tree differs from private HEAD"; exit 1
fi
