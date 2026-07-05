#!/usr/bin/env bash
# Deploy the Northpeak cohort DATA seed to the live STACKIT cluster.
# Run from the repo root:  bash deploy/apply-data-seed.sh
#
# GATE: run this ONLY after the Polaris 1.0.1 → 1.1.0 upgrade is verified green —
# on 1.0.1 every new-table create fails (virtual-host S3 bug), and this seed is
# almost entirely new-table CTAS. marts.mjs re-checks with a fail-fast write probe.
#
# What it does (all against ns agentic-os):
#   1. Gate on the Polaris image version (>= 1.1.0; override ALLOW_POLARIS=1).
#   2. Add the teaching domain `northpeak` to alp-instructor + aborek in
#      values.private.yaml usersSeed (idempotent, APPENDED so domains[0] — the
#      default principal — is unchanged), then patch OS_USERS + roll os-ui.
#   3. Compose the seed credentials Secret from the gitignored secrets
#      (values.private.yaml for aborek; seed/campaign/users.secret.json for the
#      instructor + one learner). NEVER hardcoded, NEVER committed.
#   4. Run the northpeak-data-seed Job (marts.mjs → seed.mjs) and tail its logs.
set -euo pipefail
cd "$(dirname "$0")/.."
export KUBECONFIG="$PWD/deploy/kubeconfig.yaml"
NS=agentic-os

echo "== 1. Polaris gate =="
POLARIS_IMG=$(kubectl -n $NS get deploy polaris -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)
echo "   polaris image: ${POLARIS_IMG:-<not found>}"
if [[ "${ALLOW_POLARIS:-0}" != "1" ]] && ! echo "$POLARIS_IMG" | grep -qE '1\.[1-9][0-9]*\.'; then
  echo "   ABORT: Polaris does not look >= 1.1.0 — new-table CTAS will fail (1.0.1 virtual-host S3 bug)."
  echo "   Re-run with ALLOW_POLARIS=1 to override once the upgrade is verified green."
  exit 2
fi

echo "== 2. add domain 'northpeak' to alp-instructor + aborek (OS_USERS) =="
node -e '
const fs = require("fs");
const path = "values.private.yaml";
const t = fs.readFileSync(path, "utf8");
const m = t.match(/usersSeed:\s*.(\[.*\]).\s*$/m);
if (!m) { console.error("usersSeed not found in values.private.yaml"); process.exit(1); }
const rows = JSON.parse(m[1]);
let changed = false;
for (const id of ["alp-instructor", "aborek"]) {
  const r = rows.find((x) => x.id === id);
  if (!r) { console.error(`usersSeed row missing: ${id}`); process.exit(1); }
  r.domains = r.domains || [];
  if (!r.domains.includes("northpeak")) { r.domains.push("northpeak"); changed = true; } // APPEND (domains[0] unchanged)
}
if (changed) {
  fs.writeFileSync(path, t.replace(m[1], JSON.stringify(rows)));
  console.error("   values.private.yaml updated (northpeak appended)");
} else {
  console.error("   already up to date");
}
const patch = { spec: { template: { spec: { containers: [{ name: "os-ui", env: [{ name: "OS_USERS", value: JSON.stringify(rows) }] }] } } } };
fs.writeFileSync("/tmp/os-users-patch.json", JSON.stringify(patch));
console.error("   OS_USERS rows:", rows.length);'
kubectl -n $NS patch deploy os-ui --type=strategic --patch-file /tmp/os-users-patch.json
rm -f /tmp/os-users-patch.json
kubectl -n $NS rollout status deploy/os-ui --timeout=420s

echo "== 3. compose seed credentials (instructor + admin + one learner) =="
node -e '
const fs = require("fs");
const m = fs.readFileSync("values.private.yaml", "utf8").match(/usersSeed:\s*.(\[.*\]).\s*$/m);
const rows = JSON.parse(m[1]);
const admin = rows.find((r) => r.id === "aborek");
if (!admin || !admin.password) { console.error("aborek password not found in values.private.yaml"); process.exit(1); }
const campaign = JSON.parse(fs.readFileSync("seed/campaign/users.secret.json", "utf8"));
if (!campaign["alp-instructor"]) { console.error("alp-instructor missing from seed/campaign/users.secret.json"); process.exit(1); }
const learner = Object.keys(campaign).find((k) => k !== "alp-instructor");
const creds = { "alp-instructor": campaign["alp-instructor"], aborek: admin.password };
if (learner) creds[learner] = campaign[learner];
fs.writeFileSync("/tmp/data-seed-creds.json", JSON.stringify(creds));
console.error("   credentials for:", Object.keys(creds).join(", "));'
kubectl -n $NS delete secret northpeak-data-seed-credentials --ignore-not-found
kubectl -n $NS create secret generic northpeak-data-seed-credentials \
  --from-file=SEED_CREDENTIALS=/tmp/data-seed-creds.json
rm -f /tmp/data-seed-creds.json

echo "== 4. run the northpeak-data-seed job =="
kubectl -n $NS delete configmap northpeak-data-seed --ignore-not-found
kubectl -n $NS create configmap northpeak-data-seed \
  --from-file=marts.mjs=seed/ecommerce-data/marts.mjs \
  --from-file=seed.mjs=seed/ecommerce-data/seed.mjs \
  --from-file=narrative.mjs=seed/ecommerce-data/narrative.mjs \
  --from-file=client.mjs=seed/ecommerce/lib/client.mjs
kubectl -n $NS delete job northpeak-data-seed --ignore-not-found
kubectl -n $NS apply -f seed/ecommerce-data/k8s/job.yaml
echo "   waiting for the seed job (marts + governed API phases)..."
kubectl -n $NS wait --for=condition=complete job/northpeak-data-seed --timeout=900s || true
echo "== seed job logs (tail) =="
kubectl -n $NS logs job/northpeak-data-seed --tail=120 || true
echo "== DONE — spot-check: Data tab marketplace (6 Northpeak products), Metrics tab (19 metrics), Dashboards (3) =="
