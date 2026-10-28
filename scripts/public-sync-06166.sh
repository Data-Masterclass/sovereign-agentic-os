#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# Sync os-ui 0.6.165 -> 0.6.166 to the PUBLIC repo. Public tip last synced at f85e7af3 (0.6.165).
# 0.6.166 = editable records: in-place edit/delete for OS-built apps. The 3 previously-deferred
# interactive patterns (editable-grid, kanban-workflow, action-detail) are now real. The store stays
# APPEND-ONLY + auditable via a supersede/tombstone model: os.records.update/remove append through
# the same governed add door; reduceByKey collapses the log to current rows.
set -euo pipefail
cd "$(dirname "$0")/.."
PUBLIC_TIP=f85e7af3
MSG="release: sync to os-ui 0.6.166 — editable records: OS-built apps can now EDIT and DELETE their own records in place, not just append. The three previously-deferred interactive patterns are now real end-to-end: editable-grid (inline-edit table: add row / edit cells / delete), kanban-workflow (cards grouped into status columns, move a card to write its new status) and action-detail (a record + governed action buttons that each set a field). The store stays APPEND-ONLY and fully auditable — this is a supersede/tombstone model, not destructive mutation: the SDK gains os.records.update(id, record) (appends a record that supersedes a logical row, carrying _key) and os.records.remove(id) (appends a reversible _deleted tombstone), BOTH through the same governed add door — no new route, no new OPA gate, no new store verb, same auto-approved envelope; delete is reversible and the full edit history is retained (free audit + undo). A new pure reducer reduceByKey (records-reduce.ts) collapses the append log to current rows (latest append per _key wins, tombstones hidden, creation-order stable, reserved keys stripped, each row's id is its logical key); the existing single-key reducers (decisions, done-flags) are special cases of the same reduce-the-log philosophy, now generalized to keyed upsert. Config parsers + the three renderers (all using the honest isRealSave save-labelling and surfacing governed Forbidden verbatim), wired into the runtime switch, authorable-by-selection in the Compose UI, and offered to the generator/assistant catalogue. DESIGN.md documents the trio as live (3.5e). No change to the store's durability or scoping. OS Guide stamp -> 0.6.166, PDF regenerated. tsc clean; full 5545-test suite green."
echo "==> safety gate: no secret files tracked in HEAD"
if git ls-tree -r HEAD --name-only | grep -qE "^(deploy/kubeconfig|\.env\.stackit|deploy/terraform/.*tfstate)"; then
  echo "ABORT — a secret-bearing path is tracked in HEAD"; exit 1
fi
echo "==> public tip is still $PUBLIC_TIP?"
REMOTE=$(git ls-remote public refs/heads/main | awk '{print $1}')
if [ -z "$REMOTE" ]; then echo "ABORT — could not read public/main tip"; exit 1; fi
if [ "${REMOTE:0:8}" != "$PUBLIC_TIP" ]; then echo "ABORT — public/main moved to $REMOTE (expected $PUBLIC_TIP)"; exit 1; fi
echo "==> create public-line commit (tree = private HEAD, parent = $PUBLIC_TIP)"
NEW=$(GIT_AUTHOR_NAME="Data Masterclass"    GIT_AUTHOR_EMAIL="contact@datamasterclass.com" \
      GIT_COMMITTER_NAME="Data Masterclass" GIT_COMMITTER_EMAIL="contact@datamasterclass.com" \
      git commit-tree "HEAD^{tree}" -p "$REMOTE" -m "$MSG")
echo "==> new commit: $NEW"
git push public "${NEW}:refs/heads/main"
REMOTE_AFTER=$(git ls-remote public refs/heads/main | awk '{print $1}')
if [ "$(git rev-parse "${NEW}^{tree}")" = "$(git rev-parse 'HEAD^{tree}')" ] && [ "$REMOTE_AFTER" = "$NEW" ]; then
  echo "TREE_IDENTICAL"; echo "$PUBLIC_TIP..$NEW  ->  public/main"; echo "DONE_06166_AND_SYNCED"
else echo "VERIFY_FAILED"; fi
