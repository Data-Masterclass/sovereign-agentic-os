#!/usr/bin/env bash
# Sync os-ui 0.6.127 to the PUBLIC repo (github.com/Data-Masterclass/sovereign-agentic-os).
# BUNDLES 0.6.114→0.6.127 (public tip was last synced at 0.6.113):
#   0.6.114 — useIdentity/roleAtLeast fix + dataset-ref sees Domain assets + status reconciles
#             a running pod into a live URL + list_capabilities reconnect note
#   0.6.115 — build-path safety net (3 audits): brief teaches Vite src/ not Next.js app/ +
#             import { os } singleton (not createOsClient); same-signature anti-loop guard +
#             gate errors name real API members + empty-changeset honesty; personal-dataset
#             grant warning + cookie-domain deploy check + section-registration hint
#   0.6.116–0.6.127 — the DECLARATIVE AppSpec Software model: validated schema + author-time
#             validators; the same-origin OS renderer (no per-app pod/CI/registry/cross-origin);
#             the tab-pattern cookbook (10 view + 4 interactive patterns) + sandboxed HTML/CSS/JS
#             custom block + app theme CSS; governed query/expression DSL functions + KPI function
#             cards; set_app_spec/get_app_spec MCP tools + spec-app serving; a guarded declarative
#             demo seed; the Build-stage pattern-first COMPOSE UI + live preview + governed save;
#             the six-type Choose Context (Data·Metrics·Files·Knowledge·Agents·Connections) with
#             use-existing + create-new-in-App-folder + the agents grant.
# Method: one clean public-line commit whose TREE == private HEAD tree, parented on the current
# public tip, then fast-forward push. Secrets are never tracked in the private repo, so the tree
# is publish-safe; we re-verify + byte-compare.
set -euo pipefail
cd "$(dirname "$0")/.."

PUBLIC_TIP=5c1d15c          # current public main (last synced at 0.6.113)
MSG="release: sync to os-ui 0.6.127 — declarative Software (AppSpec): governed apps are validated declarative specs rendered same-origin by the OS (no per-app container/CI/cross-origin) from a tab-pattern cookbook (10 view + 4 interactive patterns) over governed data, a sandboxed HTML/CSS/JS custom block, governed query/expression DSL functions, pattern-first compose UI + live preview, and a six-type Choose Context (Data·Metrics·Files·Knowledge·Agents·Connections). Bundles the 0.6.114/0.6.115 build-path hardening (useIdentity/roleAtLeast + Vite-src guidance + anti-loop guard + Domain-dataset resolution + honest status)."

echo "==> safety gate: no secret files tracked in HEAD"
if git ls-tree -r HEAD --name-only | grep -qE "^(deploy/kubeconfig|\.env\.stackit|deploy/terraform/.*tfstate)"; then
  echo "ABORT — a secret-bearing path is tracked in HEAD"; exit 1
fi

echo "==> public tip is still $PUBLIC_TIP?"
# Read the remote tip directly via ls-remote (no local remote-tracking ref) — robust to a
# corrupt/broken refs/remotes/public/* loose ref that would make git fetch fail.
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
  echo "DONE_06127_AND_SYNCED"
else
  echo "VERIFY_FAILED — public tree differs from private HEAD"; exit 1
fi
