#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# Sync os-ui 0.6.162 -> 0.6.163 to the PUBLIC repo. Public tip last synced at 7fdebc8 (docs commit).
# 0.6.163 = connectors marked "under construction" (honest preview) across the Connections gallery UI
# (amber badge + banner), the MCP tool descriptions (list_connection_templates + create_connection),
# and the docs (OS Guide + connections.guide.md + Connections tutorial; PDF regenerated).
set -euo pipefail
cd "$(dirname "$0")/.."
PUBLIC_TIP=7fdebc8
MSG="release: sync to os-ui 0.6.163 — the external connectors are marked UNDER CONSTRUCTION (honest preview) everywhere they surface, since they are not yet end-to-end tested: each Connections gallery tile's corner badge changed from a teal 'ready' to an amber 'under construction' and the gallery gained a banner; the MCP list_connection_templates + create_connection tools open with an UNDER CONSTRUCTION (PREVIEW) note telling the agent to warn the user; and the OS Guide Connections section, the MCP-facing connections.guide.md and the Connections tutorial all carry the caveat (PDF regenerated). Creating/testing a connector is still allowed — an honesty label, not a hard gate. tsc clean; 861 mcp/connections/tutorials tests green."
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
  echo "TREE_IDENTICAL"; echo "$PUBLIC_TIP..$NEW  ->  public/main"; echo "DONE_06163_AND_SYNCED"
else echo "VERIFY_FAILED"; fi
