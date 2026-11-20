#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# kubeconfig.sh — write the dev cluster's admin kubeconfig to a PRIVATE file of its own.
# =============================================================================
#   scripts/dev/kubeconfig.sh            -> ~/.kube/dmagosdev.yaml (mode 600), context dmagosdev
#
# It never touches ~/.kube/config and never sets a current-context anyone else relies on. Use it
# with an explicit KUBECONFIG for dev commands only:
#   KUBECONFIG=~/.kube/dmagosdev.yaml scripts/deploy.sh --env dev --from-registry main-<sha>
# The kubeconfig comes from the dev state (stackit_ske_kubeconfig.dev, 7 days); renew it with
#   tofu -chdir=deploy/envs/dev apply -target=stackit_ske_kubeconfig.dev
# Prints no credential.
. "$(dirname "$0")/lib.sh"
OUT=${DEV_KUBECONFIG_OUT:-$HOME/.kube/$CTX.yaml}
[ "$(tf_out environment 2>/dev/null)" = dev ] || die "deploy/envs/dev has no dev state"
( umask 077; mkdir -p "$(dirname "$OUT")"
  tf_out kubeconfig | python3 -c '
import sys, yaml
ctx = sys.argv[1]
k = yaml.safe_load(sys.stdin)
assert len(k["contexts"]) == 1 and len(k["clusters"]) == 1, "expected one context"
k["contexts"][0]["name"] = ctx
k["current-context"] = ctx   # current-context of THIS private file only
yaml.safe_dump(k, sys.stdout, sort_keys=False)' "$CTX" > "$OUT" )
chmod 600 "$OUT"
echo "wrote $OUT (context $CTX). Use: KUBECONFIG=$OUT <command>"
