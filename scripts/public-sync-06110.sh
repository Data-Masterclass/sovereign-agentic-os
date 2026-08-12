#!/usr/bin/env bash
# Sync os-ui 0.6.110 to the PUBLIC repo (github.com/Data-Masterclass/sovereign-agentic-os).
# BUNDLES 0.6.106→0.6.110 (Choose Context rename · Build on the reasoning model ·
# write-only Build over frozen context · Science KServe runtime pin + honest failures ·
# Kaniko digest build path + honest Build errors + 24-step budget).
# Method: one clean public-line commit whose TREE == private HEAD tree, parented on the
# current public tip, then fast-forward push. Secrets are never tracked in the private
# repo, so the tree is publish-safe; we re-verify + byte-compare.
set -euo pipefail
cd "$(dirname "$0")/.."

PUBLIC_TIP=91890a2          # current public main (last synced at 0.6.110)
MSG="release: sync to os-ui 0.6.111 — Science auto-detects the ML task from the target column's real content; build LLM timeout 90s→240s (reasoning tier); defer the Kaniko digest build (Path B) dormant+documented, ship apps on Forgejo Actions"

echo "==> safety gate: no secret files tracked in HEAD"
if git ls-tree -r HEAD --name-only | grep -qE "^(deploy/kubeconfig|\.env\.stackit|deploy/terraform/.*tfstate)"; then
  echo "ABORT — a secret-bearing path is tracked in HEAD"; exit 1
fi

echo "==> public tip is still $PUBLIC_TIP?"
# Read the remote tip directly via ls-remote (no local remote-tracking ref) — robust to a
# corrupt/broken `refs/remotes/public/*` loose ref that would make `git fetch` fail.
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
      git commit-tree "HEAD^{tree}" -p "$PUBLIC_TIP" -m "$MSG")
echo "==> new commit: $NEW"

echo "==> fast-forward push to public/main"
git push public "$NEW:refs/heads/main"

echo "==> verify public tree is byte-identical to private HEAD tree"
REMOTE_AFTER=$(git ls-remote public refs/heads/main | awk '{print $1}')
if [ "$(git rev-parse "$NEW^{tree}")" = "$(git rev-parse "HEAD^{tree}")" ] \
   && [ "$REMOTE_AFTER" = "$NEW" ]; then
  echo "TREE_IDENTICAL"
  echo "$PUBLIC_TIP..$NEW  ->  public/main"
  echo "DONE_06110_AND_SYNCED"
else
  echo "VERIFY_FAILED — public tree differs from private HEAD"; exit 1
fi
