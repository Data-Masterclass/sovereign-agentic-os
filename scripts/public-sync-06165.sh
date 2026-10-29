#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# Sync os-ui 0.6.164 -> 0.6.165 to the PUBLIC repo. Public tip last synced at 7e651d2 (0.6.164).
# 0.6.165 = honesty fix: saving a record INSIDE an OS-built app no longer falsely says "Not saved for
# real (demo-seed)". The interactive patterns write via os.records.add to the durable OS-side app-
# records store (source:'os-records-store'); the renderers + classifyWriteResult only treated
# 'live-app' as a real save, so a record that DID persist was mislabelled not-saved. Fix: shared
# isRealSave() (os-records-store OR live-app) at all 6 sites + 'os-records-store' added to the SDK
# RecordResult.source type. No change to what persists.
set -euo pipefail
cd "$(dirname "$0")/.."
PUBLIC_TIP=7e651d2
MSG="release: sync to os-ui 0.6.165 — honesty fix: saving a record INSIDE an OS-built app no longer falsely reports 'Not saved for real — the app runner is not live (demo-seed).' The interactive patterns (form / intake-wizard / assignment / approval-queue / task-checklist) write through the governed os.records.add door, whose durable home is the OS-side app-records store (the default static-SPA template has no backend of its own). That store labels its results source:'os-records-store', but the five renderers and the shared classifyWriteResult only treated source:'live-app' as a real save — so a record that DID persist to the durable store was reported to the user as not saved. Fix: a single shared isRealSave() predicate (a real save is 'os-records-store' OR 'live-app'; only 'demo-seed' is illustrative) used by classifyWriteResult and all five renderers, so no site can regress; and 'os-records-store' is added to the SDK RecordResult.source type (it always answered with it at runtime). Nothing about what persists changed — only the honesty label was wrong; reads were unaffected. OS Guide stamp -> 0.6.165, PDF regenerated. tsc clean; full 5537-test suite green."
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
  echo "TREE_IDENTICAL"; echo "$PUBLIC_TIP..$NEW  ->  public/main"; echo "DONE_06165_AND_SYNCED"
else echo "VERIFY_FAILED"; fi
