#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# adopt-secret.sh <context> <namespace> <release> <secret>…
#
# Hand a Secret that used to be created by hand over to the Helm release that now renders it.
# Helm installs/upgrades refuse an existing object without the release's ownership metadata
# ("invalid ownership metadata"), so before the chart started rendering `dagster-postgresql`
# (templates/base/postgres/credentials.yaml) every hand-made copy would have failed the upgrade.
# Per Secret:
#   - absent                               -> nothing (Helm creates it);
#   - owned by THIS release                -> nothing (prod: its copy carries the metadata already);
#   - owned by ANOTHER release             -> refused, exit 1 (never steal an object);
#   - no Helm metadata (made by kubectl)   -> labelled app.kubernetes.io/managed-by=Helm and
#     annotated meta.helm.sh/release-name / release-namespace, the documented adoption contract
#     (Helm >= 3.2, helm/helm#7649).
# A kubectl failure other than NotFound fails closed (exit 1). Values are never read.
set -euo pipefail
[ $# -ge 4 ] || { echo "usage: adopt-secret.sh <context> <namespace> <release> <secret>…" >&2; exit 2; }
ctx=$1 ns=$2 rel=$3; shift 3
KUBECTL=${KUBECTL:-kubectl}
k() { "$KUBECTL" --context "$ctx" -n "$ns" "$@"; }
for name in "$@"; do
  if ! found=$(k get secret "$name" --ignore-not-found -o name 2>&1); then
    echo "ADOPT_SECRET_UNREADABLE — cannot read Secret $ns/$name: ${found##*$'\n'}" >&2; exit 1
  fi
  if [ -z "$found" ]; then echo "   $name: absent — the chart creates it"; continue; fi
  meta=$(k get secret "$name" -o jsonpath='{.metadata.labels.app\.kubernetes\.io/managed-by}|{.metadata.annotations.meta\.helm\.sh/release-name}|{.metadata.annotations.meta\.helm\.sh/release-namespace}') \
    || { echo "ADOPT_SECRET_UNREADABLE — cannot read the metadata of Secret $ns/$name" >&2; exit 1; }
  IFS='|' read -r by owner owner_ns <<<"$meta"
  if [ "$owner" = "$rel" ] && [ "$owner_ns" = "$ns" ] && [ "$by" = Helm ]; then
    echo "   $name: owned by release $rel — nothing to adopt"; continue
  fi
  if [ -n "$owner" ] && [ "$owner" != "$rel" ]; then
    echo "ADOPT_SECRET_REFUSED — Secret $ns/$name belongs to Helm release '$owner', not '$rel'" >&2; exit 1
  fi
  k label secret "$name" app.kubernetes.io/managed-by=Helm --overwrite >/dev/null
  k annotate secret "$name" meta.helm.sh/release-name="$rel" meta.helm.sh/release-namespace="$ns" --overwrite >/dev/null
  echo "   $name: adopted into release $rel (it was created outside Helm)"
done
