#!/usr/bin/env bash
# Deploy the Campaign-Optimization exercise to the live STACKIT cluster.
# Run from the repo root:  ! bash deploy/apply-campaign-exercise.sh
#
# What it does (all against ns agentic-os):
#   1. Roll os-ui (agent run-scope + file_promote fix + agentic-leader role refactor).
#   2. Update OS_USERS auth config from values.private.yaml (45 rows: 8 migrated
#      base rows + the Agentic-Leader Q3-2026 cast — alp-instructor + 36 real
#      participants, role `agentic-leader`, id = email).
#   3. Verify admin (aborek) + the first Agentic-Leader participant can log in.
#   4. Seed the Campaign-Optimization materials (datasets, 3 knowledge MDs,
#      sample-campaign files, ready-made Campaign Evaluation Agent, Campaign App)
#      into domain `agentic-leader-q3-2026` via the platform's own governed endpoints.
set -euo pipefail
cd "$(dirname "$0")/.."
export KUBECONFIG="$PWD/deploy/kubeconfig.yaml"
NS=agentic-os
IMG=ghcr.io/aborek/sovereign-os/os-ui:0.1.25

echo "== 1. roll os-ui -> 0.1.25 =="
kubectl -n $NS set image deploy/os-ui os-ui=$IMG

echo "== 2. update OS_USERS auth (8 migrated base rows + Agentic-Leader cast) =="
node -e '
const fs=require("fs");const t=fs.readFileSync("values.private.yaml","utf8");
const m=t.match(/usersSeed:\s*.(\[.*\]).\s*$/m);
if(!m){console.error("usersSeed not found in values.private.yaml");process.exit(1);}
const val=m[1];const rows=JSON.parse(val);
if(!rows.every(r=>r.email)){console.error("some rows missing email");process.exit(1);}
const patch={spec:{template:{spec:{containers:[{name:"os-ui",env:[{name:"OS_USERS",value:val}]}]}}}};
fs.writeFileSync("/tmp/os-users-patch.json",JSON.stringify(patch));
console.error("   OS_USERS rows:",rows.length);'
kubectl -n $NS patch deploy os-ui --type=strategic --patch-file /tmp/os-users-patch.json
rm -f /tmp/os-users-patch.json
kubectl -n $NS rollout status deploy/os-ui --timeout=420s

echo "== 3. verify logins =="
# The login route reads {username,...}. (This block previously POSTed {handle} —
# a test-only bug that always 401'd; fixed here.) The participant email + shared
# password come from the gitignored users.secret.json (the non-instructor key).
PART_EMAIL=$(node -e 'const c=require("./seed/campaign/users.secret.json");console.log(Object.keys(c).find(k=>k!=="alp-instructor"))')
PART_PW=$(node -e 'const c=require("./seed/campaign/users.secret.json");console.log(c[Object.keys(c).find(k=>k!=="alp-instructor")])')
# Admin creds are read from the gitignored values.private.yaml — NEVER hardcode a
# live password in this tracked script (it publishes to the public repo).
ADMIN_PW=$(node -e 'const fs=require("fs");const m=fs.readFileSync("values.private.yaml","utf8").match(/usersSeed:\s*.(\[.*\]).\s*$/m);const x=(JSON.parse(m[1]).find(r=>r.id==="aborek"))||{};console.log(x.password||"")')
ADMIN_EMAIL=$(node -e 'const fs=require("fs");const m=fs.readFileSync("values.private.yaml","utf8").match(/usersSeed:\s*.(\[.*\]).\s*$/m);const x=(JSON.parse(m[1]).find(r=>r.id==="aborek"))||{};console.log(x.email||"")')
kubectl -n $NS exec deploy/os-ui -- node -e '
(async()=>{
 const L=(u,p)=>fetch("http://localhost:3000/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:u,password:p})}).then(r=>r.status);
 console.log("   aborek(id)     ->", await L("aborek", process.argv[3]));
 console.log("   admin(email)   ->", await L(process.argv[4], process.argv[3]));
 console.log("   participant    ->", await L(process.argv[1], process.argv[2]));
})()' "$PART_EMAIL" "$PART_PW" "$ADMIN_PW" "$ADMIN_EMAIL"

echo "== 4. seed the Campaign-Optimization exercise into domain agentic-leader-q3-2026 =="
kubectl -n $NS delete configmap northpeak-campaign-seed --ignore-not-found
kubectl -n $NS create configmap northpeak-campaign-seed \
  --from-file=seed.mjs=seed/campaign/seed.mjs \
  --from-file=narrative.mjs=seed/campaign/narrative.mjs \
  --from-file=client.mjs=seed/ecommerce/lib/client.mjs
kubectl -n $NS delete secret northpeak-campaign-credentials --ignore-not-found
kubectl -n $NS create secret generic northpeak-campaign-credentials \
  --from-file=SEED_CREDENTIALS=seed/campaign/users.secret.json
kubectl -n $NS delete job northpeak-campaign-seed --ignore-not-found
kubectl -n $NS apply -f seed/campaign/k8s/job.yaml
echo "   waiting for seed job..."
kubectl -n $NS wait --for=condition=complete job/northpeak-campaign-seed --timeout=600s || true
echo "== seed job logs (tail) =="
kubectl -n $NS logs job/northpeak-campaign-seed --tail=60 || true
echo "== DONE =="
