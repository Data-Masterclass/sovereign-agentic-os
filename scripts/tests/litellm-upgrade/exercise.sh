#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# The behaviours of the LiteLLM gateway that the Sovereign OS depends on, exercised against a
# running local gateway (see lib.sh). Prints one block per behaviour; `CHECK` lines are the
# assertions (PASS/FAIL). Run:  bash exercise.sh <label>
source "$(dirname "$0")/lib.sh"
LABEL=${1:-run}
pass=0; fail=0
check() { # $1 description  $2 condition result (0/1)
  if [ "$2" = 0 ]; then echo "  CHECK PASS  $1"; pass=$((pass+1)); else echo "  CHECK FAIL  $1"; fail=$((fail+1)); fi
}
has() { grep -q -- "$2" <<<"$1"; echo $?; }
code() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }
pyj() { python3 -c "$1" "${@:2}"; }
wait_s() { python3 -c "import time; time.sleep($1)"; }
SYS=sys-$(date +%s)
SYSKEY="sk-os-$SYS"
TOOLS='"tools":[{"type":"function","function":{"name":"list_files","description":"TOOLDESC_MARKER list","parameters":{"type":"object","properties":{"note":{"type":"string"}}}}}],"tool_choice":"auto"'

echo "################ $LABEL — $(curl -sS -D - -o /dev/null $B/health/liveliness | grep -i '^x-litellm-version' | tr -d '\r')"

echo "== 1. health and root (the probes, the OS health checks)"
for p in /health/liveliness /health/readiness / /tools/litellm/ui/ /tools/litellm/health/liveliness; do printf '  %-34s %s\n' "$p" "$(code $B$p)"; done
check "/health/liveliness 200" "$([ "$(code $B/health/liveliness)" = 200 ]; echo $?)"
check "/health/readiness 200" "$([ "$(code $B/health/readiness)" = 200 ]; echo $?)"
curl -sS $B/health/readiness | pyj "import json,sys; d=json.load(sys.stdin); print('  readiness:', {k:d.get(k) for k in ('status','db','cache','litellm_version','success_callbacks')})"
check "API without a key 401" "$([ "$(code $B/v1/models)" = 401 ]; echo $?)"

echo "== 2. /key/generate — the body os-ui Build sends (live-clients.ts keyProperties)"
GEN=$(adm -X POST $B/key/generate -w '\n%{http_code}' -d '{"key":"'$SYSKEY'","key_alias":"os-'$SYS'","models":["sovereign-default","sovereign-reasoning"],"max_budget":5,"budget_duration":"7d","rpm_limit":300,"tpm_limit":1000000,"metadata":{"allowed_tools":["list_files","get_file"],"model_max_budget":{"sovereign-reasoning":2}}}')
GC=$(tail -1 <<<"$GEN"); echo "  HTTP $GC"; check "/key/generate 200" "$([ "$GC" = 200 ]; echo $?)"
[ "$GC" = 200 ] || echo "  body: $(head -c 400 <<<"$GEN")"

echo "== 3. /key/info — the fields os-ui reads back (info.models/max_budget/budget_duration/rpm_limit/tpm_limit/metadata.allowed_tools)"
INFO=$(adm "$B/key/info?key=$SYSKEY")
pyj "
import json,sys
d=json.loads(sys.argv[1]); i=d.get('info') or {}
print('  top-level keys:', sorted(d.keys()))
print('  info:', {k:i.get(k) for k in ('key_alias','models','max_budget','budget_duration','budget_reset_at','rpm_limit','tpm_limit','max_parallel_requests','spend')})
print('  info.metadata:', i.get('metadata'))
" "$INFO"
check "info.models is the list sent" "$(pyj "
import json,sys; i=json.loads(sys.argv[1]).get('info',{}); sys.exit(0 if i.get('models')==['sovereign-default','sovereign-reasoning'] else 1)" "$INFO"; echo $?)"
check "info.max_budget=5, budget_duration=7d, rpm=300, tpm=1000000" "$(pyj "
import json,sys; i=json.loads(sys.argv[1]).get('info',{}); sys.exit(0 if (i.get('max_budget')==5 and i.get('budget_duration')=='7d' and i.get('rpm_limit')==300 and i.get('tpm_limit')==1000000) else 1)" "$INFO"; echo $?)"
check "info.metadata.allowed_tools round-trips" "$(pyj "
import json,sys; i=json.loads(sys.argv[1]).get('info',{}); sys.exit(0 if (i.get('metadata') or {}).get('allowed_tools')==['list_files','get_file'] else 1)" "$INFO"; echo $?)"

