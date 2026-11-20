#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# rotate-secrets.sh — prepare, plan and verify the rotation of the platform's chart-default
# secrets. docs/ops/secret-rotation.md is the run-book.
# =============================================================================
#   scripts/ops/rotate-secrets.sh prepare  [--path rekey|pin-first|none-stored] [common]
#   scripts/ops/rotate-secrets.sh baseline [--chart <dir>] [common]
#   scripts/ops/rotate-secrets.sh plan     --overlay <file> [--chart <dir>] [common]
#   scripts/ops/rotate-secrets.sh verify   --overlay <file> [--os-ui-exec] [common]
#   scripts/ops/rotate-secrets.sh password [common]
#   scripts/ops/rotate-secrets.sh password-db --overlay <password overlay> [--apply | --rollback] [common]
#   scripts/ops/rotate-secrets.sh verify-password --overlay <password overlay> [common]
#   common: --context <kube context> (dmagenticos) --namespace <ns> (agentic-os) --release <name> (agentic-os)
#
# What rotates: the LiteLLM master key and salt key, the Langfuse project key pair, the Langfuse
# core secrets (salt, nextauthSecret, encryptionKey), agentRuntime.token, the LiteLLM console
# password (litellmUI.password) and, separately, the Langfuse init user's password.
#
# prepare   READ-ONLY. Two read-only `kubectl exec` steps, named before they run:
#             * LiteLLM's own scan of every column it encrypts (litellm/proxy/db/master_key_migration.py
#               `_SECRET_COLUMNS`, 21 on 1.109.1), run in the LiteLLM container
#               (scripts/ops/litellm-stored-secrets.py; SELECT only, counts only);
#             * a row count of every Langfuse table that holds values encrypted with its
#               encryptionKey, run with psql in pg-0 (SELECT count(*) only).
#           The LiteLLM path:
#             salt key already set → only the master key rotates (the salt never changes);
#             rekey (DEFAULT while no salt is set) → LiteLLM's documented complete re-key, two
#               deploys: step 1 sets the master key to a new random S with
#               LITELLM_MIGRATE_FROM_MASTER_KEY=<old>, so LiteLLM re-encrypts every stored value
#               to S at boot; step 2 sets LITELLM_SALT_KEY=S, a new master key M, empties the variable;
#             pin-first (--path) → LITELLM_SALT_KEY = the current master key, one deploy;
#             none-stored (--path) → a random salt in one deploy, REFUSED unless LiteLLM's scan
#               finds no stored value at all.
#           The Langfuse encryptionKey rotates only if no encrypted Langfuse entry exists.
#           Writes the overlays (mode 600) under ~/.sovereign-os-secrets/overlays/ and a state
#           file binding them to this cluster (kube-system UID), namespace, release and the live
#           master key's hash.
# plan      READ-ONLY. Refuses an overlay that does not belong to the live cluster, release and
#           master key. Then renders <chart> with the live values + the overlay
#           (`helm template --dry-run=server`: lookup and the salt-key guard run) and compares it
#           with the live manifest: objects, Secret keys (by hash) and workloads that roll.
# baseline  READ-ONLY. The same render as plan without an overlay: the chart checkout you deploy from
#           must change 0 objects against the live release before any overlay is applied.
# verify    Post-checks for a step (same cluster check). Old keys → 401, new → 200; LiteLLM's
#           scan finds every stored value decryptable with the new key and none left under an old
#           one; stored models served; the shared virtual key; the console password; the Langfuse
#           pair; every reader restarted after the deploy; --os-ui-exec: os-ui's own credential.
# password  A new Langfuse init-user password into a separate overlay + its rollback (mode 600).
# password-db  The one DATABASE WRITE (owner approval: --apply): bcrypt cost 12 made by
#           langfuse-web's own bcryptjs (password on stdin), the current hash saved (mode 600),
#           then ONE `UPDATE users SET password` row in the langfuse database via `kubectl exec
#           pg-0 -- psql`. Without --apply it only shows what it would do. --rollback restores
#           the saved hash.
# verify-password  Langfuse sign-in through NextAuth: the new password works, the previous one not.
#
# No value is printed, logged or put on a command line: values travel in shell variables, reach
# curl / psql / node / python on stdin. Output shows names, counts and sha256 prefixes.
set -euo pipefail
umask 077

CTX=dmagenticos NS=agentic-os REL=agentic-os
OVERLAY="" CHART="" OS_UI_EXEC="" FORCE_PATH="" APPLY="" ROLLBACK=""
CMD=${1:-}; [ $# -gt 0 ] && shift
while [ $# -gt 0 ]; do
  case $1 in
    --context) CTX=$2; shift ;;
    --namespace) NS=$2; shift ;;
    --release) REL=$2; shift ;;
    --overlay) OVERLAY=$2; shift ;;
    --chart) CHART=$2; shift ;;
    --path) FORCE_PATH=$2; shift ;;
    --os-ui-exec) OS_UI_EXEC=1 ;;
    --apply) APPLY=1 ;;
    --rollback) ROLLBACK=1 ;;
    -h|--help) sed -n '2,62p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
SECRETS_DIR=${SOVEREIGN_SECRETS_DIR:-$HOME/.sovereign-os-secrets}/overlays
LITELLM_SVC=${LITELLM_SVC:-$REL-litellm}
LANGFUSE_SVC=${LANGFUSE_SVC:-$REL-langfuse-web}
PG_POD=${PG_POD:-pg-0}
# The Dagster code server reads agent-runtime-token (AGENT_RUNTIME_TOKEN, code server and repo-sync sidecar).
DAGSTER_CODE=${DAGSTER_CODE:-$REL-dagster-user-deployments-sovereign}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
FILES="python3 $REPO/scripts/lib/rotation-files.py"
MIGRATE=LITELLM_MIGRATE_FROM_MASTER_KEY
# Every Langfuse 3.194.1 table with values encrypted by ENCRYPTION_KEY (packages/shared/src/encryption,
# callers in web/src and packages/shared): LLM connections, integrations, automations, SSO, callouts.
LANGFUSE_ENCRYPTED_TABLES="llm_api_keys blob_storage_integrations posthog_integrations mixpanel_integrations actions sso_configs slack_integrations web_callout_endpoints"

