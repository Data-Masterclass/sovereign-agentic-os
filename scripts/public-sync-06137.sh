#!/usr/bin/env bash
# Sync os-ui 0.6.137 to the PUBLIC repo (github.com/Data-Masterclass/sovereign-agentic-os).
# BUNDLES 0.6.114→0.6.137 (public tip was last synced at 0.6.113):
#   0.6.114/115 — build-path hardening (useIdentity/roleAtLeast, Vite-src guidance, anti-loop guard)
#   0.6.116–129 — the DECLARATIVE AppSpec Software model: validated schema + same-origin OS renderer
#             (no per-app pod/CI/registry) + the tab-pattern cookbook (view + interactive) + sandboxed
#             HTML/CSS/JS custom block + theme CSS + governed query/expression DSL functions + KPI cards
#             + set_app_spec/get_app_spec + six-type Choose Context + pattern-first compose UI + demo seed.
#   0.6.130 — composer usability: optional description, localStorage draft (reload-safe), preview-below,
#             Build reachable for no-code apps.
#   0.6.131 — the ✨ generate-from-epics build ASSISTANT (reasoning model, constrained to cookbook +
#             granted data) + the CRITICAL theme-CSS </style> XSS fix.
#   0.6.132 — declarative review-hardening (UX legibility + correctness + entitlement defense-in-depth).
#   0.6.133 — CODED apps OFF by default (platform-admin-gated); Declarative is the sole default path.
#   0.6.134 — Build App: auto-generate on load + agentic chat assistant (applies edits) + reset/blank.
#   0.6.135 — autosave DRAFT (apps always in tiles) + candidate/live VERSIONING + Publish (no Save button).
#   0.6.136 — MCP declarative-first golden path + generate_app_spec + refreshed spec-tool descriptions.
#   0.6.137 — docs guide (MD + PDF) + in-app tutorial rewritten for the declarative Software model.
# Method: one clean public-line commit whose TREE == private HEAD tree, parented on the current public
# tip, then fast-forward push. Secrets are never tracked in the private repo, so the tree is publish-safe;
# we re-verify + byte-compare.
set -euo pipefail
cd "$(dirname "$0")/.."

PUBLIC_TIP=5c1d15c          # current public main (last synced at 0.6.113)
MSG="release: sync to os-ui 0.6.137 — DECLARATIVE Software (AppSpec) is now the default and only path (coded apps off by default, platform-admin-gated): governed apps are validated declarative specs rendered same-origin by the OS (no per-app container/CI/cross-origin) from a tab-pattern cookbook over governed data, with a same-origin ✨ assistant that auto-generates the app from epics + applies natural-language edits, autosaved drafts (apps always visible) promoted by Publish to auto-named restorable live versions, a sandboxed HTML/CSS/JS block, governed query/expression DSL functions, and the six-type Choose Context. Includes the critical theme-CSS </style> XSS fix, review-hardening, the declarative-first MCP golden path (create_software spec -> design_software -> generate_app_spec/set_app_spec) and the rewritten guide + tutorials. Bundles 0.6.114/0.6.115 build-path hardening."

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
  echo "DONE_06137_AND_SYNCED"
else
  echo "VERIFY_FAILED — public tree differs from private HEAD"; exit 1
fi