echo "== 4. /key/update — same properties, then budget_duration null (turn the reset off)"
UC=$(adm -o /dev/null -w '%{http_code}' -X POST $B/key/update -d '{"key":"'$SYSKEY'","models":["sovereign-default","sovereign-reasoning","sovereign-embed"],"max_budget":7,"budget_duration":"30d","rpm_limit":200,"tpm_limit":500000,"metadata":{"allowed_tools":["list_files"],"model_max_budget":{}}}')
echo "  HTTP $UC"; check "/key/update 200" "$([ "$UC" = 200 ]; echo $?)"
INFO=$(adm "$B/key/info?key=$SYSKEY")
pyj "import json,sys; i=json.loads(sys.argv[1])['info']; print('  after update:', {k:i.get(k) for k in ('models','max_budget','budget_duration','rpm_limit','tpm_limit')}, (i.get('metadata') or {}).get('allowed_tools'))" "$INFO"
check "update applied (max_budget 7, 30d, rpm 200, 3 models, allowed_tools)" "$(pyj "
import json,sys; i=json.loads(sys.argv[1])['info']; sys.exit(0 if (i.get('max_budget')==7 and i.get('budget_duration')=='30d' and i.get('rpm_limit')==200 and len(i.get('models'))==3 and (i.get('metadata') or {}).get('allowed_tools')==['list_files']) else 1)" "$INFO"; echo $?)"
UC=$(adm -o /dev/null -w '%{http_code}' -X POST $B/key/update -d '{"key":"'$SYSKEY'","models":["sovereign-default","sovereign-reasoning"],"max_budget":5,"budget_duration":null,"rpm_limit":300,"tpm_limit":1000000,"metadata":{"allowed_tools":["list_files"],"model_max_budget":{}}}')
INFO=$(adm "$B/key/info?key=$SYSKEY")
pyj "import json,sys; i=json.loads(sys.argv[1])['info']; print('  after budget_duration:null -> HTTP $UC', {k:i.get(k) for k in ('max_budget','budget_duration','budget_reset_at')})" "$INFO"
check "budget_duration:null accepted (HTTP 200)" "$([ "$UC" = 200 ]; echo $?)"

echo "== 5. chat completion with tools through the scoped key"
C=$(chat $SYSKEY sovereign-default "USER_SECRET_MARKER use the tool" "$TOOLS"); echo "  HTTP $C"
[ "$C" = 200 ] || echo "  body: $(head -c 400 $W/data/last.body)"
check "200 with a tool call" "$([ "$C" = 200 ] && grep -q '"tool_calls"' $W/data/last.body && grep -q 'list_files' $W/data/last.body; echo $?)"
echo "  response headers the OS can read:"; grep -i -E '^(x-litellm-(response-cost|key-spend|key-tpm-limit|key-rpm-limit|attempted-retries|attempted-fallbacks|version|call-id|model-id)|x-ratelimit-[a-z_-]+):' $W/data/last.headers | tr -d '\r' | sed 's/^/    /' | sed -E 's/(x-litellm-(call|model)-id: ).*/\1<id>/'
check "x-litellm-key-spend header present" "$(grep -qi '^x-litellm-key-spend:' $W/data/last.headers; echo $?)"
check "x-ratelimit-*-remaining-tokens header present" "$(grep -qi '^x-ratelimit-.*remaining-tokens:' $W/data/last.headers; echo $?)"
C=$(chat $SYSKEY sovereign-default "use it" '"tools":[{"type":"function","function":{"name":"write_file","description":"d","parameters":{"type":"object","properties":{}}}}]'); echo "  a tool that is NOT in the key's metadata.allowed_tools -> HTTP $C $(head -c 190 $W/data/last.body)"
check "the gateway enforces the key's metadata.allowed_tools (403 tool_access_denied)" "$([ "$C" = 403 ] && grep -q 'tool_access_denied' $W/data/last.body; echo $?)"
C=$(chat $SYSKEY sovereign-vision "hi"); echo "  model outside the key allowlist -> HTTP $C $(head -c 170 $W/data/last.body)"
check "model outside the allowlist is refused (401/403)" "$([ "$C" = 403 ] || [ "$C" = 401 ]; echo $?)"