say() { printf '==> %s\n' "$*"; }
die() { printf 'ROTATE_FAILED — %s\n' "$*" >&2; exit 1; }
k() { kubectl --context "$CTX" -n "$NS" "$@"; }
h16() { printf '%s' "$1" | shasum -a 256 | cut -c1-16; }
rand_hex() { openssl rand -hex "$1"; }
# secret_key <secret> <key> — the decoded value, for a shell variable only (empty when absent).
secret_key() {
  k get secret "$1" -o "go-template={{ with index .data \"$2\" }}{{ . }}{{ end }}" 2>/dev/null | base64 -d 2>/dev/null || true
}
cluster_uid() { kubectl --context "$CTX" get ns kube-system -o jsonpath='{.metadata.uid}'; }
# The os-ui version that is live: the image tag, without a digest (…/os-ui:0.9.23@sha256:… → 0.9.23).
live_version() { k get deploy os-ui -o jsonpath='{.spec.template.spec.containers[0].image}' | sed -E 's/@.*$//; s/.*:([^:]+)$/\1/'; }

PF_PID="" PF_PORT=""
port_forward() {
  local log; log=$(mktemp)
  k port-forward "svc/$1" ":$2" >"$log" 2>&1 &
  PF_PID=$!
  for _ in $(seq 1 50); do
    PF_PORT=$(sed -nE 's/^Forwarding from 127\.0\.0\.1:([0-9]+).*/\1/p' "$log" | head -n1)
    [ -n "$PF_PORT" ] && { rm -f "$log"; return 0; }
    kill -0 "$PF_PID" 2>/dev/null || break
    sleep 0.2
  done
  cat "$log" >&2; rm -f "$log"; die "port-forward to svc/$1 did not start"
}
stop_forward() { if [ -n "$PF_PID" ]; then kill "$PF_PID" 2>/dev/null || true; wait "$PF_PID" 2>/dev/null || true; fi; PF_PID=""; }
trap stop_forward EXIT

# call <bearer> <method> <path> [json body] — prints "<http code>\n<body>"; the bearer goes in on stdin.
call() {
  local body=${4:-}
  { printf 'header = "Authorization: Bearer %s"\n' "$1"
    if [ -n "$body" ]; then printf 'header = "Content-Type: application/json"\ndata = "%s"\n' "${body//\"/\\\"}"; fi
  } | { curl -sS -K - -X "$2" -w '\n%{http_code}' --max-time 60 "http://127.0.0.1:$PF_PORT$3" || true; } | { b=$(cat); printf '%s\n%s' "${b##*$'\n'}" "${b%$'\n'*}"; }
}
code_of() { head -n1 <<<"$1"; }
body_of() { tail -n +2 <<<"$1"; }
chat_body() { printf '{"model":"%s","messages":[{"role":"user","content":"ping"}],"max_tokens":5}' "$1"; }
basic() { printf 'user = "%s:%s"\n' "$1" "$2" | curl -sS -K - -o /dev/null -w '%{http_code}' --max-time 30 "http://127.0.0.1:$PF_PORT$3" || true; }
# pairs k1 v1 k2 v2 … | pairs_json — a JSON object, with the values never on a command line
# (printf is a builtin; python reads the NUL-separated pairs from stdin).
pairs() { printf '%s\0' "$@"; }
pairs_json() { python3 -c 'import json,sys; p=sys.stdin.buffer.read().split(b"\0")[:-1]; print(json.dumps({p[i].decode(): p[i+1].decode() for i in range(0, len(p), 2)}))'; }
# login_code <path> <username> <password> — http code of a JSON login POST; the body goes in on stdin.
login_code() { pairs username "$2" password "$3" | pairs_json | curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:$PF_PORT$1" || true; }

# litellm_scan [<json params>] — LiteLLM's own count of stored encrypted values (read-only exec).
# params: {"keys": {"label": "<key>"}}, sent on stdin with the probe; output: counts JSON.
litellm_scan() {
  local params=${1:-'{}'}
  { printf '%s\n' "$params"; cat "$REPO/scripts/ops/litellm-stored-secrets.py"; } \
    | k exec -i "deploy/$LITELLM_SVC" -c litellm -- python -c '
import sys, json, asyncio
params = sys.stdin.readline(); code = sys.stdin.read()
ns = {"__name__": "litellm_stored_secrets"}; exec(code, ns)
asyncio.run(ns["main"](json.loads(params or "{}")))' 2>/dev/null | tail -n1
}
# psql_db <db> — SQL on stdin (variables as \\set lines in it), in the Postgres pod as its owner.
psql_db() { k exec -i "$PG_POD" -- sh -c "psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d $1 -tA -q"; }
langfuse_encrypted_counts() { # "<table>|<rows>" per table; -1 when the table does not exist
  local t
  { echo "BEGIN TRANSACTION READ ONLY;"
  for t in $LANGFUSE_ENCRYPTED_TABLES; do
    printf "SELECT '%s', CASE WHEN to_regclass('public.%s') IS NULL THEN -1 ELSE (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.%s', false, true, '')))[1]::text::int END;\n" "$t" "$t" "$t"
  done
  echo "COMMIT;"; } | psql_db langfuse
}

# check_binding <state> — the overlay must belong to this cluster, namespace and release.
check_binding() {
  local state=$1 want got
  want=$(python3 -c 'import json,sys; c=json.load(open(sys.argv[1]))["cluster"]; print(c["uid"], c["namespace"], c["release"])' "$state")
  got="$(cluster_uid) $NS $REL"
  [ "$want" = "$got" ] || die "this overlay was prepared for another cluster/namespace/release (state: uid ${want%% *}…, live: uid ${got%% *}…, --namespace $NS --release $REL). Run prepare against this cluster."
  echo "   ok   overlay belongs to this cluster (kube-system uid), namespace $NS and release $REL"
}
state_hash() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256_16"][sys.argv[2]])' "$1" "$2"; }
state_path() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["path"])' "$1"; }

