#!/usr/bin/env bash
# Sync os-ui 0.6.140 to the PUBLIC repo (github.com/Data-Masterclass/sovereign-agentic-os).
# BUNDLES 0.6.138→0.6.140 (public tip was last synced at 0.6.137 = d1bf41e):
#   0.6.138 — Build App: fix the autosave-draft DATA-LOSS (draft survives Build<->Test&Publish nav +
#             reload), the Simple/Developer (Lovable-style) split (Simple = preview + assistant;
#             Developer = manual composer), de-dupe the Test & Publish button.
#   0.6.139 — Software UX: drop the dead raw-code "Developer" view for declarative (spec) apps; app
#             tiles get "Open App ↗" (live /apps/<slug>) + "Edit App" (builder); prominent
#             "Open the live app ↗"; overlay Escape/backdrop-dismiss hardening.
#   0.6.140 — remove the in-app tool overlay entirely; embedded tools (Superset/Langfuse/…) open in
#             their own browser tab (an overlay can never cover/trap the OS chrome).
# NOTE: the "black nav scrim" seen during testing was STALE BROWSER CACHE from rapid redeploys, not a
# code bug — 0.6.140 is the clean, live build (Clear-site-data / hard reload resolves any stale chunks).
# Method: one clean public-line commit whose TREE == private HEAD tree, parented on the current public
# tip, then fast-forward push. Secrets are never tracked in the private repo; we re-verify + byte-compare.
set -euo pipefail
cd "$(dirname "$0")/.."

PUBLIC_TIP=d1bf41e          # current public main (last synced at 0.6.137)
MSG="release: sync to os-ui 0.6.140 — Build App Lovable-style Simple/Developer split + autosave-survives-navigation fix + de-duped Test & Publish; declarative apps drop the dead raw-code view; app tiles gain Open-App/Edit-App + a prominent Open-the-live-app link; the in-app embedded-tool overlay is removed (tools open in their own tab, so no overlay can trap the OS). Bundles 0.6.138 + 0.6.139 + 0.6.140."

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
  echo "DONE_06140_AND_SYNCED"
else
  echo "VERIFY_FAILED — public tree differs from private HEAD"; exit 1
fi
