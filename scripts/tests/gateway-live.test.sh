#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# gateway-live.test.sh — the live gateway tools, against a stub LiteLLM API and a fake kubectl.
# =============================================================================
# No cluster, no network beyond loopback. A fake `kubectl` runs `exec … python3 -c <helper>` locally against
# scripts/tests/fixtures/gateway-stub.py (the stand-in for the gateway's admin API inside the pod) and answers
# `get configmap` from a fixture. Proves:
#  * migrate-config-models-to-db.mjs: plan by default (no write), --apply creates a database row per config
#    model that has none — with the SAME litellm_params (the os.environ/ references, prices copied into
#    litellm_params) — refuses to copy a literal key (needs_key_in_ui), and a second run creates nothing;
#  * preflight-db-models.mjs: exit 1 naming a model a role alias / key / the config references with no
#    database row; exit 0 once they all have one; exit 3 when the gateway cannot be read;
#  * check-gateway-parity-live.mjs: same catalogs → 0; a price, a limit, a flag, a provider model, a missing
#    model, a role alias that differ → 1, each named; api_base addresses listed in deploy/gateway-parity.yaml
#    count as equal; an unreadable environment → 2;
#  * no output ever contains a key: the stub's rows and keys carry secret-looking values.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
REPO=$PWD
TMP=$(mktemp -d); BIN=$TMP/bin; mkdir -p "$BIN"
STUB_PID=''
cleanup() { [ -n "$STUB_PID" ] && { kill "$STUB_PID"; wait "$STUB_PID"; } 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT
export STUB_MASTER_KEY=sk-STUB-MASTER-SECRET-123 GATEWAY_SKIP_ENV_GUARD=1 KUBECTL="$BIN/kubectl"

cat > "$TMP/config.yaml" <<'YAML'
model_list:
- model_name: stackit-gpt-oss-20b
  litellm_params: {model: openai/openai/gpt-oss-20b, api_base: os.environ/STACKIT_API_BASE, api_key: os.environ/STACKIT_API_KEY}
  model_info: {mode: chat, input_cost_per_token: 1.5e-07, output_cost_per_token: 2.5e-07, max_input_tokens: 131000}
- model_name: sovereign-default
  litellm_params: {model: openai/openai/gpt-oss-20b, api_base: os.environ/STACKIT_API_BASE, api_key: os.environ/STACKIT_API_KEY}
  model_info: {mode: chat, input_cost_per_token: 1.5e-07, output_cost_per_token: 2.5e-07}
- model_name: literal-key-model
  litellm_params: {model: openai/x, api_base: https://x.example.test/v1, api_key: sk-LITERAL-NEVER-PRINT}
  model_info: {mode: chat, input_cost_per_token: 0, output_cost_per_token: 0}
YAML
cat > "$TMP/state.json" <<'JSON'
{"rows": [
  {"model_name": "stackit-gpt-oss-20b", "litellm_params": {"model": "openai/openai/gpt-oss-20b", "api_base": "https://stackit.example.test/v1", "api_key": "sk-ROW-SECRET-1"}, "model_info": {"db_model": false, "mode": "chat", "id": "c1"}},
  {"model_name": "sovereign-default", "litellm_params": {"model": "openai/openai/gpt-oss-20b", "api_base": "https://stackit.example.test/v1", "api_key": "sk-ROW-SECRET-2"}, "model_info": {"db_model": false, "mode": "chat", "id": "c2"}},
  {"model_name": "literal-key-model", "litellm_params": {"model": "openai/x", "api_base": "https://x.example.test/v1", "api_key": "sk-LITERAL-NEVER-PRINT"}, "model_info": {"db_model": false, "id": "c3"}},
  {"model_name": "lyceum-kimi-k3.1-pro", "litellm_params": {"model": "moonshotai/kimi-k3.1-pro", "custom_llm_provider": "openai", "api_base": "https://api.lyceum.technology/openai/v1", "api_key": "sk-LYCEUM-SECRET"}, "model_info": {"db_model": true, "mode": "chat", "id": "d1"}},
  {"model_name": "lyceum-deepseek-v4.1-flash", "litellm_params": {"model": "deepseek/deepseek-v4.1-flash", "custom_llm_provider": "openai", "api_base": "https://api.lyceum.technology/openai/v1", "api_key": "sk-LYCEUM-SECRET", "input_cost_per_token": 5e-7, "output_cost_per_token": 1.5e-6}, "model_info": {"db_model": true, "mode": "chat", "id": "d2"}},
  {"model_name": "sovereign-strong", "litellm_params": {"model": "moonshotai/kimi-k3.1-pro", "custom_llm_provider": "openai"}, "model_info": {"db_model": true, "id": "d1"}}
 ],
 "aliases": {"sovereign-strong": "lyceum-kimi-k3.1-pro", "sovereign-worker": "deepseek/deepseek-v4.1-flash"},
 "keys": [{"key_alias": "agent-x", "token": "sk-KEY-TOKEN-SECRET", "models": ["sovereign-strong", "sovereign-default", "os-admin-registered"]}]}
JSON
python3 scripts/tests/fixtures/gateway-stub.py "$TMP/state.json" "$TMP/port" & STUB_PID=$!
for _ in $(seq 1 50); do [ -s "$TMP/port" ] && break; sleep 0.1; done
PORT=$(cat "$TMP/port")

cat > "$BIN/kubectl" <<STUB
#!/usr/bin/env bash
# fake kubectl: exec runs the helper here, against the stub; get configmap answers the fixture.
[ -f "$TMP/unreachable" ] && { echo "error: You must be logged in to the server" >&2; exit 1; }
while [ \$# -gt 0 ]; do
  case \$1 in
    exec) shift; while [ "\$1" != -- ]; do shift; done; shift
          GATEWAY_URL=http://127.0.0.1:$PORT PROXY_MASTER_KEY=\$STUB_MASTER_KEY STACKIT_API_BASE=https://stackit.example.test/v1 exec "\$@" ;;
    get) cat "$TMP/config.yaml" | python3 -c 'import sys,yaml; print(yaml.safe_dump(yaml.safe_load(sys.stdin)))'; exit 0 ;;
    *) shift ;;
  esac