# ----------------------------------------------------------------------------------------------
prepare() {
  command -v openssl >/dev/null || die "openssl not found"
  mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR" "$(dirname "$SECRETS_DIR")"
  # A random suffix: two runs in the same second must not collide (the files are created exclusively).
  local stamp uid ver; stamp=$(date +%Y%m%d-%H%M%S)-$(rand_hex 3); uid=$(cluster_uid); ver=$(live_version)
  say "context $CTX (kube-system uid ${uid:0:8}…) / namespace $NS / release $REL / os-ui $ver"

  local old_master old_salt
  old_master=$(secret_key litellm-credentials masterkey)
  [ -n "$old_master" ] || die "litellm-credentials has no masterkey"
  old_salt=$(secret_key litellm-credentials LITELLM_SALT_KEY)
  echo "   master key sha256 $(h16 "$old_master")…; salt key in the Secret: $([ -n "$old_salt" ] && echo "yes, sha256 $(h16 "$old_salt")…" || echo no)"

  say "read-only exec 1/2: LiteLLM's own scan of every column it encrypts (in the LiteLLM container)"
  local scan; scan=$(litellm_scan)
  [ -n "$scan" ] || die "the LiteLLM scan returned nothing (exec into deploy/$LITELLM_SVC failed?)"
  python3 - "$scan" <<'PY'
import json, sys
d = json.loads(sys.argv[1])
cols = d["columns"]
print(f"   {len(cols)} encrypted columns scanned; values decryptable with the key in use: {d['total']['effective']}")
for name, c in sorted(cols.items()):
    if c["rows"] or c["effective"]:
        print(f"     {name}: {c['rows']} row(s), {c['effective']} value(s)")
PY
  local stored; stored=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["total"]["effective"])' "$scan")

  # Names of the database-stored models, for the functional post-check (served after the rotation).
  port_forward "$LITELLM_SVC" 4000
  local r db_names="[]"
  r=$(call "$old_master" GET /model/info)
  [ "$(code_of "$r")" = 200 ] && db_names=$(body_of "$r" | python3 -c 'import json,sys; d=json.load(sys.stdin).get("data",[]); print(json.dumps(sorted({m.get("model_name") for m in d if (m.get("model_info") or {}).get("db_model")})))')
  stop_forward

  say "read-only exec 2/2: Langfuse tables encrypted with its encryptionKey (psql in $PG_POD, count only)"
  local lfenc lfenc_total
  lfenc=$(langfuse_encrypted_counts) || die "could not count the Langfuse encrypted tables"
  lfenc_total=$(awk -F'|' '$2>0{s+=$2} END{print s+0}' <<<"$lfenc")
  awk -F'|' '{printf "     %s: %s\n", $1, ($2<0?"(no table)":$2" row(s)")}' <<<"$lfenc"

  local path
  if [ -n "$old_salt" ]; then
    path=salt-already-set
    [ -z "$FORCE_PATH" ] || die "a salt key is already set; --path does not apply (it must never change)"
  else
    path=${FORCE_PATH:-rekey}
  fi
  case $path in
    rekey) echo "   PATH: re-key (2 deploys) — LiteLLM re-encrypts all $stored stored value(s) to a new random salt key" ;;
    pin-first) echo "   PATH: pin first — the salt key becomes the CURRENT master key (stored values stay readable; the old key stays their key)" ;;
    none-stored)
      [ "$stored" = 0 ] || die "--path none-stored refused: LiteLLM's scan finds $stored stored value(s); a new salt would make them undecryptable. Use the default re-key path."
      echo "   PATH: none stored (LiteLLM's scan: 0 values) — a new random salt key with the new master key" ;;
    salt-already-set) echo "   PATH: salt already set — kept unchanged; only the master key rotates" ;;
    *) die "unknown --path $path" ;;
  esac

  local rotate_enc=""
  if [ "$lfenc_total" = 0 ]; then rotate_enc=1; echo "   Langfuse encryptionKey: no encrypted entry exists → rotated"
  else echo "   Langfuse encryptionKey: $lfenc_total encrypted entr(ies) exist → NOT rotated (docs/ops/secret-rotation.md, 'Langfuse encryptionKey')"; fi

  local new_salt
  case $path in
    rekey|none-stored) new_salt="sk-salt-$(rand_hex 32)" ;;
    pin-first) new_salt=$old_master ;;
    salt-already-set) new_salt=$old_salt ;;
  esac
  # All values go to the helper on stdin (NUL-separated pairs; old, a separator, new).
  local meta out
  meta=$(pairs path "$path" uid "$uid" context "$CTX" namespace "$NS" release "$REL" version "$ver" \
           scan "$scan" db_names "$db_names" lfenc "$lfenc" rotate_enc "$rotate_enc" | pairs_json)
  out=$( { pairs master "$old_master" pk "$(secret_key langfuse-init LANGFUSE_INIT_PROJECT_PUBLIC_KEY)" sk "$(secret_key langfuse-init LANGFUSE_INIT_PROJECT_SECRET_KEY)" \
             lf_salt "$(secret_key langfuse-core-secrets salt)" lf_nextauthSecret "$(secret_key langfuse-core-secrets nextauthSecret)" \
             lf_encryptionKey "$(secret_key langfuse-core-secrets encryptionKey)" agent_token "$(secret_key agent-runtime-token token)" \
             ui_password "$(secret_key litellm-credentials UI_PASSWORD)"
           printf -- '--NEW--\0'
           pairs master "sk-$(rand_hex 32)" salt "$new_salt" pk "pk-lf-$(rand_hex 16)" sk "sk-lf-$(rand_hex 32)" \
             lf_salt "$(rand_hex 32)" lf_nextauthSecret "$(openssl rand -base64 48 | tr -d '\n')" lf_encryptionKey "$(rand_hex 32)" \
             agent_token "$(rand_hex 32)" ui_password "$(openssl rand -base64 30 | tr -d '/+=\n' | cut -c1-32)"
         } | python3 -c '
import json, sys
meta = json.loads(sys.argv[1])
raw = sys.stdin.buffer.read().split(b"\0")[:-1]
i = raw.index(b"--NEW--")
def m(p): return {p[j].decode(): p[j + 1].decode() for j in range(0, len(p), 2)}
old, new = m(raw[:i]), m(raw[i + 1:])
if not meta["rotate_enc"]:
    new.pop("lf_encryptionKey", None); old.pop("lf_encryptionKey", None)
enc = {l.split("|")[0]: int(l.split("|")[1]) for l in meta["lfenc"].splitlines() if "|" in l}
print(json.dumps({"path": meta["path"], "cluster": {k: meta[k] for k in ("uid", "context", "namespace", "release", "version")},
                  "counts": json.loads(meta["scan"]), "db_models": json.loads(meta["db_names"]), "langfuse_encrypted": enc,
                  "old": old, "new": new}))' "$meta" | $FILES write "$SECRETS_DIR" "$stamp")
  echo "$out" | sed 's/^/   wrote /'
  local final step1 back back1
  final=$(awk -F'\t' '$1=="final"{print $2}' <<<"$out"); step1=$(awk -F'\t' '$1=="step1"{print $2}' <<<"$out")
  back=$(awk -F'\t' '$1=="rollback"{print $2}' <<<"$out"); back1=$(awk -F'\t' '$1=="rollback-step1"{print $2}' <<<"$out")

  local o="--context $CTX --namespace $NS --release $REL" ck=charts/sovereign-agentic-os
  echo
  echo "NEXT (docs/ops/secret-rotation.md; deploy from the checkout of os-ui-v$ver + the rotation chart support):"
  if [ -n "$step1" ]; then
    cat <<EOF
  STEP 1 (re-key):
    scripts/ops/rotate-secrets.sh plan --overlay $step1 --chart $ck $o
    VALUES_OVERLAY=$step1 ./scripts/deploy.sh --from-registry $ver        # rolls LiteLLM (new env) by itself
    scripts/ops/rotate-secrets.sh verify --overlay $step1 $o               # every stored value re-encrypted
    (rollback of step 1: VALUES_OVERLAY=$back1 ./scripts/deploy.sh --from-registry $ver)
  STEP 2 (final):
EOF
  else echo "  FINAL:"; fi
  cat <<EOF
    scripts/ops/rotate-secrets.sh plan --overlay $final --chart $ck $o
    VALUES_OVERLAY=$final ./scripts/deploy.sh --from-registry $ver
    kubectl --context $CTX -n $NS rollout restart deploy/$LANGFUSE_SVC deploy/$REL-langfuse-worker deploy/$LITELLM_SVC
    kubectl --context $CTX -n $NS rollout status deploy/$LANGFUSE_SVC deploy/$REL-langfuse-worker deploy/$LITELLM_SVC --timeout=10m
    kubectl --context $CTX -n $NS rollout restart deploy/os-ui deploy/os-ui-worker deploy/$DAGSTER_CODE
    kubectl --context $CTX -n $NS rollout status deploy/os-ui deploy/os-ui-worker deploy/$DAGSTER_CODE --timeout=15m
    scripts/ops/rotate-secrets.sh verify --overlay $final $o --os-ui-exec
  Owner, Langfuse UI: delete the OLD project key pair (public key sha256 $(h16 "$(secret_key langfuse-init LANGFUSE_INIT_PROJECT_PUBLIC_KEY)")…), then verify again.
  Rollback of the final step: VALUES_OVERLAY=$back ./scripts/deploy.sh --from-registry $ver, then the restarts.
EOF
}

