#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# Sync os-ui 0.6.162 -> 0.6.164 to the PUBLIC repo. Public tip last synced at 7fdebc8 (docs commit),
# i.e. BEFORE 0.6.163 — so this one tree-identical sync carries BOTH 0.6.163 (connectors marked
# "under construction") AND 0.6.164 (published Software app no longer vanishes after a pod restart).
set -euo pipefail
cd "$(dirname "$0")/.."
PUBLIC_TIP=7fdebc8
MSG="release: sync to os-ui 0.6.164 — a fully-built, PUBLISHED Software app no longer disappears after a pod restart. Root cause was at the persistence boundary, not the publish path: an app's arbitrary-shape spec/draftSpec were stored under the os-apps index's DEFAULT DYNAMIC mappings, so across apps they blew the 1000-field limit / hit a cross-doc type conflict and OpenSearch SILENTLY REJECTED the mirror write — the published app never became durable. Fix: persist spec/draftSpec as opaque JSON strings (one text field each, parsed back on hydrate with a legacy-object fallback), and on the first healthy probe idempotently reconcile the EXISTING os-apps index (raise index.mapping.total_fields.limit to 4000 + set mapping dynamic:false, both live-updatable) so it heals without a reindex; a fresh index gets the same via createBody. Also carries 0.6.163: the external connectors are marked UNDER CONSTRUCTION (honest preview) across the Connections gallery (amber badge + banner), the MCP list_connection_templates + create_connection descriptions, and the docs (OS Guide + connections.guide.md + Connections tutorial). OS Guide stamp -> 0.6.164, PDF regenerated. tsc clean; apps/mirror/appspec + mcp/connections/tutorials tests green."
echo "==> safety gate: no secret files tracked in HEAD"
if git ls-tree -r HEAD --name-only | grep -qE "^(deploy/kubeconfig|\.env\.stackit|deploy/terraform/.*tfstate)"; then
  echo "ABORT — a secret-bearing path is tracked in HEAD"; exit 1
fi
echo "==> public tip is still $PUBLIC_TIP?"
REMOTE=$(git ls-remote public refs/heads/main | awk '{print $1}')
if [ -z "$REMOTE" ]; then echo "ABORT — could not read public/main tip"; exit 1; fi
if [ "${REMOTE:0:7}" != "$PUBLIC_TIP" ]; then echo "ABORT — public/main moved to $REMOTE (expected $PUBLIC_TIP)"; exit 1; fi
echo "==> create public-line commit (tree = private HEAD, parent = $PUBLIC_TIP)"
NEW=$(GIT_AUTHOR_NAME="Data Masterclass"    GIT_AUTHOR_EMAIL="contact@datamasterclass.com" \
      GIT_COMMITTER_NAME="Data Masterclass" GIT_COMMITTER_EMAIL="contact@datamasterclass.com" \
      git commit-tree "HEAD^{tree}" -p "$REMOTE" -m "$MSG")
echo "==> new commit: $NEW"
git push public "${NEW}:refs/heads/main"
REMOTE_AFTER=$(git ls-remote public refs/heads/main | awk '{print $1}')
if [ "$(git rev-parse "${NEW}^{tree}")" = "$(git rev-parse 'HEAD^{tree}')" ] && [ "$REMOTE_AFTER" = "$NEW" ]; then
  echo "TREE_IDENTICAL"; echo "$PUBLIC_TIP..$NEW  ->  public/main"; echo "DONE_06164_AND_SYNCED"
else echo "VERIFY_FAILED"; fi
