#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Monthly Velero restore drill (WP-56 §3). Restores the os-repos volume of the NEWEST completed
# backup of the Velero schedule into the scratch namespace, proves the files with `git fsck --full`
# on every repository, then deletes what it restored. It is the API form of
#
#   velero restore create drill-<stamp> --from-backup <newest backup of $VELERO_SCHEDULE> \
#     --include-namespaces <release ns> --namespace-mappings <release ns>:$SCRATCH_NS \
#     --include-resources pods,persistentvolumeclaims --selector app.kubernetes.io/component=os-ui \
#     --resource-modifier-configmap $MODIFIER_CM
#
# (https://velero.io/docs/v1.15/restore-reference/ , .../restore-resource-modifiers/). The
# resource modifier turns the restored os-ui pod into a one-shot checker: one container
# (backup-tools) that mounts ONLY the restored os-repos claim, runs `git fsck --full` per repo and
# exits. Velero's fs-restore helper fills the volume before that container starts.
# Writes $RESULTS_DIR/velero.json. Talks to the API server with the Job's ServiceAccount.
set -u
: "${RESULTS_DIR:?}" "${VELERO_NS:?}" "${VELERO_SCHEDULE:?}" "${SOURCE_NS:?}" "${SCRATCH_NS:?}" "${MODIFIER_CM:?}"
TIMEOUT=${VELERO_DRILL_TIMEOUT:-3600}
OUT="$RESULTS_DIR/velero.json"
SA=/var/run/secrets/kubernetes.io/serviceaccount
API=https://kubernetes.default.svc
W=${BACKUP_WORK:-/tmp}/velero.$$; mkdir -p "$W"
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
k() { # k METHOD PATH [BODY_FILE [CONTENT_TYPE]] -> body on stdout, status in $W/code
  set -- -sS -o "$W/body" -w '%{http_code}' --cacert "$SA/ca.crt" -H "Authorization: Bearer $(cat "$SA/token")" -X "$1" "$API$2" ${3:+--data-binary "@$3" -H "Content-Type: ${4:-application/json}"}
  curl "$@" > "$W/code" 2>"$W/curl.err" || echo 000 > "$W/code"
  cat "$W/body" 2>/dev/null
}
code() { cat "$W/code"; }
RESTORE=""
cleanup() {
  for p in $(k GET "/api/v1/namespaces/$SCRATCH_NS/pods" | jq -r '.items[]?.metadata.name'); do k DELETE "/api/v1/namespaces/$SCRATCH_NS/pods/$p" >/dev/null; done
  for c in $(k GET "/api/v1/namespaces/$SCRATCH_NS/persistentvolumeclaims" | jq -r '.items[]?.metadata.name'); do k DELETE "/api/v1/namespaces/$SCRATCH_NS/persistentvolumeclaims/$c" >/dev/null; done
  [ -n "$RESTORE" ] && k DELETE "/apis/velero.io/v1/namespaces/$VELERO_NS/restores/$RESTORE" >/dev/null
}
result() { # result STATUS REASON [EXTRA_JSON]
  cleanup
  jq -n --arg s "$1" --arg r "$2" --arg at "$(now_iso)" --arg restore "$RESTORE" --arg backup "${BACKUP:-}" --argjson x "${3:-{\}}" \
    '{check:"velero", status:$s, reason:$r, at:$at, restore:$restore, backup:$backup} + $x' > "$OUT"
  jq -cn --arg ts "$(now_iso)" --arg s "$1" --arg r "$2" '{ts:$ts, event:"restore-drill", status:$s, check:"velero", reason:$r}'
  exit 0
}

# 0. A leftover from an interrupted run must not be mistaken for this run's restore.
cleanup

# 1. The newest COMPLETED backup of the schedule.
k GET "/apis/velero.io/v1/namespaces/$VELERO_NS/backups?labelSelector=velero.io%2Fschedule-name%3D$VELERO_SCHEDULE" > "$W/backups.json"
[ "$(code)" = 200 ] || result fail "cannot list Velero backups (HTTP $(code)): $(head -c 200 "$W/backups.json")"
BACKUP=$(jq -r '[.items[] | select(.status.phase=="Completed")] | sort_by(.status.completionTimestamp) | last | .metadata.name // empty' "$W/backups.json")
[ -n "$BACKUP" ] || result fail "schedule '$VELERO_SCHEDULE' has no completed backup"