# ----------------------------------------------------------------------------------------------
# The live master key an overlay expects to find before it is applied.
expected_before() {
  local state=$1 kind=$2 path; path=$(state_path "$state")
  case $kind in
    step1) state_hash "$state" old_master ;;
    final) if [ "$path" = rekey ]; then state_hash "$state" step1_master; else state_hash "$state" old_master; fi ;;
    rollback) state_hash "$state" new_master ;;
    rollback-step1) state_hash "$state" step1_master ;;
  esac
}

plan() {
  [ -f "$OVERLAY" ] || die "--overlay <file> is required"
  CHART=${CHART:-$REPO/charts/sovereign-agentic-os}
  local kind state live want; kind=$($FILES kind "$OVERLAY"); state=$($FILES state "$OVERLAY")
  [ -f "$state" ] || die "no state file next to $OVERLAY ($state): only overlays written by prepare are accepted"
  say "the overlay belongs here ($kind of a $(state_path "$state") rotation)"
  check_binding "$state"
  live=$(h16 "$(secret_key litellm-credentials masterkey)"); want=$(expected_before "$state" "$kind")
  [ "$live" = "$want" ] || die "the live master key (sha256 ${live}…) is not the one this $kind overlay expects before it is applied (${want}…): wrong step, already applied, or prepared against other values"
  echo "   ok   live master key is the one this step expects (sha256 ${live}…)"
  if [ "$(state_path "$state")" = pin-first ] && [ "$kind" = final ]; then
    [ "$(h16 "$($FILES get "$OVERLAY" litellmSaltKey.value)")" = "$(state_hash "$state" old_master)" ] || die "pin-first overlay: the salt key is not the live master key"
  fi
  # The LiteLLM migrations Job carries the gateway env (subchart): a Job's pod template is immutable,
  # so the upgrade must create it afresh. It deletes itself 120 s after finishing (ttlSecondsAfterFinished).
  if k get job "$LITELLM_SVC-migrations" >/dev/null 2>&1; then
    die "Job $LITELLM_SVC-migrations still exists: this overlay changes its env, and a Job's pod template is immutable. Wait for its TTL (120 s after it finished), then plan again."
  fi
  echo "   ok   no $LITELLM_SVC-migrations Job left from a previous deploy"
  render_diff "$OVERLAY"
}