echo "== 6. tpm limit -> 429 (rate-limit.ts parses the body and retry-after)"
adm -o /dev/null -X POST $B/key/generate -d '{"key":"sk-os-tpm-'$SYS'","key_alias":"os-tpm-'$SYS'","models":["sovereign-default"],"max_budget":5,"budget_duration":"7d","rpm_limit":300,"tpm_limit":1000}'
last=; for i in 1 2 3 4; do last=$(chat sk-os-tpm-$SYS sovereign-default "hello"); [ "$last" = 429 ] && break; done
echo "  HTTP $last after $i call(s)"; echo "  body: $(head -c 600 $W/data/last.body)"
echo "  headers:"; grep -i -E '^(retry-after|rate_limit_type|reset_at|x-ratelimit[a-z_-]*|x-litellm-key-[a-z-]+):' $W/data/last.headers | tr -d '\r' | sed 's/^/    /'
check "429" "$([ "$last" = 429 ]; echo $?)"
check "body contains 'Limit resets at:' in the format rate-limit.ts parses" "$(grep -q -E 'Limit resets at: [0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}' $W/data/last.body; echo $?)"
check "body contains 'Limit type: tokens' and 'Current limit: 1000'" "$(grep -q 'Limit type: tokens' $W/data/last.body && grep -q 'Current limit: 1000' $W/data/last.body; echo $?)"
check "body says rate limit (classifyGatewayLimit) and not budget" "$(grep -qi 'rate limit' $W/data/last.body && ! grep -qi 'budget' $W/data/last.body; echo $?)"
check "retry-after header present" "$(grep -qi '^retry-after:' $W/data/last.headers; echo $?)"

echo "== 7. budget exhaustion (needs priced aliases)"
PRICED=$(adm $B/model/info | pyj "import json,sys; d=json.load(sys.stdin)['data']; print(1 if any((m.get('model_info') or {}).get('input_cost_per_token') for m in d if m.get('model_name')=='sovereign-reasoning') else 0)")
if [ "$PRICED" != 1 ]; then
  echo "  SKIPPED — sovereign-reasoning has no price in this config, so the gateway books cost 0 and no budget can trigger. Re-run with priced aliases (EXTRA_VALUES, see run.sh)."
else
adm -o /dev/null -X POST $B/key/generate -d '{"key":"sk-os-bud-'$SYS'","key_alias":"os-bud-'$SYS'","models":["sovereign-reasoning"],"max_budget":0.001,"budget_duration":"7d","rpm_limit":300,"tpm_limit":1000000}'
C1=$(chat sk-os-bud-$SYS sovereign-reasoning "hello"); echo "  first call HTTP $C1 cost=$(grep -i '^x-litellm-response-cost:' $W/data/last.headers | tr -d '\r' | cut -d' ' -f2)"
C2=$C1; for i in 1 2 3 4 5 6 7 8 9 10 11 12; do wait_s 3; C2=$(chat sk-os-bud-$SYS sovereign-reasoning "hello"); [ "$C2" != 200 ] && break; done
echo "  refused after $i further call(s): HTTP $C2"; echo "  body: $(head -c 500 $W/data/last.body)"
adm "$B/key/info?key=sk-os-bud-$SYS" | pyj "import json,sys; i=json.load(sys.stdin)['info']; print('  key:', {k:i.get(k) for k in ('spend','max_budget','budget_duration','budget_reset_at')})"
check "a spent budget is refused with a 4xx" "$([ "$C2" -ge 400 ] && [ "$C2" -lt 500 ]; echo $?)"
check "the body says 'budget' (BUDGET_WORDING in rate-limit.ts / isBudget in runtime.ts)" "$(grep -qi 'budget' $W/data/last.body; echo $?)"
fi

