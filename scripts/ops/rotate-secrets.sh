#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# rotate-secrets.sh — prepare, plan and verify the rotation of the LiteLLM master key (with a
# salt key) and the Langfuse project key pair. docs/ops/secret-rotation.md is the run-book.
# =============================================================================
#   scripts/ops/rotate-secrets.sh prepare  [common options]
#   scripts/ops/rotate-secrets.sh plan     --overlay <file> [--chart <dir>] [common options]
#   scripts/ops/rotate-secrets.sh verify   --overlay <file> [--os-ui-exec] [common options]
#   scripts/ops/rotate-secrets.sh password [common options]
#   common: --context <kube context> (dmagenticos) --namespace <ns> (agentic-os) --release <name> (agentic-os)
#
# prepare   READ-ONLY on the cluster. Inventories what LiteLLM stores encrypted in its database
#           (GET /model/info → db_model: true, GET /credentials, GET /v1/mcp/server) through a
#           short-lived port-forward, with the CURRENT master key read from the Secret into a shell
#           variable. Chooses the path:
#             none stored  → a new random LITELLM_SALT_KEY together with the new master key;
#             some stored, or the inventory could not be read
#                          → "pin first": LITELLM_SALT_KEY = the current master key, so the stored
#                            values stay decryptable while the master key changes.
#           Generates the new values on THIS machine (openssl rand) and writes them only to
#             ~/.sovereign-os-secrets/overlays/rotation-<date>.yaml           (mode 600)
#             ~/.sovereign-os-secrets/overlays/rotation-<date>.rollback.yaml  (mode 600, previous values)
#             ~/.sovereign-os-secrets/overlays/rotation-<date>.state.json     (no secrets: path, counts, model names, hashes)
#           Prints the deploy command for the version that is live now, the restarts and the post-checks.
# plan      READ-ONLY. Renders <chart> with the live release values + the overlay
#           (`helm template --dry-run=server`, so `lookup` and the salt-key guard run as in the
#           upgrade) and compares it with the live manifest object by object. Prints kind/name of
#           every object that changes, the Secret KEYS that change, and which workloads roll by
#           themselves (pod template changed). Hashes only; never a value.
# verify    The post-checks: old master key → 401, new master key → 200, the shared virtual key
#           lists and calls a model, every model that was stored in the database is still served,
#           the new Langfuse key pair authenticates; with --os-ui-exec also os-ui's own key
#           (exec into os-ui: the credential it really holds, the two reads /api/gateway makes).
# password  Writes a new Langfuse init-user password into a separate overlay (mode 600); the steps
#           that make Langfuse use it are in the run-book (headless init never changes an existing
#           user's password).
#
# No value is ever printed, logged or put on a command line: keys travel in shell variables and
# reach curl through a config on stdin (`curl -K -`). Output shows names, counts and sha256 prefixes.
set -euo pipefail
umask 077

CTX=dmagenticos NS=agentic-os REL=agentic-os
OVERLAY="" CHART="" OS_UI_EXEC=""
CMD=${1:-}; [ $# -gt 0 ] && shift
while [ $# -gt 0 ]; do
  case $1 in
    --context) CTX=$2; shift ;;
    --namespace) NS=$2; shift ;;
    --release) REL=$2; shift ;;
    --overlay) OVERLAY=$2; shift ;;
    --chart) CHART=$2; shift ;;
    --os-ui-exec) OS_UI_EXEC=1 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
SECRETS_DIR=${SOVEREIGN_SECRETS_DIR:-$HOME/.sovereign-os-secrets}/overlays
LITELLM_SVC=${LITELLM_SVC:-$REL-litellm}
LANGFUSE_SVC=${LANGFUSE_SVC:-$REL-langfuse-web}
REPO=$(cd "$(dirname "$0")/../.." && pwd)

say() { printf '==> %s\n' "$*"; }
die() { printf 'ROTATE_FAILED — %s\n' "$*" >&2; exit 1; }
k() { kubectl --context "$CTX" -n "$NS" "$@"; }
h16() { printf '%s' "$1" | shasum -a 256 | cut -c1-16; }
# secret_key <secret> <key> — the decoded value, for a shell variable only (empty when absent).
secret_key() {
  k get secret "$1" -o "go-template={{ with index .data \"$2\" }}{{ . }}{{ end }}" 2>/dev/null | base64 -d 2>/dev/null || true
}

