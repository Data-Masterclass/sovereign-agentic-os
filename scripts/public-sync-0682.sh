#!/usr/bin/env bash
# Sync os-ui 0.6.82 to the PUBLIC repo (github.com/Data-Masterclass/sovereign-agentic-os).
# Method: one clean public-line commit whose TREE == private HEAD tree, parented on
# the current public tip, then fast-forward push. Secrets are never tracked in the
# private repo, so the tree is publish-safe; we re-verify + byte-compare anyway.
set -euo pipefail
cd "$(dirname "$0")/.."

PUBLIC_TIP=d383af7          # current public main (0.6.81)
MSG="release: sync to os-ui 0.6.82 — Connections integrity wave 2"

echo "==> safety gate: no secret files tracked in HEAD"
if git ls-tree -r HEAD --name-only | grep -qE "^(deploy/kubeconfig|\.env\.stackit|deploy/terraform/.*tfstate)"; then
  echo "ABORT — a secret-bearing path is tracked in HEAD"; exit 1
fi

echo "==> public tip is still $PUBLIC_TIP?"
git fetch public main --quiet
REMOTE=$(git rev-parse public/main)
if [ "${REMOTE:0:7}" != "$PUBLIC_TIP" ]; then
  echo "ABORT — public/main moved to $REMOTE (expected $PUBLIC_TIP); re-derive parent"; exit 1
fi

echo "==> create public-line commit (tree = private HEAD, parent = $PUBLIC_TIP)"
NEW=$(GIT_AUTHOR_NAME="Data Masterclass"    GIT_AUTHOR_EMAIL="contact@datamasterclass.com" \
      GIT_COMMITTER_NAME="Data Masterclass" GIT_COMMITTER_EMAIL="contact@datamasterclass.com" \
      git commit-tree "HEAD^{tree}" -p "$PUBLIC_TIP" -m "$MSG")
echo "==> new commit: $NEW"

echo "==> fast-forward push to public/main"
git push public "$NEW:refs/heads/main"

echo "==> verify public tree is byte-identical to private HEAD tree"
git fetch public main --quiet
if [ "$(git rev-parse "$NEW^{tree}")" = "$(git rev-parse "HEAD^{tree}")" ] \
   && [ "$(git rev-parse public/main)" = "$NEW" ]; then
  echo "TREE_IDENTICAL"
  echo "$PUBLIC_TIP..$NEW  ->  public/main"
  echo "DONE_0682_AND_SYNCED"
else
  echo "VERIFY_FAILED — public tree differs from private HEAD"; exit 1
fi