echo "== 8. response cache on Valkey, opt-in per request (cache: {use-cache: true}); hits counted at the upstream"
upcount() { tr -d '\000' < $W/data/upstream.jsonl | grep -c "$1"; }
n0=$(upcount '"/v1/chat/completions"')
for i in 1 2 3; do CC=$(curl -sS -o /dev/null -D $W/data/c.h -w '%{http_code}' $B/v1/chat/completions -H "Authorization: Bearer $AGENT_KEY" -H 'content-type: application/json' -d '{"model":"sovereign-default","messages":[{"role":"user","content":"cache probe '$SYS'"}],"temperature":0,"cache":{"use-cache":true}}'); done
nc=$(( $(upcount '"/v1/chat/completions"') - n0 )); echo "  3 identical chat calls with use-cache: HTTP $CC, upstream saw $nc; $(grep -i '^x-litellm-cache-key' $W/data/c.h | tr -d '\r' | cut -c1-40)"
check "chat: repeats are served from the cache (1 upstream call for 3)" "$([ "$nc" = 1 ]; echo $?)"
n0=$(upcount '"/v1/chat/completions"')
for i in 1 2; do curl -sS -o /dev/null $B/v1/chat/completions -H "Authorization: Bearer $AGENT_KEY" -H 'content-type: application/json' -d '{"model":"sovereign-default","messages":[{"role":"user","content":"no-cache probe '$SYS'"}],"temperature":0}'; done
nc=$(( $(upcount '"/v1/chat/completions"') - n0 )); echo "  2 identical chat calls WITHOUT the opt-in: upstream saw $nc"
check "chat: nothing is cached without the opt-in (default_off)" "$([ "$nc" = 2 ]; echo $?)"
n0=$(upcount '"/v1/embeddings"')
for i in 1 2 3; do EC=$(curl -sS -o /dev/null -w '%{http_code}' $B/v1/embeddings -H "Authorization: Bearer $AGENT_KEY" -H 'content-type: application/json' -d '{"model":"sovereign-embed","input":["cache me '$SYS'"],"user":"os-test","metadata":{"tags":["tab:files"]},"cache":{"use-cache":true}}'); done
ne=$(( $(upcount '"/v1/embeddings"') - n0 )); echo "  3 identical embedding calls with use-cache: HTTP $EC, upstream saw $ne (1 = cached; reported, not asserted)"
check "embeddings 200" "$([ "$EC" = 200 ]; echo $?)"

echo "== 9. admin reads of core/infra/litellm-admin.ts (status, shape)"
for p in /model/info /model_group/info /team/list /budget/list '/key/list?return_full_object=true&include_team_keys=true' /guardrails/list /global/spend/report '/global/spend/report?start_date=2026-11-01&end_date=2026-11-30' '/global/spend/report?start_date=2026-11-01&end_date=2026-11-30&group_by=api_key' /health/latest /health/services '/health/services?service=langfuse' /tag/daily/activity '/tag/daily/activity?start_date=2026-11-01&end_date=2026-11-30' '/spend/tags?start_date=2026-11-01&end_date=2026-11-30' '/global/spend/tags?start_date=2026-11-01&end_date=2026-11-30' /v1/models /spend/logs /cache/ping; do
  R=$(adm -w '\n%{http_code}' "$B$p"); RC=$(tail -1 <<<"$R")
  printf '  %-62s %s  %s\n' "$p" "$RC" "$(pyj "
