#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Restore drill reporter (WP-56 §3). Collects the result of every EXPECTED check
# ($DRILL_CHECKS, e.g. "git postgres opensearch"); a check without a result file is a FAILURE
# (its step crashed or never ran) — a drill cannot pass by having nothing to say.
#   - writes the report to $S3_BUCKET: drills/<kind>/<UTC-stamp>.json and drills/<kind>/latest;
#   - patches the ConfigMap $STATUS_CONFIGMAP key <kind>.json, which Monitoring reads
#     (interim for WP-05's alerting: a failed drill is a red Monitoring item and an alert there);
#   - logs one JSON line `"event":"restore-drill-report"`;
#   - exits 1 when the drill failed, so the Job is Failed in Kubernetes as well.
set -u
. "${BACKUP_LIB:-/opt/soa/backup/lib.sh}"
: "${RESULTS_DIR:?}" "${DRILL_CHECKS:?}"
KIND=${DRILL_KIND:-weekly}
W=${BACKUP_WORK:-/tmp}/report.$$; mkdir -p "$W"
: > "$W/checks.jsonl"
for c in $DRILL_CHECKS; do
  f="$RESULTS_DIR/$c.json"
  if [ -s "$f" ] && jq -e '.status=="pass" or .status=="fail"' "$f" >/dev/null 2>&1; then jq -c . "$f" >> "$W/checks.jsonl"
  else jq -cn --arg c "$c" '{check:$c, status:"fail", reason:"no result: the step crashed or did not run"}' >> "$W/checks.jsonl"; fi
done
jq -s --arg kind "$KIND" --arg at "$(now_iso)" \
  '{kind:$kind, at:$at, status:(if length>0 and all(.[]; .status=="pass") then "pass" else "fail" end), checks:.}' \
  "$W/checks.jsonl" > "$W/report.json"
STATUS=$(jq -r .status "$W/report.json")

rc=0
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
if ! { put_file "drills/$KIND/$STAMP.json" "$W/report.json" application/json && put_file "drills/$KIND/latest" "$W/report.json" application/json; }; then
  log restore-drill-report error kind "$KIND" reason "report upload to the bucket failed"; rc=1
fi
if [ -n "${STATUS_CONFIGMAP:-}" ]; then
  SA=/var/run/secrets/kubernetes.io/serviceaccount
  jq -n --arg k "$KIND.json" --rawfile v "$W/report.json" '{data:{($k):$v}}' > "$W/patch.json"
  code=$(curl -sS -o "$W/k8s.out" -w '%{http_code}' --cacert "$SA/ca.crt" -H "Authorization: Bearer $(cat "$SA/token")" \
    -H 'Content-Type: application/merge-patch+json' -X PATCH --data-binary "@$W/patch.json" \
    "https://kubernetes.default.svc/api/v1/namespaces/$(cat "$SA/namespace")/configmaps/$STATUS_CONFIGMAP") || code=000
  [ "$code" = 200 ] || { log restore-drill-report error kind "$KIND" reason "status ConfigMap patch failed: HTTP $code"; rc=1; }
fi
jq -c --arg ts "$(now_iso)" '{ts:$ts, event:"restore-drill-report", status, kind, checks:[.checks[]|{check,status,reason}]}' "$W/report.json"
[ "$STATUS" = pass ] || exit 1
exit $rc
