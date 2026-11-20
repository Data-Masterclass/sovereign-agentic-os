#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# rollback.sh — one command back to the previous Helm revision of an environment.
# =============================================================================
#   ./scripts/rollback.sh --env dev|prod [--to <revision>] [--dry-run] [--allow-runner-downgrade]
#
# Without --to it goes back ONE revision: the newest revision below the current one. Every
# deploy records the revision it replaced (deploy.sh DEPLOY_RECORD; the dev/prod workflows put
# it in the job summary and the `deploy-record` artifact), so `--to <that number>` is the exact
# undo of one deploy.
#
# The context follows the env, as in deploy.sh, and scripts/lib/env-guard.sh refuses a mismatch.
# prod first takes the standing pre-upgrade backup (deploy/pre-upgrade-backup.sh) with a
# kubeconfig that holds only the production context; dev does not (synthetic data).
#
# What a rollback does NOT undo: data. Helm restores the manifests (images, config, values) of
# the revision; database rows, object-storage contents and PVCs stay as they are. A migration
# that changed a schema needs its own restore (docs/backups.md).
#
# DATA-RUNNER DOWNGRADE GUARD. A runner that applies os-ui's `columnNames` makes datasets STORE
# mapped column names (order_date <- "Order Date"); an older runner ignores them and lands raw
# headers, which os-ui then refuses to register (COLUMN_MAPPING_MISMATCH) — uploads to those
# datasets fail until the runner is forward again. So going from a revision whose data-runner
# carries `sovereign-os/applies-column-names: "true"` to one that does not is REFUSED while any
# dataset stores mapped names (scripts/lib/mapped-columns.sh, read-only), and also when that count
# cannot be read. `--allow-runner-downgrade` (rollback.yml input `allow_runner_downgrade`) is the
# explicit override.
#
# THIS SCRIPT IS THE ONLY SUPPORTED ROLLBACK PATH. A manual `helm rollback` is NOT guarded: it
# skips the backup, the environment guard and this data-runner check. Use rollback.sh (or the
# rollback.yml workflow, which runs it).
#
# Last line: ROLLBACK_OK env=<env> <from> -> <to> | ROLLBACK_DRY_RUN env=... | ROLLBACK_REFUSED: <why>
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_NAME='' TO='' DRY_RUN='' ALLOW_RUNNER_DOWNGRADE=''
while [ $# -gt 0 ]; do
  case $1 in
    --env)     ENV_NAME=${2:-}; shift ;;
    --to)      TO=${2:-}; shift ;;
    --dry-run) DRY_RUN=1 ;;
    --allow-runner-downgrade) ALLOW_RUNNER_DOWNGRADE=1 ;;
    -h|--help) sed -n '7p' "$0" | sed 's/^# //'; exit 0 ;;
    *) echo "rollback.sh: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
refuse() { echo "ROLLBACK_REFUSED: $*"; exit 1; }
case $ENV_NAME in
  dev)  CTX=${DEV_KUBE_CONTEXT:-$(bash scripts/lib/env-guard.sh --env dev --print-default-context)} ;;
  prod) CTX=${KUBE_CONTEXT:-$(bash scripts/lib/env-guard.sh --env prod --print-default-context)} ;;
  *)    echo "rollback.sh: --env dev|prod is required (there is no default for a rollback)" >&2; exit 2 ;;
esac
NS=${NS:-agentic-os}
REL=${REL:-agentic-os}
case $TO in ''|*[!0-9]*) [ -z "$TO" ] || refuse "--to must be a revision number" ;; esac

guard=$(bash scripts/lib/env-guard.sh --env "$ENV_NAME" --context "$CTX" 2>/dev/null) \
  || refuse "${guard##*$'\n'}"
echo "   ${guard##*$'\n'}"
hv=$(bash scripts/lib/helm-version-guard.sh 2>&1) || refuse "${hv#HELM_VERSION_REFUSED — }"
echo "$hv"

history=$(helm --kube-context "$CTX" history "$REL" -n "$NS" --max 20 -o json) || refuse "helm history failed on $CTX"
read -r CURRENT TARGET <<<"$(printf '%s' "$history" | python3 -c '
import json, sys
h = sorted(json.load(sys.stdin), key=lambda r: r["revision"])
want = sys.argv[1]
if not h: print("", ""); sys.exit()
cur = h[-1]["revision"]
if want:
    tgt = int(want) if any(r["revision"] == int(want) for r in h) else ""
else:
    older = [r["revision"] for r in h if r["revision"] < cur and r.get("status") in ("superseded", "deployed")]
    tgt = older[-1] if older else ""
