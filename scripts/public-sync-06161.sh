#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# Sync os-ui 0.6.160 -> 0.6.161 to the PUBLIC repo (github.com/Data-Masterclass/sovereign-agentic-os).
# Public tip was last synced at 0.6.160 (b3ee940). 0.6.161 = Workflows "My" isolation + Knowledge new-note
# direct + Business Processes->Business Workflows rename + Software-generate column discipline (3 attempts)
# + Agents granted-context grounding in the run preamble. Method: one clean public-line commit whose TREE
# == private HEAD tree, parented on the public tip, then fast-forward push. No secrets tracked; re-verified.
set -euo pipefail
cd "$(dirname "$0")/.."

PUBLIC_TIP=b3ee940
MSG="release: sync to os-ui 0.6.161 — Business Workflows 'My' list is owner-only (a Builder no longer sees colleagues' Personal drafts in the list; canView/stewardship + agent-retrieval unchanged); the Knowledge tab's 'New knowledge' creates a note directly (removed the General-vs-Workflow chooser); renamed Business Processes -> Business Workflows across nav/header/back-buttons/agent-picker/MCP/tutorials; Software Generate forbids inventing conventional columns (status/priority/description/attachments) and does up to 3 attempts (2 repair turns) re-seeded with the exact valid columns so it converges on the dataset's real schema; and the agent run preamble now names the system's EXACT granted resource ids with an 'only these; a discovery tool may surface others you are NOT authorized to use' rule (the data-plane counterpart to the grant-scoped tool brief). Full suite 5493/5493 green."

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
  echo "TREE_IDENTICAL"; echo "$PUBLIC_TIP..$NEW  ->  public/main"; echo "DONE_06161_AND_SYNCED"
else
  echo "VERIFY_FAILED — public tree differs from private HEAD"; exit 1
fi