# 2. The Restore (namespace mapping into the scratch namespace, os-ui pod + its claims only).
RESTORE="drill-$(date -u +%Y%m%d%H%M%S)"
jq -n --arg n "$RESTORE" --arg ns "$VELERO_NS" --arg b "$BACKUP" --arg src "$SOURCE_NS" --arg dst "$SCRATCH_NS" --arg cm "$MODIFIER_CM" '{
  apiVersion:"velero.io/v1", kind:"Restore", metadata:{name:$n, namespace:$ns, labels:{"app.kubernetes.io/component":"velero-drill"}},
  spec:{backupName:$b, includedNamespaces:[$src], namespaceMapping:{($src):$dst},
        includedResources:["pods","persistentvolumeclaims"],
        labelSelector:{matchLabels:{"app.kubernetes.io/component":"os-ui"}},
        restorePVs:true, existingResourcePolicy:"none",
        resourceModifier:{kind:"ConfigMap", name:$cm}}}' > "$W/restore.json"
k POST "/apis/velero.io/v1/namespaces/$VELERO_NS/restores" "$W/restore.json" > "$W/created.json"
[ "$(code)" = 201 ] || { R=$RESTORE; RESTORE=""; result fail "creating Restore $R refused (HTTP $(code)): $(head -c 300 "$W/created.json")"; }

# 3. Wait for the Restore, then for the checker pod.
t=0; phase=""
while [ "$t" -lt "$TIMEOUT" ]; do
  phase=$(k GET "/apis/velero.io/v1/namespaces/$VELERO_NS/restores/$RESTORE" | jq -r '.status.phase // ""')
  case $phase in Completed|PartiallyFailed|Failed|FailedValidation) break ;; esac
  sleep 15; t=$((t + 15))
done
[ "$phase" = Completed ] || result fail "Restore $RESTORE ended in phase '${phase:-timeout}' (velero restore describe $RESTORE --details)"
k GET "/apis/velero.io/v1/namespaces/$VELERO_NS/podvolumerestores?labelSelector=velero.io%2Frestore-name%3D$RESTORE" > "$W/pvr.json"
PVR=$(jq -c '[.items[]? | {volume:.spec.volume, phase:.status.phase}]' "$W/pvr.json")
printf '%s' "$PVR" | jq -e 'any(.[]; .volume=="os-repos" and .phase=="Completed")' >/dev/null \
  || result fail "no completed file-level restore of the os-repos volume" "{\"podVolumeRestores\":$PVR}"
POD=""
while [ "$t" -lt "$TIMEOUT" ]; do
  POD=$(k GET "/api/v1/namespaces/$SCRATCH_NS/pods" | jq -r '.items[0].metadata.name // empty')
  ph=$(k GET "/api/v1/namespaces/$SCRATCH_NS/pods/$POD" | jq -r '.status.phase // ""')
  case $ph in Succeeded|Failed) break ;; esac
  sleep 10; t=$((t + 10))
done
k GET "/api/v1/namespaces/$SCRATCH_NS/pods/$POD/log?container=velero-drill-check" > "$W/check.log"
REPORT=$(grep '^VELERO-DRILL ' "$W/check.log" | tail -n1 | cut -d' ' -f2-)
printf '%s' "$REPORT" | jq -e . >/dev/null 2>&1 || result fail "the checker pod produced no report (phase ${ph:-timeout}): $(tail -c 300 "$W/check.log")" "{\"podVolumeRestores\":$PVR}"
X=$(jq -cn --argjson r "$REPORT" --argjson p "$PVR" '{repos:$r.repos, podVolumeRestores:$p}')
if printf '%s' "$REPORT" | jq -e '(.repos|length)>0 and all(.repos[]; .fsck=="ok")' >/dev/null; then
  result pass "backup $BACKUP restored into $SCRATCH_NS; git fsck --full clean on $(printf '%s' "$REPORT" | jq '.repos|length') repositories" "$X"
fi
result fail "restored volume failed git fsck (or holds no repository)" "$X"