# render_diff [<overlay>] — the base guard, then the chart rendered with the live values (+ the
# overlay) compared with the live manifest. Read-only.
render_diff() {
  # The chart must be the live release or newer on its line: refuse a base older than the live tag.
  local live_tag base_dir; live_tag="os-ui-v$(live_version)"; base_dir=$(cd "$CHART" && git rev-parse --show-toplevel 2>/dev/null) || die "the chart at $CHART is not in a git checkout; cannot check its base"
  git -C "$base_dir" rev-parse -q --verify "refs/tags/$live_tag" >/dev/null || die "the chart's checkout does not know the live tag $live_tag (git fetch --tags)"
  git -C "$base_dir" merge-base --is-ancestor "$live_tag" HEAD || die "the chart's checkout is not based on the live release $live_tag: deploying it would roll production back. Base the rotation branch on $live_tag."
  echo "   ok   the chart's checkout contains the live release $live_tag"
  PLAN_DIR=$(mktemp -d); local w=$PLAN_DIR; trap 'stop_forward; rm -rf "$PLAN_DIR"' EXIT
  say "live release values and manifest (read-only)"
  helm --kube-context "$CTX" get values "$REL" -n "$NS" -o yaml > "$w/live.yaml"
  helm --kube-context "$CTX" get manifest "$REL" -n "$NS" > "$w/before.yaml"
  say "render $CHART with the live values + the overlay (--dry-run=server: lookup and the salt guard run)"
  helm template "$REL" "$CHART" -n "$NS" --kube-context "$CTX" --dry-run=server --skip-schema-validation \
    -f "$w/live.yaml" ${1:+-f "$1"} > "$w/after.yaml" 2> "$w/err" || { grep -v '^level=INFO' "$w/err" >&2; die "render failed"; }
  python3 "$REPO/scripts/lib/manifest-diff.py" "$w/before.yaml" "$w/after.yaml"
}

baseline() {
  CHART=${CHART:-$REPO/charts/sovereign-agentic-os}
  say "the chart alone (no overlay) against the live release: it must change 0 objects"
  render_diff
}

# ----------------------------------------------------------------------------------------------
verify() {
  [ -f "$OVERLAY" ] || die "--overlay <file> is required"
  local kind state path; kind=$($FILES kind "$OVERLAY"); state=$($FILES state "$OVERLAY")
  [ -f "$state" ] || die "no state file next to $OVERLAY"
  path=$(state_path "$state")
  local fails=0 r c
  pass() { echo "   ok   $1"; }
  fail() { echo "   FAIL $1"; fails=$((fails+1)); }
  ov() { $FILES get "$OVERLAY" "$1"; }
  bak() { $FILES get "${OVERLAY%.yaml}.rollback.yaml" "$1" 2>/dev/null || true; }
  base=${OVERLAY%.yaml}; base=${base%.step1}; base=${base%.rollback-step1}; base=${base%.rollback}
  local old_master="" s_key=""
  old_master=$($FILES get "$base.rollback.yaml" litellmMasterKey)
  [ "$path" = rekey ] && s_key=$($FILES get "$base.yaml" litellmSaltKey.value)

  say "the overlay belongs here ($kind of a $path rotation)"
  check_binding "$state"
  local new_master; new_master=$(ov litellmMasterKey)
  [ "$(h16 "$(secret_key litellm-credentials masterkey)")" = "$(h16 "$new_master")" ] && pass "litellm-credentials masterkey = this step's" || fail "litellm-credentials masterkey is not this step's value"
  local want_salt; want_salt=$(ov litellmSaltKey.value)
  if [ "$kind" = step1 ] || [ "$kind" = rollback-step1 ]; then
    [ -z "$(secret_key litellm-credentials LITELLM_SALT_KEY)" ] && pass "no LITELLM_SALT_KEY yet (the migration only runs without one)" || fail "LITELLM_SALT_KEY is set: LiteLLM will not migrate"
    # Captured first, then matched: `grep -q` on a pipe can SIGPIPE the writer, which pipefail reports as a failure.
    local envnames gwlog
    envnames=$(k get deploy "$LITELLM_SVC" -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}{"\n"}{end}')
    if grep -qx "$MIGRATE" <<<"$envnames"; then pass "$MIGRATE is set on the gateway"; else fail "$MIGRATE is not set on the gateway"; fi
    gwlog=$(k logs "deploy/$LITELLM_SVC" -c litellm --since=2h 2>/dev/null || true)
    if grep -qE "Done re-encrypting [0-9]+ stored value|nothing in the database is left to migrate" <<<"$gwlog"; then
      pass "LiteLLM logged the re-encryption outcome: $(grep -oE 'Done re-encrypting [0-9]+ stored value\(s\)|nothing in the database is left to migrate' <<<"$gwlog" | tail -1)"
    else fail "no re-encryption outcome in the LiteLLM log yet"; fi
  else
    [ "$(h16 "$(secret_key litellm-credentials LITELLM_SALT_KEY)")" = "$(h16 "$want_salt")" ] && pass "LITELLM_SALT_KEY = this step's" || fail "LITELLM_SALT_KEY is not this step's value"
    local mv; mv=$(k get deploy "$LITELLM_SVC" -o go-template='{{range (index .spec.template.spec.containers 0).env}}{{if eq .name "'"$MIGRATE"'"}}[{{.value}}]{{end}}{{end}}')
    case $mv in ""|"[]") pass "$MIGRATE is absent or empty on the gateway (the old key is gone from its env)" ;; *) fail "$MIGRATE still holds a value on the gateway" ;; esac
  fi

  say "LiteLLM's own scan: every stored value decryptable with the key now in use, none left under an old key"
  local params scan
  params=$( { if [ -n "$old_master" ]; then pairs old "$old_master"; fi; if [ -n "$s_key" ]; then pairs s "$s_key"; fi; } | pairs_json | python3 -c 'import json,sys; print(json.dumps({"keys": json.load(sys.stdin)}))')
  scan=$(litellm_scan "$params")
  [ -n "$scan" ] || fail "the LiteLLM scan returned nothing"
  if [ -n "$scan" ]; then
    python3 - "$scan" "$state" "$kind" "$path" <<'PY' || fails=$((fails+1))