print(cur, tgt)' "$TO")"
[ -n "${CURRENT:-}" ] || refuse "release $REL has no history on $CTX"
[ -n "${TARGET:-}" ] || refuse "no revision to go back to (current $CURRENT${TO:+, --to $TO not in the last 20})"
[ "$TARGET" != "$CURRENT" ] || refuse "revision $TARGET is already the current one"

echo "   $ENV_NAME ($CTX): revision $CURRENT -> $TARGET"

# applies_column_names <revision> — `true` / `false` / `absent` for that revision's data-runner.
# FAIL CLOSED: a failed `helm get manifest`, a missing PyYAML or an unparsable manifest refuses
# the rollback rather than skipping the guard.
applies_column_names() {
  local m
  m=$(helm --kube-context "$CTX" get manifest "$REL" -n "$NS" --revision "$1") || return 3
  printf '%s' "$m" | python3 scripts/lib/runner-capability.py - || return 4
}
CAPF=$(mktemp)
trap 'rm -f "$CAPF" "$CAPF.cur" "$CAPF.tgt"' EXIT
capability() { # <revision> — writes the value to $CAPF, or refuses (in THIS shell) naming why
  local rc=0
  applies_column_names "$1" > "$CAPF" || rc=$?
  case $rc in
    0) ;;
    3) refuse "cannot read the manifest of revision $1 to check the data-runner (helm get manifest failed)" ;;
    *) refuse "cannot read the data-runner capability of revision $1 (PyYAML missing or the manifest does not parse)" ;;
  esac
}
capability "$CURRENT"; CAP_CURRENT=$(cat "$CAPF")
capability "$TARGET";  CAP_TARGET=$(cat "$CAPF")
if [ "$CAP_CURRENT" = true ] && [ "$CAP_TARGET" != true ]; then
  probe=${ROLLBACK_MAPPED_COLUMNS_PROBE:-scripts/lib/mapped-columns.sh}
  if mapped=$(bash "$probe" --context "$CTX" --ns "$NS" 2>/dev/null | tail -1) && [[ $mapped =~ ^[0-9]+$ ]]; then :; else mapped=unknown; fi
  if [ "$mapped" != 0 ]; then
    if [ -z "$ALLOW_RUNNER_DOWNGRADE" ]; then
      refuse "revision $TARGET runs a data-runner that does not apply column names, and $mapped dataset(s) store mapped column names — their uploads would fail after this rollback. Roll forward instead, or pass --allow-runner-downgrade to accept it."
    fi
    echo "   WARNING: --allow-runner-downgrade: $mapped dataset(s) store mapped column names; their uploads fail until the runner is forward again"
  fi
fi
# SECRET DELETION GUARD (WP-10): a rollback to a revision that renders fewer Secrets deletes the
# others unless the live object carries helm.sh/resource-policy: keep. Same guard as deploy.sh,
# current manifest vs target manifest. Fail closed.
helm --kube-context "$CTX" get manifest "$REL" -n "$NS" --revision "$CURRENT" > "$CAPF.cur" || refuse "cannot read the manifest of revision $CURRENT (Secret deletion guard)"
helm --kube-context "$CTX" get manifest "$REL" -n "$NS" --revision "$TARGET" > "$CAPF.tgt" || refuse "cannot read the manifest of revision $TARGET (Secret deletion guard)"
sg=$(bash scripts/lib/secret-deletion-guard.sh --context "$CTX" --ns "$NS" "$CAPF.cur" "$CAPF.tgt" 2>&1) || refuse "${sg##*SECRET_DELETION_REFUSED — }"
[ -z "$sg" ] || echo "$sg"
if [ -n "$DRY_RUN" ]; then echo "ROLLBACK_DRY_RUN env=$ENV_NAME $CURRENT -> $TARGET"; exit 0; fi

if [ "$ENV_NAME" = prod ]; then
  WORK=$(mktemp -d)
  ( umask 077; kubectl config view --minify --flatten --context "$CTX" > "$WORK/kubeconfig.yaml" )
  KUBECONFIG=$WORK/kubeconfig.yaml deploy/pre-upgrade-backup.sh || refuse "the pre-upgrade backup failed — no rollback without it"
fi
helm --kube-context "$CTX" rollback "$REL" "$TARGET" -n "$NS" --wait --timeout 20m
kubectl --context "$CTX" -n "$NS" rollout status deploy/os-ui --timeout=15m
echo "ROLLBACK_OK env=$ENV_NAME $CURRENT -> $TARGET"
