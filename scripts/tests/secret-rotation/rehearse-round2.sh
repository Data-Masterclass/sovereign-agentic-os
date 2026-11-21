#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# rehearse-round2.sh — rotation round 2 (docs/ops/WP-secret-rotation.md) on kind, end to end.
# =============================================================================
#   bash scripts/tests/secret-rotation/round2-kind-up.sh     (once: the cluster, chart defaults)
#   bash scripts/tests/secret-rotation/rehearse-round2.sh
#
# The REAL scripts/ops/rotate-secrets.sh ds-* against a kind cluster that runs the chart the way
# production does (local profile, Ingress on, persistence on, the plain Postgres engine, bundled
# MinIO) with its pinned images: Postgres 17, ClickHouse 24.8, Valkey 8.1, MinIO, Langfuse
# 3.194.1 web + worker, LiteLLM 1.109.1 with its agent-key Job, Polaris. Only `deploy.sh` is
# replaced, by the `helm upgrade` it ends with (same chart, release values + the overlay; hooks on).
#
#  0. data before: a Langfuse trace (→ Postgres, ClickHouse, MinIO, Valkey queue), a Valkey marker
#     key, LiteLLM served by the agent key.
#  1. negative twins: prepare refuses a Secret edited by hand; plan refuses a state of another cluster.
#  2. ds-prepare, ds-plan (the render with the overlay changes only the rotated Secrets).
#  3. ds-rekey valkey: old AND new password valid, the marker key still there (Valkey not restarted).
#  4. ds-rekey postgres: every role refuses the old password, accepts the new; readers Ready.
#  5. ds-rekey clickhouse, minio: the server and its readers restarted; data counts kept.
#  6. ds-rekey agent-key: the old key renamed, still served.
#  7. the deploy (helm upgrade with the overlay): the reconcile hook succeeds with the new owner
#     password, key-init creates the new key; ds-verify → DS_VERIFY_OK.
#  8. after the rotation: a NEW trace reaches ClickHouse; a chat through LiteLLM with the new key.
#  9. ds-finish; DS_FINISHED=1 ds-verify: every old credential refused.
# 10. a second deploy with the overlay changes no Secret (the release now carries the values).
# Ends with ROUND2_REHEARSAL_OK.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
CLUSTER=${CLUSTER:-rotation2}; CTX=kind-$CLUSTER; NS=agentic-os; REL=agentic-os
CHART=$REPO/charts/sovereign-agentic-os
W=${REHEARSAL_WORKDIR:-$HOME/.cache/secret-rotation-round2}; mkdir -p "$W"; chmod 700 "$W"
export KUBECONFIG=$W/kubeconfig   # written by round2-kind-up.sh; never the shared ~/.kube/config
export SOVEREIGN_SECRETS_DIR=$W/secrets
ROT=("$REPO/scripts/ops/rotate-secrets.sh")
# ds-plan refuses a chart checkout that does not contain the live os-ui tag (production safety).
# Here os-ui is built from this checkout as 0.1.0: a throwaway clone of HEAD carries that tag.
CLONE=$W/chart-clone
if [ ! -d "$CLONE/.git" ] || [ "$(git -C "$CLONE" rev-parse HEAD)" != "$(git -C "$REPO" rev-parse HEAD)" ]; then
  if [ -d "$CLONE" ]; then mv "$CLONE" "$CLONE.$(date +%s)"; fi
  git clone -q --no-hardlinks "$REPO" "$CLONE" && git -C "$CLONE" checkout -q "$(git -C "$REPO" rev-parse HEAD)"
  git -C "$CLONE" tag -f os-ui-v0.1.0 >/dev/null
  cp -R "$REPO/charts/sovereign-agentic-os/charts" "$CLONE/charts/sovereign-agentic-os/" 2>/dev/null || true