import json, sys
now = json.loads(sys.argv[1]); state = json.load(open(sys.argv[2])); kind, path = sys.argv[3], sys.argv[4]
before = state["counts_before"]["columns"]
bad = 0
for name, b in sorted(before.items()):
    n = now["columns"].get(name, {"effective": 0})
    want = b["effective"]
    if b["effective"] or n.get("effective"):
        ok = n["effective"] == want
        bad += not ok
        print(f"   {'ok  ' if ok else 'FAIL'} {name}: {n['effective']}/{want} decryptable with the key in use")
# Under the retired master key, nothing may remain — except on pin-first, where it IS the salt.
key_retired = path in ("rekey", "none-stored", "salt-already-set") and kind in ("step1", "final")
if key_retired and "old" in now["total"]:
    ok = now["total"]["old"] == 0
    bad += not ok
    print(f"   {'ok  ' if ok else 'FAIL'} values still decryptable with the old master key: {now['total']['old']}")
print(f"   total: {now['total']['effective']} decryptable now, {state['counts_before']['total']['effective']} before")
sys.exit(1 if bad else 0)
PY
  fi

  say "LiteLLM (port-forward)"
  port_forward "$LITELLM_SVC" 4000
  if [ "$kind" != rollback ] && [ "$kind" != rollback-step1 ]; then
    c=$(code_of "$(call "$old_master" GET /model/info)"); [ "$c" = 401 ] && pass "old master key → 401" || fail "old master key → $c (want 401)"
    if [ -n "$s_key" ] && [ "$kind" = final ]; then
      c=$(code_of "$(call "$s_key" GET /model/info)"); [ "$c" = 401 ] && pass "step-1 master key (now the salt) → 401" || fail "step-1 master key → $c (want 401)"
    fi
  fi
  r=$(call "$new_master" GET /model/info); c=$(code_of "$r"); [ "$c" = 200 ] && pass "this step's master key → 200" || fail "this step's master key → $c"
  local m
  for m in $(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["db_models"]))' "$state"); do
    r=$(call "$new_master" POST /v1/chat/completions "$(chat_body "$m")"); c=$(code_of "$r")
    [ "$c" = 200 ] && pass "stored model $m served → 200" || fail "stored model $m → $c"
  done
  local agent; agent=$(secret_key "${AGENT_KEY_SECRET:-agent-litellm-key}" apiKey)
  if [ -n "$agent" ]; then
    r=$(call "$agent" GET /v1/models); c=$(code_of "$r"); [ "$c" = 200 ] && pass "shared virtual key lists models → 200" || fail "shared virtual key /v1/models → $c"
    local model; model=${VERIFY_MODEL:-$(body_of "$r" | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["data"][0]["id"])
except Exception: print("")')}
    if [ -n "${VERIFY_EMBED_MODEL:-}" ]; then model=$VERIFY_EMBED_MODEL; r=$(call "$agent" POST /v1/embeddings "{\"model\":\"$model\",\"input\":\"ping\"}")
    else r=$(call "$agent" POST /v1/chat/completions "$(chat_body "$model")"); fi
    c=$(code_of "$r"); [ "$c" = 200 ] && pass "shared virtual key calls $model → 200" || fail "shared virtual key call $model → $c"
  fi
  local ui_user ui_new ui_old
  ui_user=$(secret_key litellm-credentials UI_USERNAME); ui_new=$(ov litellmUI.password); ui_old=$(bak litellmUI.password)
  if [ -n "$ui_new" ] && [ -n "$ui_user" ]; then
    c=$(login_code /v2/login "$ui_user" "$ui_new")
    [ "$c" = 200 ] && pass "console login with the new password → 200" || fail "console login with the new password → $c"
    if [ -n "$ui_old" ] && [ "$kind" = final ]; then
      c=$(login_code /v2/login "$ui_user" "$ui_old")
      [ "$c" = 401 ] && pass "console login with the old password → 401" || fail "console login with the old password → $c (want 401)"
    fi
  fi
  stop_forward

  if [ -n "$OS_UI_EXEC" ]; then
    say "os-ui's own credential (exec: the two reads /api/gateway makes, with the key os-ui holds)"
    r=$(k exec deploy/os-ui -c os-ui -- node -e '
const u = process.env.LITELLM_URL, h = { Authorization: "Bearer " + process.env.LITELLM_MASTER_KEY };
Promise.all(["/v1/models", "/v1/mcp/tools"].map(p => fetch(u + p, { headers: h }).then(r => p + "=" + r.status, e => p + "=ERR")))
  .then(x => console.log(x.join(" ")));' 2>&1 || true)
    case $r in *"/v1/models=200"*) pass "os-ui → LiteLLM with its LITELLM_MASTER_KEY: $r" ;; *) fail "os-ui → LiteLLM: $r" ;; esac
  fi

  if [ "$kind" = final ] || [ "$kind" = rollback ]; then
    say "in-place secrets (sha256 prefixes) and their readers"
    local pair
    for pair in "agent-runtime-token token agentRuntime.token" "langfuse-core-secrets salt langfuseInit.salt" \
                "langfuse-core-secrets nextauthSecret langfuseInit.nextauthSecret" "langfuse-core-secrets encryptionKey langfuseInit.encryptionKey" \
                "langfuse-init LANGFUSE_INIT_PROJECT_SECRET_KEY langfuseInit.secretKey" "litellm-credentials UI_PASSWORD litellmUI.password"; do
      set -- $pair
      local want; want=$(ov "$3"); [ -n "$want" ] || continue
      [ "$(h16 "$(secret_key "$1" "$2")")" = "$(h16 "$want")" ] && pass "$1/$2 = new" || fail "$1/$2 is not the overlay value"
    done
    # Each reader must serve ONLY from pods started after the deploy: rollout complete, no pod of an
    # earlier ReplicaSet left, every current pod Ready (scripts/lib/readers-restarted.py). A missing
    # Deployment fails; only replicas == 0 is a skip. A one-off Job pod with the same labels is no reader.
    local deployed d sel rw
    deployed=$(helm --kube-context "$CTX" status "$REL" -n "$NS" -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["info"]["last_deployed"])')
    rw=$(mktemp -d)
    for d in "$LANGFUSE_SVC" "$REL-langfuse-worker" "$LITELLM_SVC" os-ui os-ui-worker "$DAGSTER_CODE"; do
      [ -n "$d" ] || continue      # DAGSTER_CODE= (empty) leaves the Dagster reader out on an install without Dagster
      : > "$rw/rs.json"; : > "$rw/pods.json"
      if k get deploy "$d" -o json > "$rw/dep.json" 2>/dev/null; then
        sel=$(python3 -c 'import json,sys; print(",".join(f"{k}={v}" for k, v in json.load(open(sys.argv[1]))["spec"]["selector"]["matchLabels"].items()))' "$rw/dep.json")
        k get rs -l "$sel" -o json > "$rw/rs.json"; k get pods -l "$sel" -o json > "$rw/pods.json"
      else
        : > "$rw/dep.json"          # missing: the helper FAILS it (a misnamed reader must not pass)
      fi
      local line rc=0; line=$(python3 "$REPO/scripts/lib/readers-restarted.py" "$rw/dep.json" "$rw/rs.json" "$rw/pods.json" "$deployed") || rc=$?
      case $rc in 0) pass "$line" ;; 2) echo "   skip $line" ;; *) fail "$d: $line" ;; esac
    done
    rm -rf "$rw"

    say "Langfuse (port-forward)"
    port_forward "$LANGFUSE_SVC" 3000
    local new_pk new_sk old_pk old_sk
    new_pk=$(ov langfuseInit.publicKey); new_sk=$(ov langfuseInit.secretKey); old_pk=$(bak langfuseInit.publicKey); old_sk=$(bak langfuseInit.secretKey)
    if [ -n "$new_pk" ]; then
      c=$(basic "$new_pk" "$new_sk" /api/public/projects); [ "$c" = 200 ] && pass "new Langfuse key pair → 200" || fail "new Langfuse key pair → $c (did langfuse-web restart after the deploy?)"
    fi
    if [ -n "$old_pk" ] && [ "$kind" = final ]; then
      c=$(basic "$old_pk" "$old_sk" /api/public/projects)
      case $c in 401) pass "old Langfuse key pair → 401 (deleted in the UI)" ;; 200) echo "   todo old Langfuse key pair still → 200: the owner deletes it in the Langfuse UI, then verify again" ;; *) fail "old Langfuse key pair → $c" ;; esac
    fi
    stop_forward
  fi

  echo
  [ "$fails" -eq 0 ] && echo "ROTATION_VERIFY_OK ($kind)" || { echo "ROTATION_VERIFY_FAILED ($fails, $kind)"; exit 1; }
}

