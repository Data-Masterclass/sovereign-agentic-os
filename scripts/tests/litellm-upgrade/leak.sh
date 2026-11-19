#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# Which kinds of call put prompt content into the gateway's Langfuse record?  bash leak.sh <label>
source "$(dirname "$0")/lib.sh"
T=$(date +%s)
TOOLS='"tools":[{"type":"function","function":{"name":"list_files","description":"TOOLDESC_MARKER list","parameters":{"type":"object","properties":{"note":{"type":"string"}}}}}],"tool_choice":"auto"'
adm -o /dev/null -X POST $B/key/generate -d '{"key":"sk-os-lk-'$T'-0123456789","key_alias":"os-lk-'$T'","models":["sovereign-default"],"max_budget":5,"tpm_limit":1000}'
adm -o /dev/null -X POST $B/key/generate -d '{"key":"sk-os-lb-'$T'-0123456789","key_alias":"os-lb-'$T'","models":["sovereign-default"],"max_budget":0.0001}'
run() { # $1 case name; rest = chat args
  local name=$1; shift
  local before; before=$(wc -l < $W/data/langfuse.jsonl)
  local code; code=$("$@")
  for i in 1 2 3 4 5 6 7 8 9 10; do python3 -c "import time; time.sleep(1.5)"; [ "$(wc -l < $W/data/langfuse.jsonl)" -gt "$before" ] && break; done
  python3 -c "import time; time.sleep(2)"
  tail -n +$((before+1)) $W/data/langfuse.jsonl > $W/data/case.jsonl
  python3 - "$name" "$code" $W/data/case.jsonl <<'PY'
import json,sys
name,code,f=sys.argv[1:4]
rows=[json.loads(l) for l in open(f) if l.strip()]
rows=[r for r in rows if r['method']=='POST']
blob='\n'.join(json.dumps(r['body']) if not isinstance(r['body'],str) else r['body'] for r in rows)
m={k:(k+'_SECRET_MARKER' in blob) for k in ('SYSTEM','USER','COMPLETION','TOOLARG')}
print(f"  {name:<44} HTTP {code}  sink posts: {len(rows)}  " + '  '.join(f"{k.lower()}={'LEAKED' if v else 'absent'}" for k,v in m.items()))
PY
}
echo "################ prompt content in the gateway's Langfuse record — ${1:-run}"
run "success, plain"                         chat $AGENT_KEY sovereign-default "USER_SECRET_MARKER hello $T"
CHAT_META='"mask_output":true' run "success, tool call (+ mask_output)"   chat $AGENT_KEY sovereign-default "USER_SECRET_MARKER tool $T" "$TOOLS"
run "success, tool call (no mask_output)"   chat $AGENT_KEY sovereign-default "USER_SECRET_MARKER tool2 $T" "$TOOLS"
run "upstream error (500)"                   chat $AGENT_KEY sovereign-vision "USER_SECRET_MARKER FORCE_500 $T"
chat sk-os-lk-$T-0123456789 sovereign-default "warm up" >/dev/null
run "refused: rate limit (429)"              chat sk-os-lk-$T-0123456789 sovereign-default "USER_SECRET_MARKER limited $T"
run "refused: model not on the key"          chat sk-os-lk-$T-0123456789 sovereign-reasoning "USER_SECRET_MARKER denied $T"
chat sk-os-lb-$T-0123456789 sovereign-default "spend it" >/dev/null; python3 -c "import time; time.sleep(4)"
run "refused: budget spent"                  chat sk-os-lb-$T-0123456789 sovereign-default "USER_SECRET_MARKER broke $T"