done
STUB
chmod +x "$BIN/kubectl"
no_secret() { for s in sk-STUB-MASTER-SECRET-123 sk-ROW-SECRET sk-LITERAL-NEVER-PRINT sk-LYCEUM-SECRET sk-KEY-TOKEN-SECRET; do absent "$1: no secret ($s)" "$s" "$2"; done; }

echo "== preflight before the migration"
out=$(node scripts/gateway/preflight-db-models.mjs --env dev 2>&1); rc=$?
rc_is "referenced models without a database row fail the preflight" 1
check "a config model referenced by a key is named" "sovereign-default  (referenced by: config file; key agent-x)" "$out"
check "a role alias at a name that does not exist is named" "deepseek/deepseek-v4.1-flash  (referenced by: alias sovereign-worker)" "$out"
absent "the access group is not a model" "os-admin-registered  (" "$out"
no_secret "preflight" "$out"

echo "== migrate: plan, apply, idempotent"
out=$(node scripts/gateway/migrate-config-models-to-db.mjs --env dev 2>&1); rc=$?
check "the plan names what it would create" "would_create    stackit-gpt-oss-20b" "$out"
check "a literal key is never copied" "needs_key_in_ui literal-key-model" "$out"
posts=$(python3 -c "import json;print(len(json.load(open('$TMP/state.json')).get('posts',[])))")
check "the plan writes nothing" "0" "$posts"
out=$(node scripts/gateway/migrate-config-models-to-db.mjs --env dev --apply 2>&1); rc=$?
check "--apply creates the rows" "created         sovereign-default" "$out"
body=$(python3 -c "
import json; st=json.load(open('$TMP/state.json'))
b=[p['body'] for p in st['posts'] if p['body']['model_name']=='stackit-gpt-oss-20b'][0]
print(json.dumps(b['litellm_params'], sort_keys=True))")
check "the row keeps the env REFERENCE for the key" '"api_key": "os.environ/STACKIT_API_KEY"' "$body"
check "the row keeps the env reference for the endpoint" '"api_base": "os.environ/STACKIT_API_BASE"' "$body"
check "prices are copied into litellm_params" '"input_cost_per_token": 1.5e-07' "$body"
lit=$(python3 -c "import json;print([p['body']['model_name'] for p in json.load(open('$TMP/state.json'))['posts']])")
absent "the literal-key model was not created" "literal-key-model" "$lit"
no_secret "migrate" "$out"
out=$(node scripts/gateway/migrate-config-models-to-db.mjs --env dev --apply 2>&1); rc=$?
check "a second run finds the rows present" "present         stackit-gpt-oss-20b" "$out"
absent "and creates nothing" "created" "$out"

echo "== preflight after"
python3 - "$TMP/state.json" <<'PY'
import json, sys
st = json.load(open(sys.argv[1])); st['aliases']['sovereign-worker'] = 'stackit-gpt-oss-20b'
st['rows'] = [r for r in st['rows'] if r['model_name'] != 'literal-key-model']
json.dump(st, open(sys.argv[1], 'w'))
PY
out=$(node scripts/gateway/preflight-db-models.mjs --env dev 2>&1); rc=$?
rc_is "every referenced model has a database row: the preflight passes" 0
touch "$TMP/unreachable"
out=$(node scripts/gateway/preflight-db-models.mjs --env dev 2>&1); rc=$?
rc_is "an unreadable gateway is exit 3, not a pass" 3
rm "$TMP/unreachable"

echo "== an unreadable alias list is never treated as empty"
touch "$TMP/router-500"
out=$(node scripts/gateway/preflight-db-models.mjs --env dev 2>&1); rc=$?
rc_is "the preflight stops (exit 3) when /router/settings fails" 3
check "and says the gateway could not be read" "GATEWAY_PREFLIGHT_UNREADABLE" "$out"
rm "$TMP/router-500"

echo "== live parity (offline catalogs)"
GATEWAY_URL=http://127.0.0.1:$PORT PROXY_MASTER_KEY=$STUB_MASTER_KEY python3 scripts/gateway/gateway_live.py catalog > "$TMP/dev.json"
no_secret "catalog" "$(cat "$TMP/dev.json")"
cp "$TMP/dev.json" "$TMP/prod.json"
par() { out=$(node scripts/check-gateway-parity-live.mjs --dev-json "$TMP/dev.json" --prod-json "$TMP/prod.json" 2>&1); rc=$?; }
par; rc_is "the same catalog on both is parity" 0
absent "an alias row that repeats its target is not a model" '"sovereign-strong": [' "$(cat "$TMP/dev.json")"
check "a database row with its price only in litellm_params is priced (model_info)" '5e-07' "$(python3 -c "import json;print(json.load(open('$TMP/dev.json'))['models']['lyceum-deepseek-v4.1-flash'][0]['info'].get('input_cost_per_token'))")"
unpriced=$(python3 scripts/lib/smoke-facts.py catalog-unpriced < "$TMP/dev.json")
check "the smoke test counts that row as priced (only the unpriced kimi row is listed)" "unpriced=lyceum-kimi-k3.1-pro" "$unpriced"
absent "and only the really unpriced ones are listed" "lyceum-deepseek" "$unpriced"
printf '%s\n' '{"aliases":{},"models":{"x":[{"db":true,"info":{},"params":{"input_cost_per_token":1e-7,"output_cost_per_token":2e-7}}]}}' > "$TMP/params-only.json"
absent "smoke-facts also accepts prices under params" "unpriced=x" "$(python3 scripts/lib/smoke-facts.py catalog-unpriced < "$TMP/params-only.json")"
edit() { python3 - "$TMP/prod.json" "$1" <<'PY'
import json, sys
c = json.load(open(sys.argv[1])); exec(sys.argv[2]); json.dump(c, open(sys.argv[1], 'w'))
PY
}
cp "$TMP/dev.json" "$TMP/prod.json"; edit "c['models']['lyceum-kimi-k3.1-pro'][0]['info']['input_cost_per_token']=0.000003"; par
rc_is "a different price differs" 1
check "and is named" "lyceum-kimi-k3.1-pro: model_info.input_cost_per_token" "$out"
cp "$TMP/dev.json" "$TMP/prod.json"; edit "c['models']['lyceum-kimi-k3.1-pro'][0]['info']['supports_vision']=True"; par
check "a supports_* flag is compared" "model_info.supports_vision" "$out"
cp "$TMP/dev.json" "$TMP/prod.json"; edit "c['models']['lyceum-kimi-k3.1-pro'][0]['params']['model']='openai/moonshotai/kimi-k3'"; par
check "the provider model is compared" "model: dev" "$out"
cp "$TMP/dev.json" "$TMP/prod.json"; edit "del c['models']['stackit-gpt-oss-20b']"; par
check "a model only on dev is named" "stackit-gpt-oss-20b: only on dev" "$out"
cp "$TMP/dev.json" "$TMP/prod.json"; edit "c['aliases']['sovereign-strong']='stackit-gpt-oss-20b'"; par
check "a different role mapping is named" "role alias sovereign-strong: dev → lyceum-kimi-k3.1-pro, prod → stackit-gpt-oss-20b" "$out"
cp "$TMP/dev.json" "$TMP/prod.json"
edit "[d['params'].__setitem__('api_base','https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1') for d in c['models']['stackit-gpt-oss-20b']]"
python3 - "$TMP/dev.json" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
for d in c['models']['stackit-gpt-oss-20b']: d['params']['api_base'] = 'http://model-key-proxy.dev-model-key.svc.cluster.local:8080/v1'
json.dump(c, open(sys.argv[1], 'w'))
PY
par; rc_is "dev's model-key-proxy address equals STACKIT's (deploy/gateway-parity.yaml)" 0
cp "$TMP/dev.json" "$TMP/prod.json"; edit "c['alias_conflicts']=['sovereign-strong']"; par
rc_is "a model row named like a role alias is a difference" 1
check "and is reported as a conflict" "prod: a model row is named like the role alias sovereign-strong" "$out"
touch "$TMP/unreachable"
out=$(node scripts/check-gateway-parity-live.mjs --prod-json "$TMP/prod.json" 2>&1); rc=$?
rc_is "an unreadable environment is exit 2" 2
check "and says which" "GATEWAY_PARITY_UNREADABLE" "$out"
rm "$TMP/unreachable"
finish "gateway-live"
