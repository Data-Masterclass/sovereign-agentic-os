#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Pilot-install fixes for Polaris and the install hooks, on the rendered chart:
#   - Polaris persists to Postgres (relational-jdbc) by default on every profile; in-memory is opt-in;
#   - the JVM heap is a bounded share of the container limit (JAVA_MAX_MEM_RATIO, read by the image's
#     run-java.sh), on the server AND the bootstrap admin tool;
#   - northpeak-marts-init ensures the `lakehouse` catalog itself before it uses it;
#   - every hook Job of this chart (not the subcharts') keeps a FAILED run inspectable: Helm deletes
#     it only on success (before-hook-creation,hook-succeeded) and no TTL deletes it behind Helm's back.
set -uo pipefail
cd "$(dirname "$0")/../.."
. scripts/tests/assert.sh
CHART=charts/sovereign-agentic-os
ls "$CHART"/charts/*.tgz >/dev/null 2>&1 || { [ -n "${CI:-}" ] && { echo "subcharts missing"; exit 1; }; echo "SKIP: subcharts not built"; exit 0; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
r() { out=$(helm template t "$CHART" -n agentic-os --skip-schema-validation --set global.allowChartDefaultSecrets=true "$@" 2>"$T/err"); rc=$?; err=$(cat "$T/err"); printf '%s' "$out" > "$T/r.yaml"; }
q() { python3 - "$T/r.yaml" "$@" <<'PY'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
what = sys.argv[2]
def obj(kind, name): return next((d for d in docs if d["kind"] == kind and d["metadata"]["name"] == name), None)
def env(c, n): return next((e.get("value") for e in c.get("env", []) if e["name"] == n), None)
if what == "polaris":
    s = obj("Deployment", "polaris")["spec"]["template"]["spec"]
    srv = s["containers"][0]; boot = next((c for c in s.get("initContainers", []) if c["name"] == "bootstrap"), {})
    print(env(srv, "POLARIS_PERSISTENCE_TYPE"), env(srv, "JAVA_MAX_MEM_RATIO"), env(boot, "JAVA_MAX_MEM_RATIO"), srv["resources"]["limits"]["memory"])
elif what == "marts-init":
    j = obj("Job", "northpeak-marts-init")
    print(" ".join(c["name"] for c in j["spec"]["template"]["spec"]["initContainers"]) if j else "<absent>")
elif what == "leak":
    # The root secret may appear ONLY inside Secret objects, never in a workload / Job spec.
    needle = sys.argv[3]
    print(" ".join(sorted("%s/%s" % (d["kind"], d["metadata"]["name"]) for d in docs if d["kind"] != "Secret" and needle in yaml.safe_dump(d))) or "none")
elif what == "hooks":
    bad, n = [], 0
    for d in docs:
        a = d["metadata"].get("annotations") or {}
        if d["kind"] != "Job" or "helm.sh/hook" not in a: continue
        if d["metadata"]["name"].startswith("t-"): continue  # the subcharts' hooks are release-prefixed (release "t")
        n += 1
        pol = set((a.get("helm.sh/hook-delete-policy") or "").split(","))
        if "ttlSecondsAfterFinished" in d["spec"]: bad.append(d["metadata"]["name"] + ": ttlSecondsAfterFinished")
        if pol != {"before-hook-creation", "hook-succeeded"}: bad.append(d["metadata"]["name"] + ": delete policy " + ",".join(sorted(pol)))
    print(n, "|", "; ".join(bad))
PY
}

for prof in default "-f values.local.yaml" "-f values.dev.yaml" "-f values.stackit-managed.yaml"; do
  [ "$prof" = default ] && r || r $prof
  set -- $(q polaris)
  holds "[$prof] Polaris persists to Postgres (relational-jdbc)" [ "$1" = relational-jdbc ]
  holds "[$prof] server heap ratio 50 (JAVA_MAX_MEM_RATIO)" [ "$2" = 50 ]
  holds "[$prof] bootstrap admin tool heap ratio 50" [ "$3" = 50 ]
done

r -f values.local.yaml
check "laptop keeps its 768Mi limit (fits heap 50 % + ~300Mi non-heap)" "768Mi" "$(q polaris)"

r --set polaris.persistenceType=in-memory
set -- $(q polaris)
holds "in-memory is still selectable (opt-in)" [ "$1" = in-memory ]
r --set polaris.persistenceType=memory
rc_is "an unknown persistenceType fails the render" 1
check "  saying which are valid" "relational-jdbc or in-memory" "$err"
r --set polaris.jvm.maxRamPercentage=95
rc_is "a heap ratio above 90 fails the render" 1
r --set polaris.jvm.maxRamPercentage=0
rc_is "an explicit 0 is validated, not defaulted to 50" 1
r --set polaris.jvm.maxRamPercentage=60
set -- $(q polaris)
holds "the ratio is a value (60)" [ "$2" = 60 ]

r
check "marts-init ensures the catalog before the table" "ensure-bucket ensure-catalog ensure-table" "$(q marts-init)"
check "  with the same management-API script as polaris-catalog-init" "api/management/v1/catalogs" "$(grep -A200 'name: ensure-catalog' "$T/r.yaml" | head -200)"

ROOT=root-secret-$RANDOM$RANDOM
for prof in default "-f values.local.yaml" "-f values.dev.yaml"; do
  [ "$prof" = default ] && set -- || set -- $prof
  r "$@" --set polaris.local.rootClientSecret=$ROOT --set polaris.purge.enabled=true
  rc_is "[$prof] renders" 0
  holds "[$prof] the rendered manifest is not empty" [ -n "$(grep -m1 'name: polaris-catalog-init' "$T/r.yaml")" ]
  holds "[$prof] the Polaris root secret is rendered only into Secrets (never a plain env value): $(q leak "$ROOT")" [ "$(q leak "$ROOT")" = none ]
  check "[$prof]   catalog-init / marts-init read it by secretKeyRef" "key: POLARIS_BOOTSTRAP_CREDENTIALS" "$(grep -A3 'name: BOOTSTRAP_CREDS' "$T/r.yaml")"
done

for prof in default "-f values.dev.yaml" "-f values.stackit-managed.yaml" "--set postgres.governance.enabled=true --set postgres.governance.adminSecretName=pg-gov-admin --set polaris.purge.enabled=true"; do
  [ "$prof" = default ] && r || r $prof
  res=$(q hooks)
  holds "[$prof] hook Jobs found ($res)" [ "${res%% *}" -ge 4 ]
  holds "[$prof] every hook Job: deleted only on success, no TTL" [ -z "$(printf '%s' "${res#*|}" | tr -d ' ')" ]
  [ -z "$(printf '%s' "${res#*|}" | tr -d ' ')" ] || echo "     ${res#*|}"
done
finish polaris-hooks-chart && echo POLARIS_HOOKS_CHART_OK
