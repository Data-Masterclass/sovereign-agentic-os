#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# key-init-job — the chart's shared-key init Job, RENDERED and EXECUTED against the real LiteLLM.
# Called by run.sh (which starts the gateway and exports GW, MASTER, CHART, W, JSYAML).
#
#   default render      absent key -> created; present and equal -> "matches"; hand-edited in LiteLLM
#                       -> reported as [key-drift] and NOT overwritten (the edit survives the upgrade)
#   NEGATIVE TWIN       litellmAgentKey.reapplyOnUpgrade=true -> the same edit IS overwritten
#   no key in the log   the Job's output never contains the key value or the master key
set -uo pipefail
: "${GW:?}" "${MASTER:?}" "${CHART:?}" "${W:?}" "${JSYAML:?}"
fail=0
ok()  { printf '  ok   %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; fail=1; }
has() { case $3 in *"$2"*) ok "$1" ;; *) bad "$1 — expected: $2"; printf '%s\n' "${3:0:600}"; ;; esac; }
lacks() { case $3 in *"$2"*) bad "$1 — must not contain: $2"; ;; *) ok "$1" ;; esac; }

# The Job script of a render, with the in-cluster service name pointed at the test gateway.
job_script() {
  helm template agentic-os "$CHART" -n agentic-os --skip-schema-validation --show-only templates/base/litellm/agent-key.yaml "$@" 2>/dev/null \
    | node -e '
const y=require(process.argv[1]); let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{
  const d=y.loadAll(s).filter(Boolean).find(x=>x.kind==="Job"&&x.metadata.name==="litellm-agent-key-init");
  process.stdout.write(d.spec.template.spec.containers[0].args[0].replace(/http:\/\/agentic-os-litellm:4000/g, process.argv[2]));})' "$JSYAML" "$GW"
}
VKEY="sk-job-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
export MASTER_KEY=$MASTER VIRTUAL_KEY=$VKEY
run_job() { sh -c "$1" 2>&1; }
info() { curl -fsS -H "Authorization: Bearer $MASTER" "$GW/key/info?key=$VKEY"; }
live() { info | python3 -c 'import json,sys; print(json.load(sys.stdin)["info"][sys.argv[1]])' "$1"; }

DEFAULT=$(job_script); REAPPLY=$(job_script --set litellmAgentKey.reapplyOnUpgrade=true)
[ -n "$DEFAULT" ] && [ -n "$REAPPLY" ] || { echo "key-init-job: could not render the Job"; exit 1; }
echo "key-init Job on the real gateway"

o=$(run_job "$DEFAULT")
has "an absent key is created" "virtual key created" "$o"
[ "$(live max_budget)" = "25.0" ] || [ "$(live max_budget)" = "25" ] && ok "the created key carries the chart's budget" || bad "created budget is $(live max_budget)"

o=$(run_job "$DEFAULT")
has "a key equal to the chart values is reported as matching (no false drift on the real /key/info)" "matches the chart values" "$o"
lacks "…and no drift line" "[key-drift]" "$o"

curl -fsS -X POST "$GW/key/update" -H "Authorization: Bearer $MASTER" -H "Content-Type: application/json" \
  -d '{"key":"'"$VKEY"'","max_budget":999,"rpm_limit":7}' >/dev/null || bad "the hand edit through LiteLLM's API failed"
o=$(run_job "$DEFAULT")
has "a hand edit is reported (budget)" "[key-drift] max_budget: chart=25 live=999" "$o"
has "a hand edit is reported (rpm)" "[key-drift] rpm_limit: chart=300 live=7" "$o"
has "the report says nothing was overwritten" "NOT overwritten" "$o"
[ "$(live max_budget)" = "999.0" ] || [ "$(live max_budget)" = "999" ] && ok "the platform team's budget survived the upgrade" || bad "budget was overwritten: $(live max_budget)"
[ "$(live rpm_limit)" = "7" ] && ok "the platform team's rate limit survived the upgrade" || bad "rpm was overwritten: $(live rpm_limit)"

o=$(run_job "$REAPPLY")
has "NEGATIVE TWIN: with reapplyOnUpgrade the Job re-applies" "virtual key reconciled" "$o"
[ "$(live max_budget)" = "25.0" ] || [ "$(live max_budget)" = "25" ] && ok "…and the chart's budget is back" || bad "budget not restored: $(live max_budget)"
[ "$(live rpm_limit)" = "300" ] && ok "…and the chart's rate limit" || bad "rpm not restored: $(live rpm_limit)"

all="$o$(run_job "$DEFAULT")"
lacks "the Job log never carries the key value" "$VKEY" "$all"
lacks "…nor the master key" "$MASTER" "$all"
[ "$fail" -eq 0 ] && echo "key-init-job: all passed" || { echo "key-init-job: FAILED"; exit 1; }
