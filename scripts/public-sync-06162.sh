#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# Sync os-ui 0.6.161 -> 0.6.162 to the PUBLIC repo. Public tip last synced at 0.6.161 (aec709e).
# 0.6.162 = Software apps no longer disappear after a transient OpenSearch hiccup: the app registry
# bulk-hydrate cached an empty list as authoritative when the mirror was unreachable (null), poisoning
# the tiles empty for the whole pod lifetime; a `hydrated` flag now re-hydrates once the mirror recovers.
set -euo pipefail
cd "$(dirname "$0")/.."
PUBLIC_TIP=aec709e
MSG="release: sync to os-ui 0.6.162 — Software apps no longer disappear after a transient mirror hiccup. The app registry bulk-hydrate did (await mirror.hydrate(500)) ?? [] — collapsing null (OpenSearch UNREACHABLE) and [] (reachable-but-empty) into one empty list and caching it as authoritative, so a transient blip at the first list-after-boot poisoned the app tiles empty for the whole pod lifetime (every app vanished until the next restart). A hydrated flag now keeps the in-process cache on an outage but re-hydrates from the mirror the moment it recovers, folding persisted docs back in. writeThrough was already durable (queues + replays). Full suite 5493/5493 green."
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
git push public "$NEW:refs/heads/main"
REMOTE_AFTER=$(git ls-remote public refs/heads/main | awk '{print $1}')
if [ "$(git rev-parse "$NEW^{tree}")" = "$(git rev-parse "HEAD^{tree}")" ] && [ "$REMOTE_AFTER" = "$NEW" ]; then
  echo "TREE_IDENTICAL"; echo "$PUBLIC_TIP..$NEW  ->  public/main"; echo "DONE_06162_AND_SYNCED"
else
  echo "VERIFY_FAILED — public tree differs from private HEAD"; exit 1
fi
