#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# Sync os-ui 0.6.157→0.6.158 to the PUBLIC repo (github.com/Data-Masterclass/sovereign-agentic-os).
# Public tip was last synced at 0.6.157 (a1cbf85, tree-identical to private HEAD before this wave).
# 0.6.158 = two live-blocker UX fixes + two grounding fixes:
#   - Software "Generate my app" no longer a note-less dead-end — the server's issues[] render inline.
#   - Software Design assistant reuses grantable-but-unbound datasets (bind before create).
#   - "git not ready" badge hidden on declarative/spec apps (coded-app concept only).
#   - Agents: Design auto-propose only when grounded; Define assistant ask-first.
# Method: one clean public-line commit whose TREE == private HEAD tree, parented on the public tip,
# then fast-forward push. Secrets are never tracked; we re-verify + byte-compare.
set -euo pipefail
cd "$(dirname "$0")/.."

PUBLIC_TIP=a1cbf85          # current public main (last synced at 0.6.157); 7 chars to match ${REMOTE:0:7}
MSG="release: sync to os-ui 0.6.158 — Software 'Generate my app' now surfaces the specific blockers (the server's typed issues[]) inline instead of a note-less 'Review the notes' dead-end; the Software Design assistant is fed the caller's grantable-but-unbound context and PREFERS binding an existing dataset over proposing a new one (granted -> reuse-available -> only-then-new); the 'git not ready' header badge is hidden on declarative/spec apps (a coded-app concept); Agents Design auto-propose only fires when grounded (a real goal AND granted context, so no ungrounded team) and the Define assistant is ask-first. + CHANGELOG."

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
  echo "TREE_IDENTICAL"; echo "$PUBLIC_TIP..$NEW  ->  public/main"; echo "DONE_06158_AND_SYNCED"
else
  echo "VERIFY_FAILED — public tree differs from private HEAD"; exit 1
fi
