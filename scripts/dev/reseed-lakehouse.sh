#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# reseed-lakehouse.sh — refill dev's lakehouse after Polaris lost its catalog contents.
# =============================================================================
#   scripts/dev/reseed-lakehouse.sh [--no-seed]
#
# WHEN: right after the first dev deploy that switches Polaris from in-memory to relational-jdbc
# (the chart default since the pilot fixes), or after any in-memory Polaris restart. The new
# metastore is empty; the post-upgrade hook polaris-catalog-init re-creates only the empty
# `lakehouse` catalog. The data products in it are built by POST-INSTALL hooks, which Helm never
# re-runs on an upgrade (docs/runbooks/failed-install-hooks.md). This script re-runs them, from the
# release's own rendered hooks (`helm get hooks`), in Helm's weight order:
#   polaris-catalog-init (10, idempotent) -> dbt-build (15) -> northpeak-marts-init (20),
# then scripts/dev/seed.sh (the Northpeak domains through the OS API) unless --no-seed.
# Dev cluster only (the marked-dev guard every scripts/dev tool uses); refuses anything else.
. "$(dirname "$0")/lib.sh"
SEED=1; [ "${1:-}" = --no-seed ] && SEED=""
require_marked_dev

say "Polaris on $CTX"
k -n "$NS" rollout status deploy/polaris --timeout=10m
ptype=$(k -n "$NS" get deploy polaris -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="POLARIS_PERSISTENCE_TYPE")].value}')
echo "   persistence: ${ptype:-unknown}"
[ "$ptype" = relational-jdbc ] || echo "   WARNING: Polaris is not on relational-jdbc — a restart will empty the catalog again"

HOOKS=$(mktemp); trap 'rm -f "$HOOKS"' EXIT
helm --kube-context "$CTX" -n "$NS" get hooks "$REL" > "$HOOKS" || die "cannot read the hooks of release $REL"
job_from_hooks() { # <job name> -> the Job document of that name from the release's hooks
  awk -v j="$1" '/^---/{if (doc ~ ("\n  name: " j "\n") && doc ~ /\nkind: Job\n/) print doc; doc=""; next} {doc = doc "\n" $0} END{if (doc ~ ("\n  name: " j "\n") && doc ~ /\nkind: Job\n/) print doc}' "$HOOKS"
}
rerun() { # <job name>
  local doc; doc=$(job_from_hooks "$1")
  if [ -z "$doc" ]; then echo "   $1: not a hook of this release (disabled in its values) — skipped"; return 0; fi
  say "re-run $1"
  k -n "$NS" delete job "$1" --ignore-not-found --wait >/dev/null
  printf '%s\n' "$doc" | k -n "$NS" create -f - >/dev/null
  if ! k -n "$NS" wait --for=condition=complete "job/$1" --timeout=30m; then
    k -n "$NS" logs "job/$1" --all-containers --prefix --tail=40 || true
    die "$1 did not complete (the failed Job is kept for inspection)"
  fi
  k -n "$NS" logs "job/$1" --all-containers --tail=3 || true
  k -n "$NS" delete job "$1" --wait=false >/dev/null   # Helm would delete a succeeded hook; kubectl-created ones are ours to remove
}
rerun polaris-catalog-init
rerun dbt-build
rerun northpeak-marts-init

if [ -n "$SEED" ]; then
  say "Northpeak domains (scripts/dev/seed.sh)"
  "$REPO_ROOT/scripts/dev/seed.sh"
fi
echo "RESEED_LAKEHOUSE_OK context=$CTX"