# ----------------------------------------------------------------------------------------------
password() {
  command -v openssl >/dev/null || die "openssl not found"
  mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR"
  local stamp f; stamp=$(date +%Y%m%d-%H%M%S)-$(rand_hex 3); f="$SECRETS_DIR/langfuse-password-$stamp.yaml"
  local pw; pw=$(openssl rand -base64 30 | tr -d '/+=\n' | cut -c1-32)
  pairs new "$pw" old "$(secret_key langfuse-init LANGFUSE_INIT_USER_PASSWORD)" uid "$(cluster_uid)" ns "$NS" rel "$REL" | pairs_json | python3 -c '
import json, os, sys, yaml
f = sys.argv[1]; d = json.load(sys.stdin)
def w(path, tree, title, as_json=False):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as out:
        if as_json: json.dump(tree, out); return
        out.write(f"# {title} — PRIVATE, never commit. Run-book: docs/ops/secret-rotation.md\n")
        yaml.safe_dump(tree, out)
w(f, {"langfuseInit": {"userPassword": d["new"]}}, "Langfuse init-user password")
w(f[:-5] + ".rollback.yaml", {"langfuseInit": {"userPassword": d["old"]}}, "previous Langfuse init-user password")
w(f[:-5] + ".state.json", {"path": "langfuse-password", "cluster": {"uid": d["uid"], "namespace": d["ns"], "release": d["rel"]}}, "", True)' "$f"
  echo "   wrote $f (password sha256 $(h16 "$pw")…), its rollback and state"
  echo "   next: scripts/ops/rotate-secrets.sh password-db --overlay $f --context $CTX   (shows the DB step; --apply runs it)"
}

