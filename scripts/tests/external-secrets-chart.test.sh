#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# external-secrets-chart.test.sh — WP-10 chart test (no cluster). Renders the chart and asserts:
#   * default (externalSecrets off): no ESO object renders, no Secret gains an annotation;
#   * the catalog (files/external-secrets/catalog.yaml) covers every Secret the chart renders, with
#     the same type and every key the chart writes — so an ExternalSecret built from it writes what
#     the consumers read today (secretKeyRef, envFrom, rotate-secrets.sh verify);
#   * handover: the listed Secrets still render, now with helm.sh/resource-policy: keep;
#   * managed: the chart renders NO Secret of that name, and exactly one ExternalSecret with the
#     same name, type and keys, creationPolicy Orphan, through the STACKIT ClusterSecretStore
#     (vault provider, KV v2, userPass, path = instance ID);
#   * the connections ESO template uses the served API, external-secrets.io/v1 (v1beta1 is not served);
#   * failures: no instance ID, no username, a managed name missing from the catalog;
#   * negative twins: a catalog that drops a key, and a template whose Secret is not guarded, must
#     each make the corresponding check fail.
# Skips (exit 0) without helm or the subchart .tgz files — but FAILS when CI is set.
# Never prints a value: Secrets are compared by key names and types only.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
CHART=charts/sovereign-agentic-os
skip() {
  if [ -n "${CI:-}" ]; then echo "external-secrets-chart: $1 — FAILING because CI is set"; exit 1; fi
  echo "external-secrets-chart: $1 — SKIPPED"; exit 0
}
command -v helm >/dev/null 2>&1 || skip "helm not on PATH"
ls "$CHART"/charts/*.tgz >/dev/null 2>&1 || skip "chart dependencies not built"

OPT=(--set osUI.graph.enabled=true --set osUI.smtp.enabled=true --set serviceBearer.enabled=true
     --set postgres.governance.enabled=true --set postgres.governance.adminSecretName=pg-admin)
ON=(--set externalSecrets.enabled=true --set externalSecrets.store.instanceId=00000000-0000-0000-0000-000000000000
    --set externalSecrets.store.username=eso-reader)
render() { # render <chart dir> <args…> → $out (stdout), $rc; the error text is appended on failure
  local c=$1 e; shift; e=$(mktemp)
  out=$(helm template t "$c" -n agentic-os --skip-schema-validation "$@" 2>"$e"); rc=$?
  [ "$rc" -eq 0 ] || out="$out$(cat "$e")"
  rm -f "$e"
}
# py <check> <chart dir> — runs one named check over $out; prints "OK" or the reason.
py() {
  printf '%s' "$out" | python3 scripts/tests/external-secrets-check.py "$1" "$2" "${3:-}"
}

echo "== default: nothing changes"
render "$CHART" "${OPT[@]}"; rc_is "default render" 0
check "no ExternalSecret / ClusterSecretStore" "OK" "$(py no-eso "$CHART")"
check "no Secret carries an ESO handover annotation" "OK" "$(py no-handover "$CHART")"
check "catalog covers every rendered Secret (name, type, keys)" "OK" "$(py catalog-covers "$CHART")"

CHART_SECRETS=$(python3 -c 'import yaml,sys; c=yaml.safe_load(open(sys.argv[1]))["secrets"]; print(",".join(k for k,v in c.items() if v["source"]=="chart"))' "$CHART/files/external-secrets/catalog.yaml")
ALL=$(python3 -c 'import yaml,sys; print(",".join(yaml.safe_load(open(sys.argv[1]))["secrets"]))' "$CHART/files/external-secrets/catalog.yaml")

echo "== handover (step 1)"
render "$CHART" "${OPT[@]}" --set "externalSecrets.handover={$CHART_SECRETS}"; rc_is "handover render" 0
check "every chart Secret still renders, with helm.sh/resource-policy: keep" "OK" "$(py handover-keep "$CHART" "$CHART_SECRETS")"
check "handover alone renders no ESO object" "OK" "$(py no-eso "$CHART")"

echo "== managed (step 2)"
render "$CHART" "${OPT[@]}" "${ON[@]}" --set "externalSecrets.managed={$ALL}"; rc_is "managed render" 0
check "the chart renders none of the managed Secrets" "OK" "$(py not-rendered "$CHART" "$ALL")"
check "one ExternalSecret per managed Secret: same name, type, keys; Orphan; STACKIT store" "OK" "$(py externalsecrets "$CHART" "$ALL")"
check "ClusterSecretStore: vault KV v2, userPass, path = instance ID, this namespace only" "OK" "$(py store "$CHART")"
render "$CHART" "${ON[@]}" --set "externalSecrets.managed={litellm-credentials}" --set externalSecrets.remotePrefix=prod
check "remotePrefix sets the remote key" "OK" "$(py remote-key "$CHART" "prod/litellm-credentials")"
render "$CHART" "${ON[@]}" --set "externalSecrets.managed={ghcr-pull}"
check "a key starting with '.' reads a plain remote property" "OK" "$(py remote-property "$CHART" "ghcr-pull:.dockerconfigjson=dockerconfigjson")"

echo "== the connections ESO template uses the served API version"
render "$CHART" --set connections.externalSecrets.enabled=true
rc_is "connections ESO render" 0
check "every ExternalSecret is external-secrets.io/v1" "OK" "$(py api-v1 "$CHART")"

echo "== refusals"
render "$CHART" --set externalSecrets.enabled=true --set externalSecrets.store.username=u
rc_is "no instance ID fails" 1; check "names the missing instance ID" "externalSecrets.store.instanceId is required" "$out"
render "$CHART" --set externalSecrets.enabled=true --set externalSecrets.store.instanceId=x
rc_is "no username fails" 1; check "names the missing username" "externalSecrets.store.username is required" "$out"
render "$CHART" "${ON[@]}" --set "externalSecrets.managed={no-such-secret}"
rc_is "a name outside the catalog fails" 1; check "names the unknown Secret" "is not in files/external-secrets/catalog.yaml" "$out"

echo "== negative twins (the checks must catch a broken chart)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cp -R "$CHART" "$T/c1"
python3 - "$T/c1/files/external-secrets/catalog.yaml" <<'PY'
import sys, yaml
p = sys.argv[1]; d = yaml.safe_load(open(p))
d["secrets"]["litellm-credentials"]["keys"].remove("masterkey")
yaml.safe_dump(d, open(p, "w"))
PY
render "$T/c1" "${OPT[@]}"
absent "twin: a catalog without litellm-credentials/masterkey fails catalog-covers" "OK" "$(py catalog-covers "$T/c1")"
cp -R "$CHART" "$T/c2"
python3 - "$T/c2/templates/base/os-ui/os-ui-session.yaml" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
s = s.replace('{{- if not (include "soa.eso.owned" (list $ $name)) }}\n', '{{- if true }}\n')
open(p, "w").write(s)
PY
render "$T/c2" "${OPT[@]}" "${ON[@]}" --set "externalSecrets.managed={os-ui-session}"
absent "twin: an unguarded os-ui-session fails not-rendered (Helm and ESO would both write it)" "OK" "$(py not-rendered "$T/c2" "os-ui-session")"

finish external-secrets-chart