import json,sys
t=sys.argv[1].rsplit('\n',1)[0]
try:
    d=json.loads(t)
    if isinstance(d,dict): print('object keys:', sorted(d.keys())[:8], ('| error: '+str((d.get('error') or {}).get('message') or d.get('detail'))[:150]) if ('error' in d or 'detail' in d) else '')
    else: print('array len', len(d), '| row keys:', sorted(d[0].keys())[:8] if d and isinstance(d[0],dict) else '')
except Exception as e: print('not json:', t[:80])
" "$R")"
done

echo "== 10. admin console sign-in the OS performs (tool-sso-litellm.ts: POST /login, form)"
LC=$(curl -sS -D $W/data/login.h -o /dev/null -w '%{http_code}' -X POST $B/login -H 'content-type: application/x-www-form-urlencoded' --data 'username=admin&password=test-ui')
echo "  POST /login -> HTTP $LC; Set-Cookie names: $(grep -i '^set-cookie:' $W/data/login.h | sed -E 's/^[Ss]et-[Cc]ookie: ([^=]+)=.*/\1/' | paste -sd',' -); location: $(grep -i '^location:' $W/data/login.h | tr -d '\r' | cut -d' ' -f2 | cut -c1-60)"
check "login yields a session cookie the OS recognises (token | litellm_session | session_token)" "$(grep -i '^set-cookie:' $W/data/login.h | grep -q -E '^[Ss]et-[Cc]ookie: (token|litellm_session|session_token)='; echo $?)"

echo "== 11. MCP gateway config (mcp_servers.sovereign_query)"
for p in /v1/mcp/server /mcp-rest/tools/list; do R=$(adm -w '\n%{http_code}' "$B$p"); printf '  %-28s %s  %s\n' "$p" "$(tail -1 <<<"$R")" "$(head -c 200 <<<"$R" | tr '\n' ' ')"; done
check "the configured MCP server is registered" "$(adm $B/v1/mcp/server | grep -q 'sovereign_query'; echo $?)"

echo "== 12. what reached the upstream for a call with extra params (drop_params: true)"
XC=$(chat $AGENT_KEY sovereign-reasoning "upstream probe $SYS" '"temperature":0.2,"parallel_tool_calls":false,"reasoning_effort":"low","top_k":5'); echo "  HTTP $XC $([ "$XC" = 200 ] || head -c 300 $W/data/last.body)"
tr -d '\000' < $W/data/upstream.jsonl | grep "upstream probe $SYS" | tail -1 | pyj "import json,sys; b=json.loads(sys.stdin.read())['body']; print('  upstream body keys:', sorted(b.keys())); print('  model sent upstream:', b.get('model')); print('  extra_body passthrough (chat_template_kwargs):', b.get('chat_template_kwargs'))"
if grep -q 'chat_template_kwargs' "$W/config.yaml" 2>/dev/null; then
  check "the deployment's extra_body (chat_template_kwargs.enable_thinking=false) reaches the upstream" "$(tr -d '\000' < $W/data/upstream.jsonl | grep "upstream probe $SYS" | tail -1 | grep -q '"chat_template_kwargs":{"enable_thinking":false}'; echo $?)"
else
  echo "  (this config sets no extra_body on the reasoning route — passthrough not asserted)"
fi
XC=$(chat $AGENT_KEY sovereign-default "upstream probe2 $SYS"); tr -d '\000' < $W/data/upstream.jsonl | grep "upstream probe2 $SYS" | tail -1 | pyj "import json,sys; b=json.loads(sys.stdin.read())['body']; print('  standard alias -> model sent upstream:', b.get('model'))"

echo "################ $LABEL: $pass passed, $fail failed"
[ "$fail" = 0 ]