password_db() {
  [ -f "$OVERLAY" ] || die "--overlay <password overlay> is required"
  local state="${OVERLAY%.yaml}.state.json" hashf="${OVERLAY%.yaml}.old-hash"
  [ -f "$state" ] || die "no state file next to $OVERLAY"
  check_binding "$state"
  local email pw newhash oldhash rows
  email=$(secret_key langfuse-init LANGFUSE_INIT_USER_EMAIL); [ -n "$email" ] || die "langfuse-init has no LANGFUSE_INIT_USER_EMAIL"
  pw=$($FILES get "$OVERLAY" langfuseInit.userPassword); [ -n "$pw" ] || die "no langfuseInit.userPassword in $OVERLAY"
  sqlvars() { printf "\\\\set e '%s'\n" "$email"; [ -z "${1:-}" ] || printf "\\\\set h '%s'\n" "$1"; [ -z "${2:-}" ] || printf "\\\\set o '%s'\n" "$2"; }
  case $email in *"'"*) die "the init e-mail contains a quote" ;; esac
  rows=$( { sqlvars; printf "SELECT count(*) FROM users WHERE email = :'e';\n"; } | psql_db langfuse)
  [ "$rows" = 1 ] || die "expected exactly 1 Langfuse user with the init e-mail, found '$rows'"
  echo "   1 user with the init e-mail (langfuse database, table users)"
  if [ -n "$ROLLBACK" ]; then
    [ -f "$hashf" ] || die "no saved hash ($hashf)"
    [ -n "$APPLY" ] || { echo "   DRY RUN: would restore the saved hash with one UPDATE (exec $PG_POD psql). Add --apply."; return 0; }
    oldhash=$(cat "$hashf")
    r=$( { sqlvars "$oldhash"; printf "UPDATE users SET password = :'h' WHERE email = :'e';\n"; } | k exec -i "$PG_POD" -- sh -c "psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d langfuse -tA")
    [ "$r" = "UPDATE 1" ] || die "rollback UPDATE answered '$r'"
    echo "   restored the previous password hash (1 row). Deploy the password rollback overlay and restart os-ui."
    return 0
  fi
  if [ -z "$APPLY" ]; then
    cat <<EOF
   DRY RUN. With --apply (the owner's approval) this does, in order:
     1. bcrypt cost 12 of the new password with langfuse-web's own bcryptjs
        (kubectl exec -i deploy/$LANGFUSE_SVC -- node; the password goes in on stdin);
     2. saves the current hash to ${hashf##*/} (mode 600) — the rollback;
     3. ONE row: kubectl exec -i $PG_POD -- psql -d langfuse:
          UPDATE users SET password = <new hash> WHERE email = <init e-mail> AND password = <saved hash>;
        (must answer UPDATE 1).
   Then deploy the password overlay (so os-ui's LANGFUSE_SSO_PASSWORD matches) and restart os-ui.
EOF
    return 0
  fi
  [ ! -e "$hashf" ] || die "$hashf exists: this password was applied already (use --rollback to undo)"
  oldhash=$( { sqlvars; printf "SELECT password FROM users WHERE email = :'e';\n"; } | psql_db langfuse)
  [ -n "$oldhash" ] || die "could not read the current hash"
  ( umask 077; printf '%s' "$oldhash" > "$hashf" ); chmod 600 "$hashf"
  newhash=$(printf '%s' "$pw" | k exec -i "deploy/$LANGFUSE_SVC" -c langfuse-web -- sh -c 'node -e "const fs=require(\"fs\"),d=\"/app/node_modules/.pnpm\",p=fs.readdirSync(d).find(x=>/^bcryptjs@/.test(x)),b=require(d+\"/\"+p+\"/node_modules/bcryptjs\");let s=\"\";process.stdin.on(\"data\",c=>s+=c).on(\"end\",async()=>console.log(await b.hash(s,12)))"')
  case $newhash in '$2'[aby]'$12$'*) ;; *) die "langfuse-web did not return a bcrypt cost-12 hash" ;; esac
  r=$( { sqlvars "$newhash" "$oldhash"; printf "UPDATE users SET password = :'h' WHERE email = :'e' AND password = :'o';\n"; } | k exec -i "$PG_POD" -- sh -c "psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d langfuse -tA")
  [ "$r" = "UPDATE 1" ] || die "UPDATE answered '$r' (nothing changed if 0); the saved hash stays in $hashf"
  echo "   password hash replaced (1 row, bcrypt cost 12 by langfuse-web's bcryptjs); previous hash saved to ${hashf##*/}"
  echo "   next: VALUES_OVERLAY=$OVERLAY ./scripts/deploy.sh --from-registry $(live_version); kubectl rollout restart deploy/os-ui; then verify-password"
}

verify_password() {
  [ -f "$OVERLAY" ] || die "--overlay <password overlay> is required"
  check_binding "${OVERLAY%.yaml}.state.json"
  local email new old fails=0
  email=$(secret_key langfuse-init LANGFUSE_INIT_USER_EMAIL); new=$($FILES get "$OVERLAY" langfuseInit.userPassword); old=$($FILES get "${OVERLAY%.yaml}.rollback.yaml" langfuseInit.userPassword)
  [ "$(h16 "$(secret_key langfuse-init LANGFUSE_INIT_USER_PASSWORD)")" = "$(h16 "$new")" ] && echo "   ok   langfuse-init holds the new password (os-ui's LANGFUSE_SSO_PASSWORD)" || { echo "   FAIL langfuse-init does not hold the new password"; fails=$((fails+1)); }
  port_forward "$LANGFUSE_SVC" 3000
  signin() { # <password> → signed-in | refused  (NextAuth credentials flow; values on stdin)
    local jar; jar=$(mktemp)
    local csrf; csrf=$(curl -s -c "$jar" "http://127.0.0.1:$PF_PORT/api/auth/csrf" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrfToken"])')
    printf 'data-urlencode = "email=%s"\ndata-urlencode = "password=%s"\ndata-urlencode = "csrfToken=%s"\ndata-urlencode = "json=true"\n' "$email" "$1" "$csrf" \
      | curl -s -K - -b "$jar" -c "$jar" -o /dev/null "http://127.0.0.1:$PF_PORT/api/auth/callback/credentials"
    curl -s -b "$jar" "http://127.0.0.1:$PF_PORT/api/auth/session" | python3 -c 'import json,sys; print("signed-in" if json.load(sys.stdin).get("user") else "refused")'
    rm -f "$jar"
  }
  [ "$(signin "$new")" = signed-in ] && echo "   ok   Langfuse sign-in with the new password" || { echo "   FAIL Langfuse sign-in with the new password"; fails=$((fails+1)); }
  if [ -n "$old" ]; then [ "$(signin "$old")" = refused ] && echo "   ok   the previous password is refused" || { echo "   FAIL the previous password still signs in"; fails=$((fails+1)); }; fi
  stop_forward
  [ "$fails" -eq 0 ] && echo "PASSWORD_VERIFY_OK" || { echo "PASSWORD_VERIFY_FAILED ($fails)"; exit 1; }
}

case $CMD in
  prepare) prepare ;;
  plan) plan ;;
  baseline) baseline ;;
  verify) verify ;;
  password) password ;;
  password-db) password_db ;;
  verify-password) verify_password ;;
  *) sed -n '2,62p' "$0"; exit 2 ;;
esac
