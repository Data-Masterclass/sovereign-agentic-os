#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# secret-deletion-guard.sh — refuse an upgrade that would DELETE a live Secret (WP-10 B1).
#   bash scripts/lib/secret-deletion-guard.sh --context <ctx> --ns <ns> <before.yaml> <after.yaml>
# A Secret in the live release manifest (before) and not in the render (after) is deleted by Helm
# unless the LIVE object carries helm.sh/resource-policy: keep (that is what the External Secrets
# handover release puts there). Read-only: one `kubectl get secret` per such Secret, the annotation
# only. Fail closed: a kubectl error refuses. Exit 0 when nothing would be deleted, 1 when the upgrade must be refused.
set -euo pipefail
CTX="" NS=""
while [ $# -gt 2 ]; do
  case $1 in --context) CTX=$2; shift 2 ;; --ns) NS=$2; shift 2 ;; *) break ;; esac
done
[ -n "$CTX" ] && [ -n "$NS" ] && [ $# -eq 2 ] || { echo "usage: secret-deletion-guard.sh --context <ctx> --ns <ns> <before.yaml> <after.yaml>" >&2; exit 2; }
gone=$(python3 - "$1" "$2" <<'PY'
import sys, yaml
def secrets(p):
    return {d["metadata"]["name"] for d in yaml.safe_load_all(open(p))
            if isinstance(d, dict) and d.get("kind") == "Secret" and (d.get("metadata") or {}).get("name")}
print("\n".join(sorted(secrets(sys.argv[1]) - secrets(sys.argv[2]))))
PY
)
refuse=""
# FAIL CLOSED: only an explicit NotFound (--ignore-not-found: exit 0, empty output) counts as "not
# on the cluster". Any kubectl error — unreachable API server, forbidden, timeout — refuses.
unreadable=""
for n in $gone; do
  if ! got=$(kubectl --context "$CTX" -n "$NS" get secret "$n" --ignore-not-found -o 'jsonpath={.metadata.name}|{.metadata.annotations.helm\.sh/resource-policy}' 2>/dev/null); then
    unreadable="$unreadable $n"; continue
  fi
  if [ -z "$got" ]; then echo "   Secret $n: no longer rendered and not on the cluster — nothing to delete"
  elif [ "$got" = "$n|keep" ]; then echo "   Secret $n: no longer rendered; the live object carries helm.sh/resource-policy: keep — Helm leaves it"
  elif [ "${got%%|*}" = "$n" ]; then refuse="$refuse $n"
  else unreadable="$unreadable $n"; fi
done
if [ -n "$unreadable" ]; then
  echo "SECRET_DELETION_REFUSED — cannot read the live Secret(s):$unreadable (kubectl failed), and this upgrade would delete them if they exist. Refusing rather than guessing." >&2
  exit 1
fi
if [ -n "$refuse" ]; then
  echo "SECRET_DELETION_REFUSED — this change would DELETE the live Secret(s):$refuse. For External Secrets, deploy the handover release first (externalSecrets.handover); see docs/ops/external-secrets-migration.md." >&2
  exit 1
fi