fi
# The rehearsal tests the WORKING TREE's tooling: uncommitted chart changes must be in the clone too.
rsync -a --delete --exclude charts "$REPO/charts/sovereign-agentic-os/" "$CLONE/charts/sovereign-agentic-os/"
pass=0; failn=0
ok()   { pass=$((pass+1)); echo "   ok   $*"; }
bad()  { failn=$((failn+1)); echo "   FAIL $*"; }
step() { printf '\n==================== %s\n' "$*"; }
k()    { kubectl --context "$CTX" -n "$NS" "$@"; }
sk()   { k get secret "$1" -o "go-template={{ index .data \"$2\" }}" | base64 -d; }
rot()  { bash "${ROT[@]}" "$@" --context "$CTX" --namespace "$NS" --release "$REL"; }
PF=""; pf() { stop_pf; k port-forward "svc/$1" "$2:$3" >/dev/null 2>&1 & PF=$!; for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$2" && return 0; sleep 0.2; done; }
stop_pf() { [ -z "$PF" ] || { kill "$PF" 2>/dev/null; wait "$PF" 2>/dev/null; PF=""; }; }
trap stop_pf EXIT
run() { # <log> <expect: ok|fail> <args…> — rot, its output kept; checks the exit code
  local log=$1 want=$2; shift 2; rot "$@" > "$W/$log.log" 2>&1; local rc=$?
  sed 's/^/     | /' "$W/$log.log" | tail -n "${TAIL:-12}"
  if [ "$want" = ok ]; then [ $rc = 0 ] && ok "$log exits 0" || bad "$log exits $rc"; else [ $rc != 0 ] && ok "$log refuses (exit $rc)" || bad "$log did not refuse"; fi
}
has() { grep -q -- "$2" "$W/$1.log" && ok "$1: $3" || bad "$1: $3 (no '$2')"; }
hasnt() { grep -q -- "$2" "$W/$1.log" && bad "$1: $3 ('$2' found)" || ok "$1: $3"; }

# Langfuse's project key pair: the install's own (round 1), read from the cluster when needed.
PK="" SK=""
trace() { # <name> — one trace through Langfuse's public ingestion API (port-forward 13000)
  local id; id=$(python3 -c 'import uuid; print(uuid.uuid4())')
  printf '{"batch":[{"id":"%s","type":"trace-create","timestamp":"%s","body":{"id":"%s","name":"%s"}}]}' \
    "$(python3 -c 'import uuid; print(uuid.uuid4())')" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$id" "$1" \
    | curl -sS -o /dev/null -w '%{http_code}' -u "$PK:$SK" -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:13000/api/public/ingestion
}
ch_traces() { # <name> — rows of that trace name in ClickHouse (inside the pod, its own env)
  k exec deploy/clickhouse -- sh -c 'clickhouse-client -u "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" -d langfuse -q "SELECT count() FROM traces WHERE name = '"'"'$1'"'"'"' _ "$1" 2>/dev/null
}
wait_trace() { local _i; for _i in $(seq 1 60); do [ "$(ch_traces "$1")" -ge 1 ] 2>/dev/null && return 0; sleep 5; done; return 1; }

[ -f "$KUBECONFIG" ] && kubectl config get-contexts "$CTX" >/dev/null 2>&1 || { echo "no $KUBECONFIG with context $CTX: run round2-kind-up.sh first"; exit 2; }

step "0. data before the rotation"
PK=$(sk langfuse-init LANGFUSE_INIT_PROJECT_PUBLIC_KEY); SK=$(sk langfuse-init LANGFUSE_INIT_PROJECT_SECRET_KEY)
pf "$REL-langfuse-web" 13000 3000
c=$(trace before-rotation); [ "$c" = 207 ] || [ "$c" = 200 ] && ok "Langfuse accepts a trace ($c)" || bad "Langfuse ingestion → $c"
wait_trace before-rotation && ok "the trace reached ClickHouse (worker: Valkey queue, MinIO events, ClickHouse)" || bad "the trace did not reach ClickHouse"
stop_pf
printf 'SET rotation:marker kept\n' | k exec -i deploy/valkey -- sh -c 'REDISCLI_AUTH="$VALKEY_PASSWORD" valkey-cli --no-auth-warning' >/dev/null
ok "a Valkey marker key is set"

step "1. negative twins of prepare and plan"
orig=$(sk valkey-credentials password)
printf '{"stringData":{"password":"hand-edited-%s"}}' "$(openssl rand -hex 4)" | k patch secret valkey-credentials --type merge --patch-file /dev/stdin >/dev/null
TAIL=4 run prepare-handedit fail ds-prepare
has prepare-handedit "differs from valkey.local.password" "names the hand-edited Secret"
[ -z "$(ls "$SOVEREIGN_SECRETS_DIR"/overlays 2>/dev/null)" ] && ok "and writes no file" || bad "files were written"
printf '%s' "$orig" | python3 -c 'import json,sys; print(json.dumps({"stringData":{"password":sys.stdin.read()}}))' | k patch secret valkey-credentials --type merge --patch-file /dev/stdin >/dev/null

step "2. ds-prepare and ds-plan"
TAIL=40 run prepare ok ds-prepare
OV=""; for f in "$SOVEREIGN_SECRETS_DIR"/overlays/datastores-*.yaml; do case $f in *.rollback.yaml) ;; *) OV=$f ;; esac; done
[ -f "$OV" ] && ok "overlay written" || { bad "no overlay"; exit 1; }
[ "$(stat -f %Lp "$OV" 2>/dev/null || stat -c %a "$OV")" = 600 ] && ok "overlay mode 600" || bad "overlay mode"
for v in langfuse-local-dev litellm-local-dev clickhouse-local-dev valkey-local-dev agentic-os-local-secret sk-agents-local-dev; do
  grep -q "$v" "$W"/*.log && bad "a value (${v}…) was printed" || true
done
ok "no current value in the output (checked against the published defaults)"
cp "${OV%.yaml}.state.json" "$W/state.bak"
python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); s["cluster"]["uid"]="00000000-other"; json.dump(s,open(sys.argv[1],"w"))' "${OV%.yaml}.state.json"
TAIL=3 run plan-othercluster fail ds-plan --overlay "$OV"
has plan-othercluster "prepared for another cluster" "refuses a state of another cluster"
cp "$W/state.bak" "${OV%.yaml}.state.json"
TAIL=60 run plan ok ds-plan --overlay "$OV" --chart "$CLONE/charts/sovereign-agentic-os"
has plan "(to do)" "lists the Secrets to rotate"
has plan "Deployment $REL-langfuse-web" "discovers Langfuse as a reader"

step "3. valkey"
run rekey-valkey-dry ok ds-rekey valkey --overlay "$OV"
has rekey-valkey-dry "DRY RUN" "without --apply it only shows the steps"
TAIL=12 run rekey-valkey ok ds-rekey valkey --overlay "$OV" --apply
m=$(printf 'GET rotation:marker\n' | k exec -i deploy/valkey -- sh -c 'REDISCLI_AUTH="$VALKEY_PASSWORD" valkey-cli --no-auth-warning')
[ "$m" = kept ] && ok "the marker key is still there (Valkey not restarted) and the OLD password still works" || bad "marker: '$m'"
TAIL=30 run verify-valkey ok ds-verify --overlay "$OV" --component valkey
has verify-valkey "expected until ds-finish" "the old password is still valid by design"

step "4. postgres"
TAIL=20 run rekey-postgres ok ds-rekey postgres --overlay "$OV" --apply
TAIL=30 run verify-postgres ok ds-verify --overlay "$OV" --component postgres
has verify-postgres "postgres role langfuse refuses the old password" "the owner refuses the old password"
has verify-postgres "postgres role litellm refuses the old password" "litellm refuses the old password"
has verify-postgres "not restarted by design" "pg-0 is not restarted (init-only reader)"

step "5. clickhouse, minio"
TAIL=12 run rekey-clickhouse ok ds-rekey clickhouse --overlay "$OV" --apply
TAIL=20 run verify-clickhouse ok ds-verify --overlay "$OV" --component clickhouse
has verify-clickhouse "clickhouse refuses the old password" "ClickHouse refuses the old password"
TAIL=12 run rekey-minio ok ds-rekey minio --overlay "$OV" --apply
TAIL=24 run verify-minio ok ds-verify --overlay "$OV" --component minio
has verify-minio "minio refuses the old secret key (403)" "MinIO refuses the old secret key"
has verify-minio "count\|s3:langfuse" "object counts compared"

step "6. litellm-master (salt key set): an existing virtual key keeps working"
# An extra virtual key, made with the CURRENT master key before the swap (the agent key is one too).
pf "$REL-litellm" 14000 4000
mk_old=$(sk litellm-credentials masterkey)
vk_extra=$(printf 'header = "Authorization: Bearer %s"\n' "$mk_old" | curl -sS -K - -H 'Content-Type: application/json' \
  -d '{"key_alias":"rehearsal-existing","models":["sovereign-mock"]}' http://127.0.0.1:14000/key/generate | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])')
stop_pf
[ -n "$vk_extra" ] && ok "a virtual key exists before the master-key swap (sha256 $(printf %s "$vk_extra" | shasum -a 256 | cut -c1-12)…)" || bad "could not create the extra virtual key"
TAIL=12 run rekey-master ok ds-rekey litellm-master --overlay "$OV" --apply
TAIL=30 run verify-master ok ds-verify --overlay "$OV" --component litellm-master
has verify-master "the old master key is refused (401)" "the old master key → 401"
has verify-master "the master key → /key/list 200" "the new master key → 200"
has verify-master "an existing virtual key (agent-litellm-key" "the agent key (made before the swap) still works"
has verify-master "os-ui → LiteLLM admin with its LITELLM_MASTER_KEY" "os-ui uses the new master key"
has verify-master "os-ui-worker holds no master key" "the worker holds none"
has verify-master "   ok   os-ui: rollout complete" "os-ui restarted after the swap"
pf "$REL-litellm" 14000 4000
c=$(printf 'header = "Authorization: Bearer %s"\n' "$vk_extra" | curl -sS -K - -o /dev/null -w '%{http_code}' http://127.0.0.1:14000/v1/models)
stop_pf
[ "$c" = 200 ] && ok "the extra virtual key made under the old master → 200 after the swap" || bad "the extra virtual key → $c after the swap"

step "7. agent-key: the chart's key-init Job makes the new key, the old one still served"
TAIL=14 run rekey-agent ok ds-rekey agent-key --overlay "$OV" --apply
has rekey-agent "key-init: virtual key created" "the chart's Job created the new key"
has rekey-agent "the key in the Secret is served" "the new key is served before the deploy"

step "8. the deploy (the helm upgrade deploy.sh ends with): release values + the overlay, hooks on"
helm --kube-context "$CTX" get values "$REL" -n "$NS" -o yaml > "$W/release.yaml"
if helm --kube-context "$CTX" upgrade "$REL" "$CHART" -n "$NS" -f "$W/release.yaml" -f "$OV" --force-conflicts --skip-schema-validation --wait --timeout 20m > "$W/upgrade.log" 2>&1
then ok "helm upgrade with the overlay succeeded (post-upgrade reconcile hook with the new owner password)"
else bad "helm upgrade failed"; tail -5 "$W/upgrade.log"; fi
TAIL=60 run verify-all ok ds-verify --overlay "$OV"
has verify-all "DS_VERIFY_OK" "ds-verify passes"
has verify-all "the shared agent key → /v1/models 200" "the new agent key is served"
has verify-all "expected until ds-finish" "old Valkey password / agent key still valid until finish"

step "9. after the rotation: the components work together on the new credentials"
pf "$REL-langfuse-web" 13000 3000
c=$(trace after-rotation); [ "$c" = 207 ] || [ "$c" = 200 ] && ok "Langfuse accepts a new trace ($c)" || bad "Langfuse ingestion → $c"
wait_trace after-rotation && ok "the new trace reached ClickHouse: Postgres, Valkey, MinIO and ClickHouse all on new credentials" || bad "the new trace did not reach ClickHouse"
[ "$(ch_traces before-rotation)" -ge 1 ] && ok "the trace from before the rotation is still there" || bad "the old trace is gone"
stop_pf
pf "$REL-litellm" 14000 4000
newkey=$(sk agent-litellm-key apiKey)
c=$(printf 'header = "Authorization: Bearer %s"\n' "$newkey" | curl -sS -K - -o "$W/chat.json" -w '%{http_code}' -H 'Content-Type: application/json' \
     -d '{"model":"sovereign-mock","messages":[{"role":"user","content":"ping"}],"max_tokens":5}' http://127.0.0.1:14000/v1/chat/completions)
[ "$c" = 200 ] && ok "a chat through LiteLLM with the new agent key → 200 (LiteLLM on its new Postgres + Valkey passwords)" || bad "chat with the new key → $c"
stop_pf

step "10. ds-finish, then every old credential refused"
TAIL=6 run finish ok ds-finish --overlay "$OV" --apply
DS_FINISHED=1 TAIL=60 run verify-finished ok ds-verify --overlay "$OV"
has verify-finished "valkey refuses the old password" "Valkey refuses the old password"
has verify-finished "the old agent key is refused" "the old agent key is refused"
has verify-finished "the old master key is refused (401)" "the old master key is refused"
has verify-finished "DS_VERIFY_OK" "ds-verify passes after finish"

step "11. the release carries the values: a second deploy changes no Secret"
helm --kube-context "$CTX" get values "$REL" -n "$NS" -o yaml > "$W/release2.yaml"
secrets_hash() { k get secret -o json | python3 -c '
import json, sys, hashlib
items = {i["metadata"]["name"]: i.get("data") for i in json.load(sys.stdin)["items"] if i.get("type") != "helm.sh/release.v1"}
print(hashlib.sha256(json.dumps(items, sort_keys=True).encode()).hexdigest())'; }
before=$(secrets_hash)
helm --kube-context "$CTX" upgrade "$REL" "$CHART" -n "$NS" -f "$W/release2.yaml" --force-conflicts --skip-schema-validation --wait --timeout 20m > "$W/upgrade2.log" 2>&1 && ok "a plain upgrade from the release values" || bad "second upgrade failed"
[ "$(secrets_hash)" = "$before" ] && ok "no Secret changed: the release carries the rotated values" || bad "a plain upgrade changed Secrets"
TAIL=8 DS_FINISHED=1 run verify-after-plain ok ds-verify --overlay "$OV"
has verify-after-plain "DS_VERIFY_OK" "still rotated after a plain deploy"

step "12. no credential value in any output"
leaks=$(python3 - "$OV" "${OV%.yaml}.rollback.yaml" "$W/round1.values.yaml" "$W" <<'PY'
import glob, sys, yaml
vals = set()
def walk(n):
    if isinstance(n, dict): [walk(v) for v in n.values()]
    elif isinstance(n, list): [walk(v) for v in n]
    elif isinstance(n, str) and len(n) >= 12: vals.add(n)
CRED = ("password", "localPassword", "secretKey", "accessKey", "value", "apiKey", "token", "publicKey",
        "salt", "nextauthSecret", "encryptionKey", "userPassword", "litellmMasterKey")
def walk_cred(n, key=""):
    if isinstance(n, dict): [walk_cred(v, k) for k, v in n.items()]
    elif isinstance(n, list): [walk_cred(v, key) for v in n]
    elif isinstance(n, str) and key in CRED and len(n) >= 12: vals.add(n)
for f in sys.argv[1:4]: walk_cred(yaml.safe_load(open(f)))
hits = [f for f in glob.glob(sys.argv[4] + "/*.log") if any(v in open(f, errors="replace").read() for v in vals)]
print(" ".join(hits))
PY
)
[ -z "$leaks" ] && ok "no old, new or round-1 value appears in any log of this run" || bad "a value appears in: $leaks"

echo
echo "round 2 rehearsal: $pass passed, $failn failed (logs: $W)"
[ "$failn" = 0 ] && echo ROUND2_REHEARSAL_OK || { echo ROUND2_REHEARSAL_FAILED; exit 1; }