PF_PID="" PF_PORT=""
# port_forward <svc> <port> — a short-lived port-forward on a free local port.
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
stop_forward() { [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null; wait "$PF_PID" 2>/dev/null || true; PF_PID=""; }
trap stop_forward EXIT

# call <bearer> <method> <path> [json body] — prints "<http code>\n<body>" ; the bearer goes in on stdin.
call() {
  local body=${4:-}
  { printf 'header = "Authorization: Bearer %s"\n' "$1"
    if [ -n "$body" ]; then printf 'header = "Content-Type: application/json"\ndata = "%s"\n' "${body//\"/\\\"}"; fi
  } | curl -sS -K - -X "$2" -w '\n%{http_code}' --max-time 60 "http://127.0.0.1:$PF_PORT$3" | { body=$(cat); printf '%s\n%s' "${body##*$'\n'}" "${body%$'\n'*}"; }
}
code_of() { head -n1 <<<"$1"; }
chat_body() { printf '{"model":"%s","messages":[{"role":"user","content":"ping"}],"max_tokens":5}' "$1"; }
body_of() { tail -n +2 <<<"$1"; }
# basic <user> <password> <path> — the http code only (Langfuse public API).
basic() {
  printf 'user = "%s:%s"\n' "$1" "$2" | curl -sS -K - -o /dev/null -w '%{http_code}' --max-time 30 "http://127.0.0.1:$PF_PORT$3" || true
}

live_version() {
  k get deploy os-ui -o jsonpath='{.spec.template.spec.containers[0].image}' | sed -E 's/.*:([^:@]+)(@.*)?$/\1/'
}

# ----------------------------------------------------------------------------------------------
prepare() {
  command -v openssl >/dev/null || die "openssl not found"
  mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR" "$(dirname "$SECRETS_DIR")"
  local stamp; stamp=$(date +%Y%m%d-%H%M%S)
  local out="$SECRETS_DIR/rotation-$stamp.yaml" back="$SECRETS_DIR/rotation-$stamp.rollback.yaml" state="$SECRETS_DIR/rotation-$stamp.state.json"

  say "context $CTX / namespace $NS / release $REL"
  local old_master old_salt old_pk old_sk
  old_master=$(secret_key litellm-credentials masterkey)
  [ -n "$old_master" ] || die "litellm-credentials has no masterkey"
  old_salt=$(secret_key litellm-credentials LITELLM_SALT_KEY)
  old_pk=$(secret_key langfuse-init LANGFUSE_INIT_PROJECT_PUBLIC_KEY)
  old_sk=$(secret_key langfuse-init LANGFUSE_INIT_PROJECT_SECRET_KEY)
  echo "   current master key sha256 $(h16 "$old_master")…; salt key in the Secret: $([ -n "$old_salt" ] && echo "yes, sha256 $(h16 "$old_salt")…" || echo no)"

  say "inventory of what LiteLLM stores encrypted (step 5 of the rotation order), via a port-forward"
  port_forward "$LITELLM_SVC" 4000
  local r mi total mcp_config db_count=unknown cred_count=unknown mcp_count=unknown db_names="[]"
  r=$(call "$old_master" GET /model/info)
  if [ "$(code_of "$r")" = 200 ]; then
    mi=$(body_of "$r" | python3 -c '
import json, sys
d = json.load(sys.stdin).get("data", [])
db = [m.get("model_name") for m in d if (m.get("model_info") or {}).get("db_model")]
print(len(d), len(db), json.dumps(sorted(set(db))))')
    read -r total db_count db_names <<<"$mi"
    echo "   GET /model/info: $total deployments, db_model=true: $db_count $db_names"
  else
    echo "   GET /model/info answered $(code_of "$r") — count unknown"
  fi
  r=$(call "$old_master" GET /credentials)
  if [ "$(code_of "$r")" = 200 ]; then
    cred_count=$(body_of "$r" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("credentials") or []))')
    echo "   GET /credentials: $cred_count stored credentials"
  else echo "   GET /credentials answered $(code_of "$r") — count unknown"; fi
  r=$(call "$old_master" GET /v1/mcp/server)
  if [ "$(code_of "$r")" = 200 ]; then
    # Servers from the config file come back with created_at/created_by null; only the ones
    # added through the API or the console are rows in LiteLLM_MCPServerTable (encrypted).
    read -r mcp_count mcp_config <<<"$(body_of "$r" | python3 -c 'import json,sys
d = json.load(sys.stdin); d = d if isinstance(d, list) else (d.get("data") or d.get("servers") or [])
db = [s for s in d if s.get("created_at") or s.get("created_by")]
print(len(db), len(d) - len(db))')"
    echo "   GET /v1/mcp/server: $mcp_count stored in the database, $mcp_config from the config file (not encrypted)"
  else echo "   GET /v1/mcp/server answered $(code_of "$r") — count unknown"; fi
  stop_forward

  local path new_salt
  if [ -n "$old_salt" ]; then
    path=salt-already-set; new_salt=$old_salt
    echo "   a salt key is already set: it is kept as it is (it must never change); only the master key rotates"
  elif [ "$db_count" = 0 ] && [ "$cred_count" = 0 ] && [ "$mcp_count" = 0 ]; then
    path=none-stored; new_salt=$(openssl rand -hex 32)
    echo "   PATH: none stored — a new random salt key together with the new master key"
  else
    path=pin-first; new_salt=$old_master
    echo "   PATH: pin first — the salt key is pinned to the CURRENT master key so the stored values stay readable"
    echo "         (db models: $db_count, credentials: $cred_count, MCP servers: $mcp_count). Follow up with"
    echo "         docs/ops/litellm-salt-key.md procedure C: re-create them under a new random salt."
  fi

  local new_master new_pk new_sk
  new_master="sk-$(openssl rand -hex 32)"
  new_pk="pk-lf-$(openssl rand -hex 16)"
  new_sk="sk-lf-$(openssl rand -hex 32)"
  [ "$new_master" != "$old_master" ] || die "generated master key equals the current one"

  # yaml: double-quoted scalars; the generated values are hex, the carried ones are checked.
  q() { case $1 in *[\"\\]*) die "a value contains a quote or backslash; refusing to write YAML for it" ;; esac; printf '"%s"' "$1"; }
  {
    echo "# rotation $stamp ($path) — PRIVATE, never commit. Generated by scripts/ops/rotate-secrets.sh."
    echo "litellmMasterKey: $(q "$new_master")"
    echo "litellmSaltKey:"
    echo "  value: $(q "$new_salt")"
    echo "langfuseInit:"
    echo "  publicKey: $(q "$new_pk")"
    echo "  secretKey: $(q "$new_sk")"
  } > "$out"
  {
    echo "# rollback for rotation $stamp — the PREVIOUS values. PRIVATE, never commit."
    echo "litellmMasterKey: $(q "$old_master")"
    echo "litellmSaltKey:"
    if [ -n "$old_salt" ]; then echo "  value: $(q "$old_salt")"; else echo '  value: ""'; fi
    echo "  allowChange: true"
    echo "langfuseInit:"
    echo "  publicKey: $(q "$old_pk")"
    echo "  secretKey: $(q "$old_sk")"
  } > "$back"
  chmod 600 "$out" "$back"
  python3 - "$state" <<PY
import json, sys
json.dump({"path": "$path", "db_models": $db_names, "counts": {"db_model": "$db_count", "credentials": "$cred_count", "mcp_servers": "$mcp_count"},
           "sha256_16": {"old_master": "$(h16 "$old_master")", "new_master": "$(h16 "$new_master")", "salt": "$(h16 "$new_salt")",
                         "old_langfuse_pk": "$(h16 "$old_pk")", "new_langfuse_pk": "$(h16 "$new_pk")"}},
          open(sys.argv[1], "w"), indent=1)
PY
  chmod 600 "$state"
  echo "   wrote $out (mode $(stat -f %Lp "$out" 2>/dev/null || stat -c %a "$out"))"
  echo "   wrote $back (the previous values, for the rollback)"
  echo "   new master key sha256 $(h16 "$new_master")…, salt sha256 $(h16 "$new_salt")…, Langfuse public key sha256 $(h16 "$new_pk")…"

  local ver; ver=$(live_version)
  cat <<EOF

NEXT (docs/ops/secret-rotation.md has the full run-book):
  1. plan, read-only — only Secrets may change:
       scripts/ops/rotate-secrets.sh plan --overlay $out --context $CTX
  2. deploy the version that is live now, so only the secrets change:
       VALUES_OVERLAY=$out ./scripts/deploy.sh --from-registry $ver
  3. restart the readers that do not roll by themselves (a Secret change restarts nothing):
       kubectl --context $CTX -n $NS rollout restart deploy/$LANGFUSE_SVC deploy/$LITELLM_SVC
       kubectl --context $CTX -n $NS rollout status deploy/$LANGFUSE_SVC deploy/$LITELLM_SVC --timeout=10m
       kubectl --context $CTX -n $NS rollout restart deploy/os-ui deploy/os-ui-worker
       kubectl --context $CTX -n $NS rollout status deploy/os-ui deploy/os-ui-worker --timeout=15m
  4. post-checks:
       scripts/ops/rotate-secrets.sh verify --overlay $out --context $CTX [--os-ui-exec]
     then by hand: Admin → LLM Gateway opens (everyone is signed out of the console once), a
     short agent run completes, and its trace arrives in Langfuse.
  5. Langfuse UI: delete the OLD project key pair (public key sha256 $(h16 "$old_pk")…), then
       scripts/ops/rotate-secrets.sh verify --overlay $out --context $CTX   (old pair → 401)
  Rollback: VALUES_OVERLAY=$back ./scripts/deploy.sh --from-registry $ver, then step 3 again.
EOF
}

# ----------------------------------------------------------------------------------------------
plan() {
  [ -f "$OVERLAY" ] || die "--overlay <file> is required"
  CHART=${CHART:-$REPO/charts/sovereign-agentic-os}
  PLAN_DIR=$(mktemp -d); local w=$PLAN_DIR; trap 'stop_forward; rm -rf "$PLAN_DIR"' EXIT
  say "live release values and manifest (read-only)"
  helm --kube-context "$CTX" get values "$REL" -n "$NS" -o yaml > "$w/live.yaml"
  helm --kube-context "$CTX" get manifest "$REL" -n "$NS" > "$w/before.yaml"
  say "render $CHART with the live values + the overlay (--dry-run=server: lookup and the salt guard run)"
  helm template "$REL" "$CHART" -n "$NS" --kube-context "$CTX" --dry-run=server --skip-schema-validation \
    -f "$w/live.yaml" -f "$OVERLAY" > "$w/after.yaml" 2> "$w/err" || { grep -v '^level=INFO' "$w/err" >&2; die "render failed"; }
  python3 "$REPO/scripts/lib/manifest-diff.py" "$w/before.yaml" "$w/after.yaml"
}

# ----------------------------------------------------------------------------------------------
verify() {
  [ -f "$OVERLAY" ] || die "--overlay <file> is required"
  local back=${OVERLAY%.yaml}.rollback.yaml state=${OVERLAY%.yaml}.state.json
  [ -f "$back" ] && [ -f "$state" ] || die "the rollback and state files next to $OVERLAY are missing"
  local new_master old_master agent new_pk new_sk old_pk old_sk
  ov() { python3 -c 'import sys,yaml; d=yaml.safe_load(open(sys.argv[1]));
for p in sys.argv[2].split("."): d=(d or {}).get(p)
print(d or "")' "$1" "$2"; }
  new_master=$(ov "$OVERLAY" litellmMasterKey); old_master=$(ov "$back" litellmMasterKey)
  new_pk=$(ov "$OVERLAY" langfuseInit.publicKey); new_sk=$(ov "$OVERLAY" langfuseInit.secretKey)
  old_pk=$(ov "$back" langfuseInit.publicKey); old_sk=$(ov "$back" langfuseInit.secretKey)
  agent=$(secret_key "${AGENT_KEY_SECRET:-agent-litellm-key}" apiKey)
  local fails=0 r c
  pass() { echo "   ok   $1"; }
  fail() { echo "   FAIL $1"; fails=$((fails+1)); }

  say "the Secrets hold the new values (sha256 prefixes only)"
  [ "$(h16 "$(secret_key litellm-credentials masterkey)")" = "$(h16 "$new_master")" ] && pass "litellm-credentials masterkey = new" || fail "litellm-credentials masterkey is not the new value"
  [ "$(h16 "$(secret_key litellm-credentials LITELLM_SALT_KEY)")" = "$(h16 "$(ov "$OVERLAY" litellmSaltKey.value)")" ] && pass "litellm-credentials LITELLM_SALT_KEY = overlay" || fail "LITELLM_SALT_KEY is not the overlay value"
  [ "$(h16 "$(secret_key langfuse-init LANGFUSE_INIT_PROJECT_SECRET_KEY)")" = "$(h16 "$new_sk")" ] && pass "langfuse-init secret key = new" || fail "langfuse-init secret key is not the new value"

  say "LiteLLM (port-forward)"
  port_forward "$LITELLM_SVC" 4000
  c=$(code_of "$(call "$old_master" GET /model/info)"); [ "$c" = 401 ] && pass "old master key → 401" || fail "old master key → $c (want 401)"
  r=$(call "$new_master" GET /model/info); c=$(code_of "$r"); [ "$c" = 200 ] && pass "new master key → 200" || fail "new master key → $c (want 200)"
  local now_db; now_db=$(body_of "$r" | python3 -c '
import json, sys
try: d = json.load(sys.stdin).get("data", [])
except Exception: d = []
print(json.dumps(sorted({m.get("model_name") for m in d if (m.get("model_info") or {}).get("db_model")})))')
  local want_db; want_db=$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["db_models"]))' "$state")
  [ "$now_db" = "$want_db" ] && pass "database-stored models still listed: $now_db" || fail "database-stored models now $now_db, before $want_db"
  for m in $(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["db_models"]))' "$state"); do
    r=$(call "$new_master" POST /v1/chat/completions "$(chat_body "$m")"); c=$(code_of "$r")
    [ "$c" = 200 ] && pass "stored model $m served → 200" || fail "stored model $m → $c (400 'Invalid model name' = its credentials no longer decrypt)"
  done
  if [ -n "$agent" ]; then
    r=$(call "$agent" GET /v1/models); c=$(code_of "$r")
    [ "$c" = 200 ] && pass "shared virtual key lists models → 200" || fail "shared virtual key /v1/models → $c"
    local model; model=${VERIFY_MODEL:-$(body_of "$r" | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["data"][0]["id"])
except Exception: print("")')}
    if [ -n "$model" ]; then
      r=$(call "$agent" POST /v1/chat/completions "$(chat_body "$model")"); c=$(code_of "$r")
      [ "$c" = 200 ] && pass "shared virtual key calls $model → 200" || fail "shared virtual key call $model → $c"
    else fail "shared virtual key sees no model"; fi
  else fail "agent-litellm-key has no apiKey"; fi
  stop_forward

  if [ -n "$OS_UI_EXEC" ]; then
    say "os-ui's own credential (exec: the two reads /api/gateway makes, with the key os-ui holds)"
    r=$(k exec deploy/os-ui -c os-ui -- node -e '
const u = process.env.LITELLM_URL, h = { Authorization: "Bearer " + process.env.LITELLM_MASTER_KEY };
Promise.all(["/v1/models", "/v1/mcp/tools"].map(p => fetch(u + p, { headers: h }).then(r => p + "=" + r.status, e => p + "=ERR")))
  .then(x => console.log(x.join(" ")));' 2>&1 || true)
    case $r in *"/v1/models=200"*) pass "os-ui → LiteLLM with its LITELLM_MASTER_KEY: $r" ;; *) fail "os-ui → LiteLLM: $r" ;; esac
  fi

  say "Langfuse (port-forward)"
  port_forward "$LANGFUSE_SVC" 3000
  c=$(basic "$new_pk" "$new_sk" /api/public/projects); [ "$c" = 200 ] && pass "new Langfuse key pair → 200" || fail "new Langfuse key pair → $c (did langfuse-web restart after the deploy?)"
  c=$(basic "$old_pk" "$old_sk" /api/public/projects)
  case $c in 401) pass "old Langfuse key pair → 401 (deleted in the UI)" ;; 200) echo "   todo old Langfuse key pair still → 200: delete it in the Langfuse UI, then run verify again" ;; *) fail "old Langfuse key pair → $c" ;; esac
  stop_forward

  echo
  [ "$fails" -eq 0 ] && echo "ROTATION_VERIFY_OK" || { echo "ROTATION_VERIFY_FAILED ($fails)"; exit 1; }
}

# ----------------------------------------------------------------------------------------------
password() {
  command -v openssl >/dev/null || die "openssl not found"
  mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR"
  local f; f="$SECRETS_DIR/langfuse-password-$(date +%Y%m%d-%H%M%S).yaml"
  local pw; pw=$(openssl rand -base64 30 | tr -d '/+=' | cut -c1-32)
  { echo "# Langfuse init-user password — PRIVATE, never commit. Run-book: docs/ops/secret-rotation.md"
    echo "langfuseInit:"
    echo "  userPassword: \"$pw\""
  } > "$f"; chmod 600 "$f"
  echo "   wrote $f (password sha256 $(h16 "$pw")…). Next: docs/ops/secret-rotation.md, 'Langfuse admin password'."
}

case $CMD in
  prepare) prepare ;;
  plan) plan ;;
  verify) verify ;;
  password) password ;;
  *) sed -n '2,40p' "$0"; exit 2 ;;
esac
